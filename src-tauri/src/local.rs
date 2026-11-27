//! The local library: films and episodes already on this computer, from the
//! folders picked in Settings. Files are matched to Cinemeta by name, so they
//! sit on the same title pages as everything else — one more source there,
//! and the one that starts instantly.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::{downloads, server, settings, store, util};

const CINEMETA: &str = "https://v3-cinemeta.strem.io";
const INDEX_FILE: &str = "local-library.json";
/// Below this a "video" is a sample, a trailer or an extra.
const MIN_SIZE: u64 = 20 * 1024 * 1024;
const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 5000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Match {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    size: u64,
    mtime_ms: f64,
    parsed: Parsed,
    /// None when Cinemeta had nothing that fit; the file still plays under its own name.
    #[serde(rename = "match")]
    matched: Option<Match>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    scanned_at: i64,
    entries: Vec<Entry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    scanning: bool,
    scanned_at: i64,
    files: usize,
    movies: usize,
    episodes: usize,
    unmatched: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------------------------------------------------------------- naming

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(JUNK, r"(?i)\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|blu-?ray|bdrip|brrip|web-?dl|web-?rip|web|hdtv|dvdrip|dvd|x26[45]|h ?26[45]|hevc|avc|aac\d?|ac3|e?ac3|ddp?\d?|dts|truehd|atmos|remux|proper|repack|extended|unrated|imax|10bit|multi|subbed|dubbed)\b");
re!(OPEN_TAIL, r"[(\[{][^)\]}]*$");
re!(TRAIL, r"[-–(\s]+$");
re!(LEAD, r"^[-–\s]+");
re!(SPACES, r"\s+");
re!(SEP, r"[._]+");
re!(BRACKETS, r"\[([^\]]*)\]");
re!(BARE_YEAR, r"^(19|20)\d\d$");
re!(SXXEXX, r"(?i)\bS(\d{1,2}) ?E(\d{1,3})\b");
re!(NXNN, r"\b(\d{1,2})x(\d{2,3})\b");
re!(TRACK_NO, r"^\d{1,3}\s*[-–.]\s+");
re!(YEAR, r"\b((?:19|20)\d\d)\b");
re!(YEAR_PAREN, r"\(?\b(19|20)\d\d\b\)?");
re!(YEAR_TAIL, r"\b(19|20)\d\d\b.*$");
re!(SEASON_DIR, r"(?i)^(season|series|staffel|saison|s)\s*\d+$");
re!(SPECIALS_DIR, r"(?i)^specials?$");
re!(SAMPLE, r"(?i)\bsample\b");
re!(NON_ALNUM, r"[^a-z0-9]+");
re!(DIGITS4, r"\d{4}");

fn tidy(s: &str) -> String {
    let s = OPEN_TAIL.replace(s, "");
    let s = TRAIL.replace(&s, "");
    let s = LEAD.replace(&s, "");
    SPACES.replace_all(&s, " ").trim().to_string()
}

fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// "Show Name/Season 2/Show.Name.S02E05.mkv": the show is named by a folder, not "Season 2".
fn show_from_folders(file: &Path) -> String {
    let mut dir = file.parent();
    for _ in 0..2 {
        let Some(d) = dir else { break };
        let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !SEASON_DIR.is_match(&name) && !SPECIALS_DIR.is_match(&name) {
            let spaced = SEP.replace_all(&name, " ");
            return tidy(&YEAR_TAIL.replace(&spaced, ""));
        }
        dir = d.parent();
    }
    String::new()
}

/// Pulls a title, year and episode numbers out of a release-style file name.
pub fn parse_name(file: &Path) -> Parsed {
    let raw = stem(file);
    // Bracketed tags go — "[YTS]", "[1080p]" — but a bracketed year is kept.
    let unbracketed = BRACKETS.replace_all(&raw, |c: &regex::Captures| {
        if BARE_YEAR.is_match(&c[1]) { c[0].to_string() } else { " ".to_string() }
    });
    let base = SEP.replace_all(&unbracketed, " ");
    let base = SPACES.replace_all(&base, " ").trim().to_string();

    if let Some(ep) = SXXEXX.captures(&base).or_else(|| NXNN.captures(&base)) {
        let whole = ep.get(0).unwrap();
        // "04 - The Office 1x04": a leading track number is not part of the show's name.
        let before = TRACK_NO.replace(&base[..whole.start()], "").to_string();
        let year = YEAR.captures(&before).and_then(|c| c[1].parse().ok());
        let mut title = tidy(&YEAR_PAREN.replace(&before, ""));
        if title.is_empty() {
            title = show_from_folders(file);
        }
        return Parsed {
            title,
            year,
            season: ep[1].parse().ok(),
            episode: ep[2].parse().ok(),
        };
    }

    // The last year that is not the very start of the name: "2001 A Space Odyssey 1968".
    if let Some(m) = YEAR.find_iter(&base).filter(|m| m.start() > 0).last() {
        return Parsed { title: tidy(&base[..m.start()]), year: m.as_str().parse().ok(), ..Default::default() };
    }

    let cut = JUNK.find(&base).map(|m| m.start()).unwrap_or(base.len());
    let mut title = tidy(&base[..cut]);
    if title.is_empty() {
        let folder = file.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        title = tidy(&SEP.replace_all(&folder, " "));
    }
    Parsed { title, ..Default::default() }
}

pub fn norm(s: &str) -> String {
    let lowered: String = s
        .to_lowercase()
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    let lowered = lowered.replace('&', " and ");
    NON_ALNUM.replace_all(&lowered, " ").trim().to_string()
}

fn year_of(release: Option<&str>) -> i64 {
    release.and_then(|r| DIGITS4.find(r)).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
}

/// Shared words over all words: "holiday video" is not "Greatest Holiday Videos Countdown".
fn overlap(a: &str, b: &str) -> f64 {
    let wa: HashSet<&str> = a.split(' ').collect();
    let wb: HashSet<&str> = b.split(' ').collect();
    let shared = wa.intersection(&wb).count() as f64;
    shared / wa.union(&wb).count().max(1) as f64
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Preview {
    id: String,
    #[serde(default)]
    name: String,
    poster: Option<String>,
    release_info: Option<String>,
}

/// Cinemeta's search is fuzzy — asked for "Sintel" it leads with Interstellar —
/// so its answer is kept only when the name, and the year if known, back it up.
fn pick(metas: &[Preview], parsed: &Parsed) -> Option<Preview> {
    let wanted = norm(&parsed.title);
    let mut best: Option<(Preview, i64)> = None;
    for (i, meta) in metas.iter().take(10).enumerate() {
        let name = norm(&meta.name);
        let mut score = -(i as i64);
        if name == wanted {
            score += 20;
        } else if overlap(&name, &wanted) >= 0.6 {
            score += 6;
        } else {
            score -= 30;
        }
        if let Some(year) = parsed.year {
            let y = year_of(meta.release_info.as_deref());
            if y == year {
                score += 15;
            } else if y != 0 && (y - year).abs() == 1 {
                score += 8;
            } else if y != 0 {
                score -= 12;
            }
        }
        if best.as_ref().is_none_or(|(_, s)| score > *s) {
            best = Some((meta.clone(), score));
        }
    }
    best.filter(|(_, s)| *s >= 0).map(|(m, _)| m)
}

async fn lookup(parsed: Parsed) -> Option<Match> {
    if parsed.title.is_empty() {
        return None;
    }
    let kind = if parsed.season.is_some() { "series" } else { "movie" };
    let url = format!(
        "{CINEMETA}/catalog/{kind}/top/search={}.json",
        percent_encoding::utf8_percent_encode(&parsed.title, percent_encoding::NON_ALPHANUMERIC)
    );
    #[derive(Deserialize)]
    struct Res {
        #[serde(default)]
        metas: Vec<Preview>,
    }
    let res: Res = util::get_json(&url, Duration::from_secs(15)).await.ok().flatten()?;
    let meta = pick(&res.metas, &parsed)?;
    if !meta.id.starts_with("tt") {
        return None;
    }
    Some(Match { id: meta.id, kind: kind.into(), name: meta.name, poster: meta.poster, year: meta.release_info })
}

// ----------------------------------------------------------------- index

static INDEX: OnceLock<Mutex<IndexFile>> = OnceLock::new();
static SCANNING: AtomicBool = AtomicBool::new(false);
static SCAN_GEN: AtomicU64 = AtomicU64::new(0);
static SCAN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn index() -> &'static Mutex<IndexFile> {
    INDEX.get_or_init(|| Mutex::new(store::read_json(INDEX_FILE).unwrap_or_default()))
}

struct Found {
    path: PathBuf,
    size: u64,
    mtime_ms: f64,
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<Found>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('$') || name == "System Volume Information" {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(&e.path(), depth + 1, out);
        } else if ft.is_file() && util::is_video(&name) && !SAMPLE.is_match(&name) {
            if let Ok(meta) = e.metadata() {
                if meta.len() >= MIN_SIZE {
                    let mtime_ms = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0)
                        .floor();
                    out.push(Found { path: e.path(), size: meta.len(), mtime_ms });
                }
            }
        }
    }
}

