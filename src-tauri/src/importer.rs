//! Imports watched titles, ratings and watchlists from Letterboxd, IMDb, any
//! CSV, Trakt and Simkl. Titles are matched to IMDb ids through Cinemeta;
//! what cannot be matched is reported so it can be added by hand.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::bail;
use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::library::{self, ImportBatch, LibraryItem, ProgressEntry, RatingEntry};
use crate::local::norm;
use crate::{trackers, util};

const CINEMETA: &str = "https://v3-cinemeta.strem.io";

/// One normalised line of someone's history. Ratings are on 0-10 by the time they land here.
#[derive(Clone, Debug, Default)]
struct Candidate {
    title: String,
    year: Option<i64>,
    imdb: Option<String>,
    kind: Option<&'static str>,
    season: Option<i64>,
    episode: Option<i64>,
    watched: bool,
    watchlist: bool,
    rating: Option<f64>,
    date: Option<i64>,
    /// True when `date` is the day it was watched rather than when it was logged.
    date_is_watched: bool,
    source: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ImportSummary {
    watched: usize,
    rated: usize,
    watchlist: usize,
    unmatched: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportStatus {
    state: &'static str,
    phase: String,
    total: usize,
    done: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<ImportSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

static STATUS: LazyLock<Mutex<ImportStatus>> = LazyLock::new(|| {
    Mutex::new(ImportStatus { state: "idle", phase: String::new(), total: 0, done: 0, summary: None, error: None })
});

pub fn status() -> ImportStatus {
    STATUS.lock().clone()
}

fn report(phase: &str) {
    STATUS.lock().phase = phase.to_string();
}

// ---------------------------------------------------------------------- csv

fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let text = input.trim_start_matches('\u{feff}');
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let push_row = |row: &mut Vec<String>, rows: &mut Vec<Vec<String>>| {
        if row.iter().any(|c| !c.trim().is_empty()) {
            rows.push(std::mem::take(row));
        } else {
            row.clear();
        }
    };
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' {
            row.push(std::mem::take(&mut cell));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut cell));
            push_row(&mut row, &mut rows);
        } else {
            cell.push(ch);
        }
    }
    row.push(cell);
    push_row(&mut row, &mut rows);
    rows
}

const ALIASES: &[(&str, &[&str])] = &[
    ("title", &["name", "title", "film", "film title", "movie", "show", "show name", "series", "primary title", "original title"]),
    ("year", &["year", "release year", "released"]),
    ("imdb", &["imdbid", "imdb id", "imdb_id", "imdb", "const", "tconst"]),
    ("rating", &["rating", "your rating", "my rating", "user rating", "user_rating", "score", "stars"]),
    ("watchedOn", &["watched date", "watcheddate", "date watched", "watched at", "watched_at", "last watched"]),
    ("date", &["date", "date rated", "created", "added"]),
    ("type", &["type", "title type", "media type", "kind"]),
    ("season", &["season", "season number"]),
    ("episode", &["episode", "episode number"]),
];

fn column(headers: &[String], field: &str) -> Option<usize> {
    let aliases = ALIASES.iter().find(|(f, _)| *f == field)?.1;
    aliases.iter().find_map(|a| headers.iter().position(|h| h == a))
}

fn parse_year(v: &str) -> Option<i64> {
    let digits: Vec<char> = v.chars().collect();
    digits.windows(4).find(|w| w.iter().all(char::is_ascii_digit)).and_then(|w| w.iter().collect::<String>().parse().ok())
}

fn parse_rating(v: &str) -> Option<f64> {
    let raw = v.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains(['★', '½']) {
        return Some(raw.matches('★').count() as f64 + if raw.contains('½') { 0.5 } else { 0.0 });
    }
    raw.replace(',', ".").parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0)
}

