//! The library (`library.json`): watchlist, watch progress, ratings and the
//! source last played per title. The rules match src/shared/library.ts, which
//! the web build runs over localStorage, so both behave the same.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::{store, util};

const FILE: &str = "library.json";
/// "Last played" is a convenience; it should not grow forever.
const MAX_LAST_STREAMS: usize = 3000;

/// Timestamps are integers, but a hand-edited or imported file may carry floats.
fn lenient_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).unwrap_or(0))
}

fn lenient_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    #[serde(default)]
    pub key: String,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt_i64")]
    pub added_at: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEntry {
    pub key: String,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt_i64")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt_i64")]
    pub episode: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(default)]
    pub time: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ProgressEntry {
    pub fn is_finished(&self) -> bool {
        self.finished.unwrap_or(false)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RatingEntry {
    pub key: String,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(default)]
    pub rating: f64,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub rated_at: i64,
    #[serde(default)]
    pub source: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastStream {
    pub stream: Value,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub played_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFile {
    pub items: HashMap<String, LibraryItem>,
    pub progress: HashMap<String, ProgressEntry>,
    pub ratings: HashMap<String, RatingEntry>,
    pub last_streams: HashMap<String, LastStream>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LibraryList {
    pub items: Vec<LibraryItem>,
    pub progress: Vec<ProgressEntry>,
    pub ratings: Vec<RatingEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackup {
    pub app: String,
    pub version: u32,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub exported_at: i64,
    #[serde(default)]
    pub items: Vec<LibraryItem>,
    #[serde(default)]
    pub progress: Vec<ProgressEntry>,
    #[serde(default)]
    pub ratings: Vec<RatingEntry>,
}

/// A season or show marked at once. `seed` describes an episode never opened.
#[derive(Deserialize, Clone, Debug)]
pub struct WatchChange {
    pub key: String,
    pub watched: bool,
    pub seed: Option<ProgressEntry>,
}

pub struct ImportBatch {
    pub items: Vec<LibraryItem>,
    pub progress: Vec<ProgressEntry>,
    pub ratings: Vec<RatingEntry>,
}

static LIBRARY: OnceLock<Mutex<LibraryFile>> = OnceLock::new();

fn cell() -> &'static Mutex<LibraryFile> {
    LIBRARY.get_or_init(|| Mutex::new(store::read_json(FILE).unwrap_or_default()))
}

/// Runs a change against the library and writes it out.
fn change<R>(f: impl FnOnce(&mut LibraryFile) -> R) -> R {
    let mut lib = cell().lock();
    let out = f(&mut lib);
    store::save(FILE, &*lib, false);
    out
}

pub fn list() -> LibraryList {
    let lib = cell().lock();
    list_of(&lib)
}

fn list_of(lib: &LibraryFile) -> LibraryList {
    let mut items: Vec<_> = lib.items.values().cloned().collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.added_at.unwrap_or(0)));
    let mut progress: Vec<_> = lib.progress.values().cloned().collect();
    progress.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    let mut ratings: Vec<_> = lib.ratings.values().cloned().collect();
    ratings.sort_by_key(|r| std::cmp::Reverse(r.rated_at));
    LibraryList { items, progress, ratings }
}

/// Imported history never overrides what the user already has: an existing
/// finished entry is left alone, an unfinished one keeps its resume position
/// while being marked watched, and an existing rating stays.
pub fn merge_import(batch: ImportBatch) {
    change(|lib| {
        for item in batch.items {
            lib.items.entry(item.key.clone()).or_insert(item);
        }
        for entry in batch.progress {
            match lib.progress.get_mut(&entry.key) {
                Some(existing) => {
                    if !existing.is_finished() {
                        existing.finished = Some(true);
                    }
                }
                None => {
                    lib.progress.insert(entry.key.clone(), entry);
                }
            }
        }
        for rating in batch.ratings {
            lib.ratings.entry(rating.key.clone()).or_insert(rating);
        }
    })
}

/// Restoring a backup: whichever side touched an entry last keeps it.
pub fn merge_backup(backup: LibraryBackup) -> anyhow::Result<usize> {
    if backup.app != "streamline" {
        anyhow::bail!("That file is not a Streamline backup.");
    }
    Ok(change(|lib| {
        let mut changed = 0;
        for item in backup.items {
            if !lib.items.contains_key(&item.key) {
                lib.items.insert(item.key.clone(), item);
                changed += 1;
            }
        }
        for entry in backup.progress {
            let newer = lib.progress.get(&entry.key).is_none_or(|e| e.updated_at < entry.updated_at);
            if newer {
                lib.progress.insert(entry.key.clone(), entry);
                changed += 1;
            }
        }
        for rating in backup.ratings {
            let newer = lib.ratings.get(&rating.key).is_none_or(|e| e.rated_at < rating.rated_at);
            if newer {
                lib.ratings.insert(rating.key.clone(), rating);
                changed += 1;
            }
        }
        changed
    }))
}

pub fn make_backup() -> LibraryBackup {
    let l = list();
    LibraryBackup {
        app: "streamline".into(),
        version: 1,
        exported_at: util::now_ms(),
        items: l.items,
        progress: l.progress,
        ratings: l.ratings,
    }
}

pub fn toggle_favorite(mut item: LibraryItem) -> bool {
    change(|lib| {
        let key = format!("{}:{}", item.kind, item.id);
        if lib.items.remove(&key).is_some() {
            return false;
        }
        item.key = key.clone();
        item.favorite = Some(true);
        item.added_at = Some(util::now_ms());
        lib.items.insert(key, item);
        true
    })
}

pub fn set_progress(mut entry: ProgressEntry) {
    // Past 95% counts as watched. The entry stays so it shows up as history.
    entry.finished = Some(entry.duration > 0.0 && entry.time / entry.duration > 0.95);
    entry.updated_at = util::now_ms();
    change(|lib| {
        lib.progress.insert(entry.key.clone(), entry);
    })
}

fn mark_one(lib: &mut LibraryFile, key: &str, watched: bool, seed: Option<ProgressEntry>) {
    if let Some(entry) = lib.progress.get_mut(key) {
        entry.finished = Some(watched);
        entry.updated_at = util::now_ms();
        return;
    }
    if let (true, Some(mut seed)) = (watched, seed) {
        seed.key = key.to_string();
        seed.time = 0.0;
        seed.duration = 0.0;
        seed.updated_at = util::now_ms();
        seed.finished = Some(true);
        lib.progress.insert(key.to_string(), seed);
    }
}

pub fn mark_watched(key: &str, watched: bool, seed: Option<ProgressEntry>) {
    change(|lib| mark_one(lib, key, watched, seed))
}

pub fn mark_many_watched(changes: Vec<WatchChange>) {
    change(|lib| {
        for c in changes {
            mark_one(lib, &c.key, c.watched, c.seed);
        }
    })
}

pub fn clear_progress(key: &str) {
    change(|lib| {
        lib.progress.remove(key);
    })
}

/// `None` clears the rating.
pub fn set_rating(mut entry: RatingEntry, rating: Option<f64>) {
    change(|lib| match rating {
        None => {
            lib.ratings.remove(&entry.key);
        }
        Some(r) => {
            entry.rating = r.round().clamp(1.0, 10.0);
            entry.rated_at = util::now_ms();
            entry.source = "streamline".into();
            lib.ratings.insert(entry.key.clone(), entry);
        }
    })
}

pub fn get_last_stream(key: &str) -> Option<Value> {
    cell().lock().last_streams.get(key).map(|l| l.stream.clone())
}

pub fn set_last_stream(key: &str, stream: Value) {
    change(|lib| {
        lib.last_streams.insert(key.to_string(), LastStream { stream, played_at: util::now_ms() });
        if lib.last_streams.len() > MAX_LAST_STREAMS {
            let mut by_age: Vec<(String, i64)> =
                lib.last_streams.iter().map(|(k, v)| (k.clone(), v.played_at)).collect();
            by_age.sort_by_key(|(_, at)| *at);
            for (k, _) in by_age.into_iter().take(lib.last_streams.len() - MAX_LAST_STREAMS) {
                lib.last_streams.remove(&k);
            }
        }
    })
}
