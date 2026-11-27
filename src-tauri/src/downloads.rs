//! Downloads kept on disk (`downloads.json`): they run in the background,
//! survive restarts, and are playable before they finish.
//!
//! A download is one file of a torrent, keyed `infoHash:fileIdx`. The Electron
//! build keyed them by torrent alone, so downloading a second episode from a
//! season pack replaced the first — and stopped it mid-way.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{bail, Context};
use parking_lot::Mutex;

use crate::torrent::{self, Want, ENGINE};
use crate::types::{DownloadInfo, DownloadProgress, DownloadRecord, PlaybackSource, Stream};
use crate::{server, settings, store, util};

const FILE: &str = "downloads.json";

static RECORDS: OnceLock<Mutex<HashMap<String, DownloadRecord>>> = OnceLock::new();

fn id_of(hash: &str, idx: usize) -> String {
    format!("{}:{idx}", hash.to_lowercase())
}

fn records() -> &'static Mutex<HashMap<String, DownloadRecord>> {
    RECORDS.get_or_init(|| {
        let raw: HashMap<String, DownloadRecord> = store::read_json(FILE).unwrap_or_default();
        let mut migrated = false;
        // Older files were keyed by info hash alone.
        let map = raw
            .into_values()
            .map(|mut r| {
                r.info_hash = r.info_hash.to_lowercase();
                let id = id_of(&r.info_hash, r.file_idx);
                if r.id != id {
                    r.id = id.clone();
                    migrated = true;
                }
                r.local_poster = None;
                (id, r)
            })
            .collect::<HashMap<_, _>>();
        if migrated {
            store::save(FILE, &map, true);
        }
        Mutex::new(map)
    })
}

fn persist(map: &HashMap<String, DownloadRecord>) {
    store::save(FILE, map, true);
}

fn update(id: &str, f: impl FnOnce(&mut DownloadRecord)) {
    let mut map = records().lock();
    if let Some(r) = map.get_mut(id) {
        f(r);
        persist(&map);
    }
}

fn get(id: &str) -> Option<DownloadRecord> {
    records().lock().get(id).cloned()
}

/// Accepts a download's id, or — from an older window — its bare info hash.
fn resolve_id(id: &str) -> Option<String> {
    let id = id.to_lowercase();
    let map = records().lock();
    if map.contains_key(&id) {
        return Some(id);
    }
    map.values().find(|r| r.info_hash == id).map(|r| r.id.clone())
}

fn want_of(r: &DownloadRecord) -> Want {
    Want { hash: r.info_hash.clone(), sources: r.sources.clone().unwrap_or_default(), name: Some(r.file_name.clone()) }
}

pub async fn start(stream: Stream, info: DownloadInfo) -> anyhow::Result<DownloadRecord> {
    let want = Want::from_stream(&stream).context("This source has no torrent to download.")?;
    if let Some(idx) = stream.file_index() {
        if let Some(r) = get(&id_of(&want.hash, idx)) {
            if r.status == "done" && Path::new(&r.file_path).exists() {
                return Ok(r);
            }
        }
    }
    let (t, idx) = ENGINE.ensure_download(&want, stream.file_index(), stream.filename_hint()).await?;
    torrent::save_torrent(&t);
    let id = id_of(&want.hash, idx);
    let file = &t.files[idx];
    let existing = get(&id);
    let record = DownloadRecord {
        id: id.clone(),
        info_hash: want.hash.clone(),
        file_idx: idx,
        magnet: want.magnet(),
        title: info.title,
        meta_id: info.meta_id,
        meta_type: info.meta_type,
        poster: info.poster,
        season: info.season,
        episode: info.episode,
        video_id: info.video_id,
        file_name: file.name.clone(),
        file_path: t.path_of(idx).unwrap_or_default().to_string_lossy().into_owned(),
        length: file.len,
        added_at: existing.as_ref().map(|r| r.added_at).unwrap_or_else(util::now_ms),
        status: "downloading".into(),
        error: None,
        poster_file: existing.and_then(|r| r.poster_file),
        local_poster: None,
        sources: stream.sources.clone(),
    };
    {
        let mut map = records().lock();
        map.insert(id.clone(), record.clone());
        persist(&map);
    }
    tauri::async_runtime::spawn(cache_poster(id));
    Ok(record)
}