fn lookup_key(p: &Parsed) -> String {
    format!("{}|{}|{}", if p.season.is_some() { "series" } else { "movie" }, norm(&p.title), p.year.map(|y| y.to_string()).unwrap_or_default())
}

async fn scan() -> anyhow::Result<()> {
    let folders = settings::get().local_folders;
    let found = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for f in folders {
            walk(Path::new(&f), 0, &mut out);
        }
        out
    })
    .await?;

    // Unchanged files keep their match; only new or changed ones are looked up.
    let known: HashMap<String, Entry> =
        index().lock().entries.iter().map(|e| (e.path.clone(), e.clone())).collect();
    let mut entries = Vec::with_capacity(found.len());
    let mut todo: Vec<usize> = Vec::new();
    for f in found {
        let key = f.path.to_string_lossy().into_owned();
        match known.get(&key) {
            Some(old) if old.size == f.size && (old.mtime_ms - f.mtime_ms).abs() < 1.0 => entries.push(old.clone()),
            _ => {
                todo.push(entries.len());
                entries.push(Entry { parsed: parse_name(&f.path), path: key, size: f.size, mtime_ms: f.mtime_ms, matched: None });
            }
        }
    }

    // Every episode of a show asks the same question; ask it once, four at a time.
    let mut unique: HashMap<String, Parsed> = HashMap::new();
    for &i in &todo {
        unique.entry(lookup_key(&entries[i].parsed)).or_insert_with(|| entries[i].parsed.clone());
    }
    let answers: HashMap<String, Option<Match>> = futures::stream::iter(unique)
        .map(|(key, parsed)| async move { (key, lookup(parsed).await) })
        .buffer_unordered(4)
        .collect()
        .await;
    for &i in &todo {
        entries[i].matched = answers.get(&lookup_key(&entries[i].parsed)).cloned().flatten();
    }

    let next = IndexFile { scanned_at: util::now_ms(), entries };
    store::save(INDEX_FILE, &next, false);
    *index().lock() = next;
    Ok(())
}