/// The date forms the services export, as epoch milliseconds.
fn parse_date(v: &str) -> Option<i64> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(v) {
        return Some(d.timestamp_millis());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(v, fmt) {
            return Some(d.and_utc().timestamp_millis());
        }
    }
    for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%b %d, %Y", "%d %b %Y", "%B %d, %Y"] {
        if let Ok(d) = chrono::NaiveDate::parse_from_str(v, fmt) {
            return d.and_hms_opt(0, 0, 0).map(|t| t.and_utc().timestamp_millis());
        }
    }
    None
}

/// Movie, series, or `None` with `skip` for things we have no place for (episodes, games).
fn type_from(value: &str, has_episode: bool, service: &str) -> Result<Option<&'static str>, ()> {
    let v = value.to_lowercase();
    if has_episode {
        return Ok(Some("series"));
    }
    if v.contains("movie") || v.contains("film") {
        return Ok(Some("movie"));
    }
    if ["episode", "game", "short"].iter().any(|k| v.contains(k)) {
        return Err(());
    }
    if ["series", "tv", "show", "season"].iter().any(|k| v.contains(k)) {
        return Ok(Some("series"));
    }
    Ok(match service {
        "letterboxd" => Some("movie"),
        "serializd" => Some("series"),
        _ => None,
    })
}

const LETTERBOXD_FILES: &[&str] = &["watched", "ratings", "diary", "watchlist"];

fn candidates_from_csv(name: &str, text: &str, service: &str) -> Vec<Candidate> {
    let rows = parse_csv(text);
    if rows.len() < 2 {
        return vec![];
    }
    let headers: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let col = |f| column(&headers, f);
    let (c_title, c_year, c_imdb, c_rating) = (col("title"), col("year"), col("imdb"), col("rating"));
    let (c_watched, c_date, c_type, c_season, c_episode) = (col("watchedOn"), col("date"), col("type"), col("season"), col("episode"));
    if c_title.is_none() && c_imdb.is_none() {
        return vec![];
    }
    let base = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let watchlist = base.contains("watchlist") || base.contains("want") || base.replace(['_', '-', ' '], "").contains("plantowatch");
    let cell = |r: &Vec<String>, i: Option<usize>| i.and_then(|i| r.get(i)).map(|s| s.trim().to_string()).unwrap_or_default();

    let mut out = Vec::new();
    for r in &rows[1..] {
        let imdb_raw = cell(r, c_imdb);
        let imdb = (imdb_raw.starts_with("tt") && imdb_raw[2..].chars().all(|c| c.is_ascii_digit()) && imdb_raw.len() > 2)
            .then_some(imdb_raw);
        let title = cell(r, c_title);
        if title.is_empty() && imdb.is_none() {
            continue;
        }
        let season = cell(r, c_season).parse::<i64>().ok();
        let episode = cell(r, c_episode).parse::<i64>().ok();
        let has_episode = season.is_some() && episode.is_some();
        let Ok(kind) = type_from(&cell(r, c_type), has_episode, service) else { continue };
        let watched_on = parse_date(&cell(r, c_watched));
        out.push(Candidate {
            title,
            year: parse_year(&cell(r, c_year)),
            imdb,
            kind,
            season: season.filter(|_| has_episode),
            episode: episode.filter(|_| has_episode),
            watched: !watchlist,
            watchlist,
            rating: parse_rating(&cell(r, c_rating)),
            date: watched_on.or_else(|| parse_date(&cell(r, c_date))),
            date_is_watched: watched_on.is_some(),
            source: service.to_string(),
        });
    }

    // Each file uses its own scale: Letterboxd and Serializd are half-stars out
    // of five, IMDb is out of ten. Bring them all to ten so ratings compare.
    let max = out.iter().filter_map(|c| c.rating).fold(0.0f64, f64::max);
    let scale = if service == "imdb" {
        1.0
    } else if service == "letterboxd" || service == "serializd" || max <= 5.0 {
        2.0
    } else if max <= 10.0 {
        1.0
    } else {
        0.1
    };
    for c in &mut out {
        if let Some(r) = c.rating {
            c.rating = Some((r * scale).min(10.0));
        }
    }
    out
}