/// Keeps a copy of the poster with the app's data, so the download looks right offline.
async fn cache_poster(id: String) {
    static JOBS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let jobs = JOBS.get_or_init(Default::default);
    let Some(r) = get(&id) else { return };
    let Some(url) = r.poster.clone().filter(|p| p.starts_with("http")) else { return };
    if r.poster_file.as_ref().is_some_and(|p| Path::new(p).exists()) || !jobs.lock().insert(id.clone()) {
        return;
    }
    let file = settings::posters_dir().join(format!("{}.img", id.replace(':', "_")));
    let result = async {
        let res = util::http().get(&url).timeout(Duration::from_secs(15)).send().await?;
        if !res.status().is_success() {
            bail!("{}", res.status());
        }
        let bytes = res.bytes().await?;
        tokio::fs::create_dir_all(settings::posters_dir()).await?;
        tokio::fs::write(&file, &bytes).await?;
        Ok(())
    }
    .await;
    if result.is_ok() {
        update(&id, |r| r.poster_file = Some(file.to_string_lossy().into_owned()));
    }
    jobs.lock().remove(&id);
}

pub async fn list() -> Vec<DownloadRecord> {
    let mut list: Vec<DownloadRecord> = records().lock().values().cloned().collect();
    list.sort_by_key(|r| std::cmp::Reverse(r.added_at));
    for r in &mut list {
        match r.poster_file.as_deref().filter(|p| Path::new(p).exists()) {
            Some(p) => r.local_poster = Some(server::local_url(Path::new(p)).await),
            None => {
                tauri::async_runtime::spawn(cache_poster(r.id.clone()));
            }
        }
    }
    list
}

/// Finished downloads, for the title pages: a downloaded film or episode is one more source.
pub fn finished() -> Vec<DownloadRecord> {
    records()
        .lock()
        .values()
        .filter(|r| r.status == "done" && Path::new(&r.file_path).exists())
        .cloned()
        .collect()
}

pub fn progress() -> Vec<DownloadProgress> {
    let list: Vec<DownloadRecord> = records().lock().values().filter(|r| r.status != "done").cloned().collect();
    list.into_iter()
        .filter_map(|r| {
            let (done, len, speed, peers, left) = ENGINE.file_progress(&r.info_hash, r.file_idx)?;
            Some(DownloadProgress {
                id: r.id,
                info_hash: r.info_hash,
                progress: if len > 0 { done as f64 / len as f64 } else { 0.0 },
                downloaded: done,
                download_speed: speed,
                peers,
                time_remaining: left * 1000.0,
            })
        })
        .collect()
}

pub async fn pause(id: &str) -> anyhow::Result<()> {
    let id = resolve_id(id).context("That download is no longer in your library.")?;
    let Some(r) = get(&id) else { return Ok(()) };
    ENGINE.deselect(&r.info_hash, r.file_idx).await;
    update(&id, |r| r.status = "paused".into());
    Ok(())
}

pub async fn resume(id: &str) -> anyhow::Result<()> {
    let id = resolve_id(id).context("That download is no longer in your library.")?;
    let Some(r) = get(&id) else { return Ok(()) };
    if r.status == "done" && Path::new(&r.file_path).exists() {
        return Ok(());
    }
    if util::is_offline() && torrent::saved_torrent(&r.info_hash).is_none() {
        bail!("This download was started by an older version, so it needs a connection to carry on.");
    }
    update(&id, |r| {
        r.status = "downloading".into();
        r.error = None;
    });
    match ENGINE.ensure_download(&want_of(&r), Some(r.file_idx), Some(&r.file_name)).await {
        Ok((t, _)) => {
            torrent::save_torrent(&t);
            Ok(())
        }
        Err(err) => {
            update(&id, |r| {
                r.status = "error".into();
                r.error = Some(err.to_string());
            });
            Err(err)
        }
    }
}

/// Every file of a torrent on disk, while it is still loaded.
fn torrent_files(hash: &str) -> Vec<PathBuf> {
    ENGINE
        .get(hash)
        .map(|t| (0..t.files.len()).filter_map(|i| t.path_of(i)).collect())
        .unwrap_or_default()
}

/// The torrent engine creates every file a torrent lists, even ones nobody
/// asked for: a season pack leaves an empty file per episode not downloaded.
/// Those go — and with `everything`, the torrent's other leftovers too. Only
/// files the torrent itself lists are touched, never anything else.
fn tidy_side_files(files: &[PathBuf], keep: &HashSet<PathBuf>, everything: bool) {
    let root = settings::get().downloads_dir();
    for path in files {
        if keep.contains(path) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(path) else { continue };
        if meta.is_file() && (meta.len() == 0 || everything) && std::fs::remove_file(path).is_ok() {
            util::prune_empty_dirs(&root, path);
        }
    }
}

fn kept_paths(hash: &str, except: Option<&str>) -> HashSet<PathBuf> {
    records()
        .lock()
        .values()
        .filter(|x| x.info_hash == hash && Some(x.id.as_str()) != except)
        .map(|x| PathBuf::from(&x.file_path))
        .collect()
}