/// Rescans the library folders. Calls that arrive during a scan share it.
pub async fn rescan() -> LocalStatus {
    let generation = SCAN_GEN.load(Ordering::SeqCst);
    let _guard = SCAN_LOCK.lock().await;
    if SCAN_GEN.load(Ordering::SeqCst) == generation {
        SCANNING.store(true, Ordering::SeqCst);
        *LAST_ERROR.lock() = None;
        if let Err(err) = scan().await {
            tracing::warn!("local library scan failed: {err}");
            *LAST_ERROR.lock() = Some(err.to_string());
        }
        SCAN_GEN.fetch_add(1, Ordering::SeqCst);
        SCANNING.store(false, Ordering::SeqCst);
    }
    status()
}

/// What is in the index now, limited to folders that are still in Settings.
fn entries() -> Vec<Entry> {
    let folders: Vec<PathBuf> = settings::get().local_folders.iter().map(PathBuf::from).collect();
    index()
        .lock()
        .entries
        .iter()
        .filter(|e| folders.iter().any(|f| Path::new(&e.path).starts_with(f)))
        .cloned()
        .collect()
}

pub fn status() -> LocalStatus {
    let list = entries();
    LocalStatus {
        scanning: SCANNING.load(Ordering::SeqCst),
        scanned_at: index().lock().scanned_at,
        files: list.len(),
        movies: list.iter().filter(|e| e.matched.as_ref().is_some_and(|m| m.kind == "movie")).count(),
        episodes: list.iter().filter(|e| e.matched.as_ref().is_some_and(|m| m.kind == "series")).count(),
        unmatched: list.iter().filter(|e| e.matched.is_none()).count(),
        error: LAST_ERROR.lock().clone(),
    }
}