fn read_files(paths: &[String]) -> anyhow::Result<Vec<(String, String)>> {
    let mut files = Vec::new();
    for p in paths {
        if p.to_lowercase().ends_with(".zip") {
            let mut archive = zip::ZipArchive::new(std::fs::File::open(p)?)?;
            let mut entries = Vec::new();
            for i in 0..archive.len() {
                let mut f = archive.by_index(i)?;
                let name = f.name().to_string();
                if !name.to_lowercase().ends_with(".csv") {
                    continue;
                }
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes)?;
                entries.push((name, crate::subtitles::decode(&bytes)));
            }
            // A Letterboxd export carries lists, reviews and comments too; only its
            // four history files are wanted. Other zips are read whole.
            let known: Vec<_> = entries
                .iter()
                .filter(|(n, _)| {
                    !n.contains('/')
                        && LETTERBOXD_FILES.contains(&Path::new(n).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default().as_str())
                })
                .cloned()
                .collect();
            files.extend(if known.is_empty() { entries } else { known });
        } else {
            let bytes = std::fs::read(p)?;
            let name = Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            files.push((name, crate::subtitles::decode(&bytes)));
        }
    }
    Ok(files)
}

// ---------------------------------------------------------------- accounts

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

async fn candidates_from_trakt() -> anyhow::Result<Vec<Candidate>> {
    let lists: [(&str, &str, &'static str); 6] = [
        ("/sync/ratings/movies", "ratings", "movie"),
        ("/sync/ratings/shows", "ratings", "series"),
        ("/sync/watched/movies", "watched", "movie"),
        ("/sync/watched/shows", "watched", "series"),
        ("/sync/watchlist/movies", "watchlist", "movie"),
        ("/sync/watchlist/shows", "watchlist", "series"),
    ];
    let mut out = Vec::new();
    for (route, kind, ty) in lists {
        report(&format!("Reading Trakt {kind} ({})…", if ty == "movie" { "movies" } else { "shows" }));
        for it in trackers::trakt_fetch_all(route).await? {
            let obj = if it["movie"].is_object() { &it["movie"] } else { &it["show"] };
            let Some(title) = str_of(&obj["title"]) else { continue };
            let date = str_of(&it["last_watched_at"]).or_else(|| str_of(&it["rated_at"])).or_else(|| str_of(&it["listed_at"]));
            out.push(Candidate {
                title,
                year: obj["year"].as_i64(),
                imdb: str_of(&obj["ids"]["imdb"]),
                kind: Some(ty),
                watched: kind != "watchlist",
                watchlist: kind == "watchlist",
                rating: if kind == "ratings" { it["rating"].as_f64() } else { None },
                date: date.as_deref().and_then(parse_date),
                date_is_watched: kind == "watched",
                source: "trakt".into(),
                ..Default::default()
            });
        }
    }
    Ok(out)
}

async fn candidates_from_simkl() -> anyhow::Result<Vec<Candidate>> {
    report("Reading your Simkl lists…");
    let data = trackers::simkl_fetch_all().await?;
    let mut out = Vec::new();
    for (bucket, ty) in [("movies", "movie"), ("shows", "series"), ("anime", "series")] {
        for it in data[bucket].as_array().into_iter().flatten() {
            let obj = if it["movie"].is_object() { &it["movie"] } else { &it["show"] };
            let Some(title) = str_of(&obj["title"]) else { continue };
            let watched = it["status"] == "completed";
            let watchlist = it["status"] == "plantowatch";
            let rating = it["user_rating"].as_f64();
            if !watched && !watchlist && rating.is_none() {
                continue;
            }
            let date = str_of(&it["last_watched_at"]).or_else(|| str_of(&it["added_to_watchlist_at"]));
            out.push(Candidate {
                title,
                year: obj["year"].as_i64(),
                imdb: str_of(&obj["ids"]["imdb"]),
                kind: Some(ty),
                watched,
                watchlist,
                rating,
                date: date.as_deref().and_then(parse_date),
                date_is_watched: watched,
                source: "simkl".into(),
                ..Default::default()
            });
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ matching

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Preview {
    id: String,
    #[serde(default)]
    name: String,
    poster: Option<String>,
    release_info: Option<String>,
}

async fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Option<T> {
    for _ in 0..2 {
        match util::get_json::<T>(url, Duration::from_secs(15)).await {
            Ok(v) => return v,
            Err(_) => continue, // retry once
        }
    }
    None
}

/// Best candidate, not first. An exact year outranks a near one, and ties fall
/// back to Cinemeta's own popularity order.
fn pick_match(metas: &[Preview], title: &str, year: Option<i64>) -> Option<Preview> {
    let want = norm(title);
    if want.is_empty() {
        return None;
    }
    let mut best: Option<Preview> = None;
    let mut best_score = 0;
    for m in metas {
        let name = norm(&m.name);
        let y = m.release_info.as_deref().and_then(parse_year);
        let exact = matches!((year, y), (Some(a), Some(b)) if a == b);
        let near = matches!((year, y), (Some(a), Some(b)) if (a - b).abs() == 1);
        let unknown = year.is_none() || y.is_none();
        let name_score = if name == want {
            4
        } else if format!(" {name} ").contains(&format!(" {want} ")) || format!(" {want} ").contains(&format!(" {name} ")) {
            // A subtitle or alternate title: only trusted on an exact year.
            if exact { 3 } else { 0 }
        } else {
            0
        };
        if name_score == 0 {
            continue;
        }
        let year_score = if exact { 3 } else if near || unknown { 1 } else { 0 };
        if year_score == 0 {
            continue;
        }
        if name_score + year_score > best_score {
            best = Some(m.clone());
            best_score = name_score + year_score;
        }
    }
    best
}

struct Matcher {
    cache: tokio::sync::Mutex<HashMap<String, Arc<Vec<Preview>>>>,
}

impl Matcher {
    async fn search(&self, ty: &str, title: &str) -> Arc<Vec<Preview>> {
        let key = format!("{ty}:{}", norm(title));
        if let Some(hit) = self.cache.lock().await.get(&key) {
            return hit.clone();
        }
        #[derive(Deserialize)]
        struct Res {
            #[serde(default)]
            metas: Vec<Preview>,
        }
        let url = format!(
            "{CINEMETA}/catalog/{ty}/top/search={}.json",
            percent_encoding::utf8_percent_encode(title, percent_encoding::NON_ALPHANUMERIC)
        );
        let metas = Arc::new(get_json::<Res>(&url).await.map(|r| r.metas).unwrap_or_default());
        self.cache.lock().await.insert(key, metas.clone());
        metas
    }
}

struct Resolved {
    id: String,
    kind: String,
    name: String,
    poster: Option<String>,
    year: Option<String>,
}

fn poster_for(imdb: &str) -> String {
    format!("https://images.metahub.space/poster/small/{imdb}/img")
}

async fn resolve(m: &Matcher, c: &Candidate) -> Option<Resolved> {
    if let Some(imdb) = &c.imdb {
        let mut kind = c.kind.map(str::to_string);
        let mut name = c.title.clone();
        let mut year = c.year.map(|y| y.to_string());
        if kind.is_none() {
            // An id with no type: whichever catalogue knows it decides.
            for t in ["movie", "series"] {
                #[derive(Deserialize)]
                struct Res {
                    meta: Option<Preview>,
                }
                if let Some(Res { meta: Some(meta) }) = get_json::<Res>(&format!("{CINEMETA}/meta/{t}/{imdb}.json")).await {
                    kind = Some(t.into());
                    if name.is_empty() {
                        name = meta.name;
                    }
                    year = year.or(meta.release_info);
                    break;
                }
            }
        }
        return Some(Resolved {
            id: imdb.clone(),
            kind: kind.unwrap_or_else(|| "movie".into()),
            name: if name.is_empty() { imdb.clone() } else { name },
            poster: Some(poster_for(imdb)),
            year,
        });
    }
    let order: Vec<&str> = match c.kind {
        Some(k) => vec![k],
        None => vec!["movie", "series"],
    };
    for ty in order {
        if let Some(hit) = pick_match(&m.search(ty, &c.title).await, &c.title, c.year) {
            let poster = hit.poster.clone().or_else(|| hit.id.starts_with("tt").then(|| poster_for(&hit.id)));
            return Some(Resolved {
                year: hit.release_info.clone().or_else(|| c.year.map(|y| y.to_string())),
                id: hit.id,
                kind: ty.into(),
                name: hit.name,
                poster,
            });
        }
    }
    None
}

// ------------------------------------------------------------------- the job

fn merge_candidates(list: Vec<Candidate>) -> Vec<Candidate> {
    let mut order: Vec<String> = Vec::new();
    let mut merged: HashMap<String, Candidate> = HashMap::new();
    for c in list {
        let who = c.imdb.clone().unwrap_or_else(|| format!("{}|{}", norm(&c.title), c.year.map(|y| y.to_string()).unwrap_or_default()));
        let key = format!(
            "{who}|{}|{}|{}",
            c.kind.unwrap_or(""),
            c.season.map(|s| s.to_string()).unwrap_or_default(),
            c.episode.map(|e| e.to_string()).unwrap_or_default()
        );
        match merged.get_mut(&key) {
            None => {
                order.push(key.clone());
                merged.insert(key, c);
            }
            Some(prev) => {
                prev.watched |= c.watched;
                prev.watchlist |= c.watchlist;
                prev.rating = c.rating.or(prev.rating);
                prev.year = prev.year.or(c.year);
                if c.date.is_some() && (prev.date.is_none() || (c.date_is_watched && !prev.date_is_watched)) {
                    prev.date = c.date;
                    prev.date_is_watched = c.date_is_watched;
                }
            }
        }
    }
    order.into_iter().filter_map(|k| merged.remove(&k)).collect()
}

async fn run(service: String, paths: Vec<String>) -> anyhow::Result<ImportSummary> {
    let candidates = match service.as_str() {
        "trakt" => candidates_from_trakt().await?,
        "simkl" => candidates_from_simkl().await?,
        _ => {
            report("Reading your files…");
            let files = tokio::task::spawn_blocking(move || read_files(&paths)).await??;
            files.iter().flat_map(|(n, t)| candidates_from_csv(n, t, &service)).collect()
        }
    };
    if candidates.is_empty() {
        bail!("Nothing to import in that. Pick the export from the service — a Letterboxd ZIP, or a CSV with a title column.");
    }
    let merged = merge_candidates(candidates);
    {
        let mut s = STATUS.lock();
        s.phase = "Matching titles…".into();
        s.total = merged.len();
        s.done = 0;
    }

    let matcher = Matcher { cache: tokio::sync::Mutex::new(HashMap::new()) };
    let done = AtomicUsize::new(0);
    let results: Vec<(Candidate, Option<Resolved>)> = futures::stream::iter(merged)
        .map(|c| {
            let (matcher, done) = (&matcher, &done);
            async move {
                let hit = resolve(matcher, &c).await;
                STATUS.lock().done = done.fetch_add(1, Ordering::Relaxed) + 1;
                (c, hit)
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;

    let now = util::now_ms();
    let mut batch = ImportBatch { items: vec![], progress: vec![], ratings: vec![] };
    let mut summary = ImportSummary::default();
    for (c, hit) in results {
        let Some(hit) = hit else {
            summary.unmatched.push(match c.year {
                Some(y) => format!("{} ({y})", c.title),
                None => c.title.clone(),
            });
            continue;
        };
        let when = c.date.unwrap_or(now);
        let is_episode = c.season.is_some() && c.episode.is_some();
        // Rating a title means you saw it, which is how Letterboxd treats it too.
        if c.watched || c.rating.is_some() {
            let video_id = is_episode.then(|| format!("{}:{}:{}", hit.id, c.season.unwrap(), c.episode.unwrap()));
            batch.progress.push(ProgressEntry {
                key: format!("{}:{}", hit.kind, video_id.clone().unwrap_or_else(|| hit.id.clone())),
                id: hit.id.clone(),
                kind: hit.kind.clone(),
                name: hit.name.clone(),
                poster: hit.poster.clone(),
                season: c.season,
                episode: c.episode,
                video_id,
                year: hit.year.clone(),
                time: 0.0,
                duration: 0.0,
                updated_at: when,
                finished: Some(true),
                extra: Map::new(),
            });
            summary.watched += 1;
        } else if c.watchlist {
            batch.items.push(LibraryItem {
                key: format!("{}:{}", hit.kind, hit.id),
                id: hit.id.clone(),
                kind: hit.kind.clone(),
                name: hit.name.clone(),
                poster: hit.poster.clone(),
                favorite: Some(true),
                added_at: Some(when),
                extra: Map::new(),
            });
            summary.watchlist += 1;
        }
        if let (Some(r), false) = (c.rating, is_episode) {
            batch.ratings.push(RatingEntry {
                key: format!("{}:{}", hit.kind, hit.id),
                id: hit.id.clone(),
                kind: hit.kind.clone(),
                name: hit.name.clone(),
                poster: hit.poster.clone(),
                year: hit.year.clone(),
                rating: (r * 10.0).round() / 10.0,
                rated_at: when,
                source: c.source.clone(),
                extra: Map::new(),
            });
            summary.rated += 1;
        }
    }
    library::merge_import(batch);
    Ok(summary)
}

pub fn start(service: String, paths: Vec<String>) -> anyhow::Result<()> {
    {
        let mut s = STATUS.lock();
        if s.state == "running" {
            bail!("An import is already running.");
        }
        *s = ImportStatus { state: "running", phase: "Starting…".into(), total: 0, done: 0, summary: None, error: None };
    }
    tauri::async_runtime::spawn(async move {
        let result = run(service, paths).await;
        let mut s = STATUS.lock();
        match result {
            Ok(summary) => {
                s.state = "done";
                s.phase = "Done".into();
                s.summary = Some(summary);
            }
            Err(err) => {
                s.state = "error";
                s.phase = "Failed".into();
                s.error = Some(err.to_string());
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_newlines() {
        let rows = parse_csv("Name,Year\r\n\"Crouching Tiger, Hidden Dragon\",2000\n\"Say \"\"Hi\"\"\",1999\n\n");
        assert_eq!(rows, vec![vec!["Name", "Year"], vec!["Crouching Tiger, Hidden Dragon", "2000"], vec!["Say \"Hi\"", "1999"]]);
    }

    #[test]
    fn letterboxd_ratings_scale_to_ten() {
        let c = candidates_from_csv("ratings.csv", "Date,Name,Year,Rating\n2024-01-02,Dune,2021,4.5\n", "letterboxd");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].rating, Some(9.0));
        assert_eq!(c[0].year, Some(2021));
        assert!(c[0].date.is_some());
    }

    #[test]
    fn imdb_skips_episodes() {
        let csv = "Const,Your Rating,Title,Title Type,Year\ntt0111161,10,The Shawshank Redemption,Movie,1994\ntt0959621,9,Pilot,TV Episode,2008\n";
        let c = candidates_from_csv("ratings.csv", csv, "imdb");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].imdb.as_deref(), Some("tt0111161"));
    }

    #[test]
    fn dates() {
        assert!(parse_date("2023-05-01").is_some());
        assert!(parse_date("2023-05-01T10:00:00.000Z").is_some());
        assert!(parse_date("nope").is_none());
    }
}