pub async fn remove(id: &str, delete_files: bool) -> anyhow::Result<()> {
    let Some(id) = resolve_id(id) else { return Ok(()) };
    let Some(r) = get(&id) else { return Ok(()) };
    let siblings = torrent_files(&r.info_hash);
    ENGINE.deselect(&r.info_hash, r.file_idx).await;
    if delete_files {
        let path = PathBuf::from(&r.file_path);
        if let Err(err) = std::fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("could not delete {}: {err}", path.display());
            }
        }
        util::prune_empty_dirs(&settings::get().downloads_dir(), &path);
        let keep = kept_paths(&r.info_hash, Some(&id));
        tidy_side_files(&siblings, &keep, keep.is_empty());
    }
    if let Some(p) = &r.poster_file {
        let _ = std::fs::remove_file(p);
    }
    let mut map = records().lock();
    map.remove(&id);
    if !map.values().any(|x| x.info_hash == r.info_hash) {
        torrent::forget_torrent_file(&r.info_hash);
    }
    persist(&map);
    Ok(())
}

fn file_complete(r: &DownloadRecord) -> bool {
    ENGINE
        .file_progress(&r.info_hash, r.file_idx)
        .is_some_and(|(done, len, ..)| len > 0 && done >= len)
}

/// Off disk whenever the file is all there, so nothing about playing a
/// download needs a connection. Only one still coming in plays from the torrent.
pub async fn play_source(id: &str) -> anyhow::Result<PlaybackSource> {
    let id = resolve_id(id).context("That download is no longer in your library.")?;
    let r = get(&id).context("That download is no longer in your library.")?;
    let local = PlaybackSource::Local { file_path: r.file_path.clone() };
    let on_disk = Path::new(&r.file_path).exists();
    if r.status == "done" && on_disk {
        return Ok(local);
    }
    if util::is_offline() && torrent::saved_torrent(&r.info_hash).is_none() {
        if on_disk {
            return Ok(local);
        }
        bail!("This download has not saved anything yet, so it needs a connection.");
    }
    if ENGINE.get(&r.info_hash).is_none() {
        resume(&id).await?;
    }
    if file_complete(&r) {
        update(&id, |r| r.status = "done".into());
        return Ok(local);
    }
    Ok(PlaybackSource::Torrent { info_hash: r.info_hash, file_idx: r.file_idx })
}

pub fn file_path_for(id: &str) -> Option<String> {
    get(&resolve_id(id)?).map(|r| r.file_path)
}

/// Re-attaches unfinished downloads after a restart, then watches them finish.
pub async fn resume_all() {
    let pending: Vec<DownloadRecord> =
        records().lock().values().filter(|r| r.status == "downloading").cloned().collect();
    for r in pending {
        if let Err(err) = resume(&r.id).await {
            tracing::warn!("could not resume {}: {err}", r.title);
            update(&r.id, |r| r.status = "paused".into());
        }
    }
}

/// How long a download may sit with no peers and no progress before it
/// switches to the torrent's web seed, when it has one.
const STALL_LIMIT: Duration = Duration::from_secs(45);

/// Flips downloads to `done` as they land, records torrent errors, and moves
/// stalled ones onto their web seed.
pub async fn monitor() {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    // id -> (bytes last seen, when they last changed)
    let mut seen: HashMap<String, (u64, std::time::Instant)> = HashMap::new();
    loop {
        tick.tick().await;
        let active: Vec<DownloadRecord> =
            records().lock().values().filter(|r| r.status == "downloading").cloned().collect();
        seen.retain(|id, _| active.iter().any(|r| &r.id == id));
        for r in active {
            if let Some((done, _, _, peers, _)) = ENGINE.file_progress(&r.info_hash, r.file_idx) {
                let entry = seen.entry(r.id.clone()).or_insert((done, std::time::Instant::now()));
                if done != entry.0 {
                    *entry = (done, std::time::Instant::now());
                } else if peers == 0 && entry.1.elapsed() > STALL_LIMIT && ENGINE.fallback_to_web(&r.info_hash).await {
                    seen.remove(&r.id);
                    continue;
                }
            }
            if file_complete(&r) {
                tracing::info!("download finished: {}", r.file_name);
                // The torrent keeps running (and seeding, within the upload limit)
                // until exit: a player may still be reading it through the stream URL.
                update(&r.id, |r| r.status = "done".into());
                tidy_side_files(&torrent_files(&r.info_hash), &kept_paths(&r.info_hash, None), false);
            } else if let Some(err) = ENGINE.file_error(&r.info_hash, r.file_idx) {
                if ENGINE.get(&r.info_hash).is_some_and(|t| !t.is_web()) {
                    update(&r.id, |r| {
                        r.status = "error".into();
                        r.error = Some(err);
                    });
                }
            }
        }
    }
}