/// Before answering, make sure there is something to answer from.
async fn ready() {
    if settings::get().local_folders.is_empty() {
        return;
    }
    if index().lock().scanned_at == 0 || SCANNING.load(Ordering::SeqCst) {
        rescan().await;
    }
}

// ----------------------------------------------------------------- addon

fn local_id(file: &str) -> String {
    format!("local:{}", util::b64url_encode(file.as_bytes()))
}

fn file_of(id: &str) -> Option<String> {
    String::from_utf8(util::b64url_decode(id.strip_prefix("local:")?)?).ok()
}

fn display_name(e: &Entry) -> String {
    let p = &e.parsed;
    let ep = match (p.season, p.episode) {
        (Some(s), Some(n)) => format!(" S{s:02}E{n:02}"),
        _ => String::new(),
    };
    let title = if p.title.is_empty() { stem(Path::new(&e.path)) } else { p.title.clone() };
    title + &ep
}

fn matching(kind: &str, id: &str) -> Vec<Entry> {
    if id.starts_with("local:") {
        let Some(file) = file_of(id) else { return vec![] };
        return entries().into_iter().filter(|e| e.path == file).collect();
    }
    if kind == "movie" {
        return entries()
            .into_iter()
            .filter(|e| e.matched.as_ref().is_some_and(|m| m.kind == "movie" && m.id == id))
            .collect();
    }
    let mut parts = id.split(':');
    let show = parts.next().unwrap_or("");
    let season: Option<i64> = parts.next().and_then(|s| s.parse().ok());
    let episode: Option<i64> = parts.next().and_then(|s| s.parse().ok());
    entries()
        .into_iter()
        .filter(|e| {
            e.matched.as_ref().is_some_and(|m| m.kind == "series" && m.id == show)
                && e.parsed.season == season
                && e.parsed.episode == episode
        })
        .collect()
}

fn source_title(file_name: &str, path: &Path, size: u64) -> String {
    let dir = path.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{file_name}\n📁 {dir}\n💾 {}", util::size_label(size))
}

pub async fn catalog(kind: &str, extra: &serde_json::Map<String, Value>) -> Vec<Value> {
    ready().await;
    let query = norm(extra.get("search").and_then(Value::as_str).unwrap_or(""));
    let mut list = entries();
    list.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for e in list {
        let (id, name, meta) = match &e.matched {
            Some(m) if m.kind == kind => (
                m.id.clone(),
                m.name.clone(),
                json!({ "id": m.id, "type": kind, "name": m.name, "poster": m.poster, "releaseInfo": m.year }),
            ),
            Some(_) => continue,
            // Unmatched files are listed as films under their own name, episodes included.
            None if kind == "movie" => {
                let id = local_id(&e.path);
                let name = display_name(&e);
                (id.clone(), name.clone(), json!({ "id": id, "type": "movie", "name": name }))
            }
            None => continue,
        };
        if seen.contains(&id) || (!query.is_empty() && !norm(&name).contains(&query)) {
            continue;
        }
        seen.insert(id);
        out.push(meta);
    }
    out
}

pub fn meta(id: &str) -> Option<Value> {
    let e = matching("movie", id).into_iter().next()?;
    Some(json!({
        "id": id,
        "type": "movie",
        "name": display_name(&e),
        "releaseInfo": e.parsed.year.map(|y| y.to_string()),
        "description": format!(
            "{}\n\nStreamline could not match this file to a title, so it is shown under its file name. Renaming it to something like “Title (Year).mkv” and rescanning usually fixes that.",
            e.path
        ),
    }))
}

pub async fn streams(kind: &str, id: &str) -> Vec<Value> {
    if index().lock().scanned_at == 0 {
        ready().await;
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for e in matching(kind, id) {
        let path = PathBuf::from(&e.path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        seen.insert(e.path.clone());
        out.push(json!({
            "filePath": e.path,
            "name": "On this computer",
            "title": source_title(&name, &path, e.size),
            "behaviorHints": { "filename": name },
        }));
    }
    // Finished downloads are known by id already, no name matching needed.
    for d in downloads::finished() {
        let mine = if kind == "series" {
            d.video_id.as_deref() == Some(id)
        } else {
            d.meta_id == id && d.video_id.is_none()
        };
        if !mine || !seen.insert(d.file_path.clone()) {
            continue;
        }
        out.push(json!({
            "filePath": d.file_path,
            "name": "Downloaded",
            "addonName": "Downloaded",
            "title": source_title(&d.file_name, Path::new(&d.file_path), d.length),
            "behaviorHints": { "filename": d.file_name },
        }));
    }
    out
}

const LANGS: &[(&str, &str)] = &[
    ("en", "eng"), ("fr", "fre"), ("es", "spa"), ("de", "ger"), ("it", "ita"), ("pt", "por"),
    ("nl", "dut"), ("ru", "rus"), ("ar", "ara"), ("ja", "jpn"), ("zh", "chi"), ("ko", "kor"),
    ("pl", "pol"), ("tr", "tur"), ("sv", "swe"), ("no", "nor"), ("da", "dan"), ("fi", "fin"),
];

/// `Film.mkv` takes `Film.srt`, `Film.en.srt`, `Film.English.vtt`.
pub async fn subtitles(kind: &str, id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for e in matching(kind, id) {
        let path = PathBuf::from(&e.path);
        let Some(dir) = path.parent() else { continue };
        let video_stem = stem(&path).to_lowercase();
        let Ok(names) = std::fs::read_dir(dir) else { continue };
        for n in names.flatten() {
            let name = n.file_name().to_string_lossy().into_owned();
            let ext = util::ext_lower(&name);
            if ext != "srt" && ext != "vtt" {
                continue;
            }
            let base = name[..name.len() - ext.len() - 1].to_string();
            if !base.to_lowercase().starts_with(&video_stem) {
                continue;
            }
            let tag = base[video_stem.len().min(base.len())..]
                .trim_start_matches(['.', '_', ' ', '-'])
                .to_lowercase();
            let lang = LANGS
                .iter()
                .find(|(k, _)| *k == tag)
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| if tag.is_empty() { "und".into() } else { tag.chars().take(12).collect() });
            let file = dir.join(&name);
            out.push(json!({
                "id": format!("local-sub:{}", file.display()),
                "url": server::local_url(&file).await,
                "lang": lang,
            }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Parsed {
        parse_name(Path::new(s))
    }

    #[test]
    fn films() {
        assert_eq!(p("Sintel.2010.1080p.BluRay.x264.mkv"), Parsed { title: "Sintel".into(), year: Some(2010), ..Default::default() });
        assert_eq!(p("2001 A Space Odyssey 1968.mkv").title, "2001 A Space Odyssey");
        assert_eq!(p("[YTS] The Matrix [1999].mp4"), Parsed { title: "The Matrix".into(), year: Some(1999), ..Default::default() });
        assert_eq!(p("Big Buck Bunny 1080p WEB-DL.mp4").title, "Big Buck Bunny");
    }

    #[test]
    fn episodes() {
        let e = p("The.Office.US.S02E05.720p.mkv");
        assert_eq!((e.title.as_str(), e.season, e.episode), ("The Office US", Some(2), Some(5)));
        let e = p("04 - The Office 1x04.avi");
        assert_eq!((e.title.as_str(), e.season, e.episode), ("The Office", Some(1), Some(4)));
        let path = Path::new("Shows").join("Breaking Bad (2008)").join("Season 1").join("S01E02.mkv");
        let e = parse_name(&path);
        assert_eq!((e.title.as_str(), e.season, e.episode), ("Breaking Bad", Some(1), Some(2)));
    }

    #[test]
    fn normalises() {
        assert_eq!(norm("Amélie & Friends!"), "amelie and friends");
    }

    #[test]
    fn local_ids_round_trip() {
        let path = r"C:\Films\Été (2020).mkv";
        assert_eq!(file_of(&local_id(path)).as_deref(), Some(path));
    }
}
