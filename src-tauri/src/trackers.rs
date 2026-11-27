//! Trakt and Simkl: device-code sign-in, live scrobbling, history pulls for
//! the importer, and CSV exports for the services with no API.

use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::library::{self, ProgressEntry};
use crate::{settings, util};

const TRAKT_API: &str = "https://api.trakt.tv";
const SIMKL_API: &str = "https://api.simkl.com";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuth {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Serialize)]
pub struct TrackerStatus {
    trakt: bool,
    simkl: bool,
}

pub fn status() -> TrackerStatus {
    let s = settings::get();
    TrackerStatus { trakt: !s.trakt_token.is_empty(), simkl: !s.simkl_token.is_empty() }
}

pub fn disconnect(name: &str) {
    settings::update(|s| {
        if name == "trakt" {
            s.trakt_token.clear();
            s.trakt_refresh.clear();
        } else {
            s.simkl_token.clear();
        }
    });
}

async fn send_json(req: reqwest::RequestBuilder) -> anyhow::Result<(StatusCode, reqwest::header::HeaderMap, Value)> {
    let res = req.timeout(Duration::from_secs(20)).send().await?;
    let status = res.status();
    let headers = res.headers().clone();
    let text = res.text().await.unwrap_or_default();
    let body = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
    Ok((status, headers, body))
}

fn fail(status: StatusCode, body: &Value) -> anyhow::Error {
    let detail = match body {
        Value::Null => String::new(),
        Value::String(s) => format!(" — {}", s.chars().take(200).collect::<String>()),
        other => format!(" — {}", other.to_string().chars().take(200).collect::<String>()),
    };
    anyhow::anyhow!("{status}{detail}")
}

// ---------------------------------------------------------------- Trakt

pub async fn trakt_start() -> anyhow::Result<DeviceAuth> {
    let s = settings::get();
    if s.trakt_client_id.is_empty() {
        bail!("Add your Trakt Client ID in Settings first.");
    }
    let (status, _, body) = send_json(
        util::http().post(format!("{TRAKT_API}/oauth/device/code")).json(&json!({ "client_id": s.trakt_client_id })),
    )
    .await?;
    if !status.is_success() {
        return Err(fail(status, &body));
    }
    Ok(DeviceAuth {
        device_code: body["device_code"].as_str().unwrap_or_default().into(),
        user_code: body["user_code"].as_str().unwrap_or_default().into(),
        verification_url: body["verification_url"].as_str().unwrap_or("https://trakt.tv/activate").into(),
        interval: body["interval"].as_u64().unwrap_or(5),
        expires_in: body["expires_in"].as_u64().unwrap_or(600),
    })
}

fn save_trakt_tokens(body: &Value) {
    let access = body["access_token"].as_str().unwrap_or_default().to_string();
    let refresh = body["refresh_token"].as_str().unwrap_or_default().to_string();
    settings::update(|s| {
        s.trakt_token = access;
        if !refresh.is_empty() {
            s.trakt_refresh = refresh;
        }
    });
}

/// Polls until the user approves in their browser, or the code expires.
pub async fn trakt_poll(auth: DeviceAuth) -> anyhow::Result<bool> {
    let s = settings::get();
    let deadline = Instant::now() + Duration::from_secs(auth.expires_in);
    let mut wait = Duration::from_secs(auth.interval.max(1));
    while Instant::now() < deadline {
        tokio::time::sleep(wait).await;
        let (status, _, body) = send_json(util::http().post(format!("{TRAKT_API}/oauth/device/token")).json(&json!({
            "code": auth.device_code,
            "client_id": s.trakt_client_id,
            "client_secret": s.trakt_client_secret,
        })))
        .await?;
        match status.as_u16() {
            200 => {
                save_trakt_tokens(&body);
                return Ok(true);
            }
            400 => continue, // still waiting on the user
            429 => wait += Duration::from_secs(1),
            404 => bail!("That Trakt code is no longer valid. Try again."),
            409 => return Ok(!settings::get().trakt_token.is_empty()),
            410 => bail!("The Trakt code expired. Try again."),
            418 => bail!("Trakt authorisation was denied."),
            other => bail!("Trakt returned {other}."),
        }
    }
    bail!("Timed out waiting for Trakt approval.")
}

/// Access tokens expire; the refresh token gets a new one without asking again.
async fn trakt_refresh() -> anyhow::Result<()> {
    let s = settings::get();
    if s.trakt_refresh.is_empty() {
        bail!("Trakt needs you to connect again.");
    }
    let (status, _, body) = send_json(util::http().post(format!("{TRAKT_API}/oauth/token")).json(&json!({
        "refresh_token": s.trakt_refresh,
        "client_id": s.trakt_client_id,
        "client_secret": s.trakt_client_secret,
        "redirect_uri": "urn:ietf:wg:oauth:2.0:oob",
        "grant_type": "refresh_token",
    })))
    .await?;
    if !status.is_success() {
        bail!("Trakt needs you to connect again ({status}).");
    }
    save_trakt_tokens(&body);
    Ok(())
}

/// An authenticated Trakt call, refreshing the token once when it has expired.
async fn trakt(method: Method, path: &str, body: Option<&Value>) -> anyhow::Result<(reqwest::header::HeaderMap, Value)> {
    for attempt in 0..2 {
        let s = settings::get();
        let mut req = util::http()
            .request(method.clone(), format!("{TRAKT_API}{path}"))
            .header("trakt-api-version", "2")
            .header("trakt-api-key", &s.trakt_client_id)
            .bearer_auth(&s.trakt_token);
        if let Some(b) = body {
            req = req.json(b);
        }
        let (status, headers, value) = send_json(req).await?;
        if status == StatusCode::UNAUTHORIZED && attempt == 0 {
            trakt_refresh().await?;
            continue;
        }
        if !status.is_success() {
            return Err(fail(status, &value)).with_context(|| format!("Trakt {path}"));
        }
        return Ok((headers, value));
    }
    unreachable!()
}

/// Every page of a Trakt sync list. Trakt sends the page count as a header.
pub async fn trakt_fetch_all(path: &str) -> anyhow::Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let (headers, body) = trakt(Method::GET, &format!("{path}?page={page}&limit=1000"), None).await?;
        if let Value::Array(items) = body {
            out.extend(items);
        }
        let pages: u32 = headers
            .get("x-pagination-page-count")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        page += 1;
        if page > pages {
            break;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- Simkl

pub async fn simkl_start() -> anyhow::Result<DeviceAuth> {
    let s = settings::get();
    if s.simkl_client_id.is_empty() {
        bail!("Add your Simkl Client ID in Settings first.");
    }
    let url = format!("{SIMKL_API}/oauth/pin?client_id={}", enc(&s.simkl_client_id));
    let (status, _, body) = send_json(util::http().get(url)).await?;
    if !status.is_success() {
        return Err(fail(status, &body));
    }
    let user_code = body["user_code"].as_str().unwrap_or_default().to_string();
    Ok(DeviceAuth {
        device_code: body["device_code"].as_str().map(str::to_string).unwrap_or_else(|| user_code.clone()),
        user_code,
        verification_url: body["verification_url"].as_str().unwrap_or("https://simkl.com/pin").into(),
        interval: body["interval"].as_u64().unwrap_or(5),
        expires_in: body["expires_in"].as_u64().unwrap_or(900),
    })
}

pub async fn simkl_poll(auth: DeviceAuth) -> anyhow::Result<bool> {
    let s = settings::get();
    let deadline = Instant::now() + Duration::from_secs(auth.expires_in);
    let wait = Duration::from_secs(auth.interval.max(1));
    while Instant::now() < deadline {
        tokio::time::sleep(wait).await;
        let url = format!("{SIMKL_API}/oauth/pin/{}?client_id={}", enc(&auth.user_code), enc(&s.simkl_client_id));
        let Ok((status, _, body)) = send_json(util::http().get(url)).await else { continue };
        if !status.is_success() {
            continue;
        }
        if body["result"] == "OK" {
            if let Some(token) = body["access_token"].as_str() {
                let token = token.to_string();
                settings::update(|s| s.simkl_token = token);
                return Ok(true);
            }
        }
    }
    bail!("Timed out waiting for Simkl approval.")
}

fn simkl_request(method: Method, path: &str) -> reqwest::RequestBuilder {
    let s = settings::get();
    util::http()
        .request(method, format!("{SIMKL_API}{path}"))
        .header("simkl-api-key", s.simkl_client_id)
        .bearer_auth(s.simkl_token)
}

/// Simkl returns a user's whole list (movies, shows, anime) in one call.
pub async fn simkl_fetch_all() -> anyhow::Result<Value> {
    let (status, _, body) = send_json(simkl_request(Method::GET, "/sync/all-items/?extended=full")).await?;
    if !status.is_success() {
        bail!("Simkl returned {status}.");
    }
    Ok(if body.is_object() { body } else { json!({}) })
}

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

// ------------------------------------------------------------- scrobble

fn is_episode(e: &ProgressEntry) -> bool {
    e.season.is_some() && e.episode.is_some()
}

pub async fn scrobble(action: &str, entry: ProgressEntry) {
    if !matches!(action, "start" | "pause" | "stop") || !entry.id.starts_with("tt") {
        return;
    }
    let s = settings::get();
    let progress = if entry.duration > 0.0 { (entry.time / entry.duration * 100.0).clamp(0.0, 100.0) } else { 0.0 };

    if !s.trakt_token.is_empty() {
        let body = if is_episode(&entry) {
            json!({ "show": { "ids": { "imdb": entry.id } }, "episode": { "season": entry.season, "number": entry.episode }, "progress": progress })
        } else {
            json!({ "movie": { "ids": { "imdb": entry.id } }, "progress": progress })
        };
        if let Err(err) = trakt(Method::POST, &format!("/scrobble/{action}"), Some(&body)).await {
            tracing::warn!("trakt scrobble failed: {err:#}");
        }
    }

    // Simkl has no live scrobble endpoint we rely on, so it records on completion.
    if !s.simkl_token.is_empty() && action == "stop" && progress >= 80.0 {
        let body = if is_episode(&entry) {
            json!({ "shows": [{ "ids": { "imdb": entry.id }, "seasons": [{ "number": entry.season, "episodes": [{ "number": entry.episode }] }] }] })
        } else {
            json!({ "movies": [{ "ids": { "imdb": entry.id } }] })
        };
        match send_json(simkl_request(Method::POST, "/sync/history").json(&body)).await {
            Ok((status, _, _)) if status.is_success() => {}
            Ok((status, _, _)) => tracing::warn!("simkl history failed: {status}"),
            Err(err) => tracing::warn!("simkl history failed: {err}"),
        }
    }
}

// ----------------------------------------------------------- CSV export

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn iso_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Letterboxd's importer matches on `imdbID` when present, which avoids the
/// title-collision problem entirely.
pub fn export_csv(kind: &str, path: &std::path::Path) -> anyhow::Result<usize> {
    let progress = library::list().progress;
    let (header, rows): (&str, Vec<String>) = if kind == "letterboxd" {
        let rows = progress
            .iter()
            .filter(|p| p.is_finished() && p.season.is_none() && p.id.starts_with("tt"))
            .map(|p| {
                [csv_cell(&p.name), csv_cell(p.year.as_deref().unwrap_or("")), csv_cell(&p.id), iso_date(p.updated_at)].join(",")
            })
            .collect();
        ("Title,Year,imdbID,WatchedDate", rows)
    } else {
        let rows = progress
            .iter()
            .filter(|p| p.is_finished() && p.season.is_some())
            .map(|p| {
                [
                    csv_cell(&p.name),
                    p.season.map(|s| s.to_string()).unwrap_or_default(),
                    p.episode.map(|e| e.to_string()).unwrap_or_default(),
                    csv_cell(&p.id),
                    iso_date(p.updated_at),
                ]
                .join(",")
            })
            .collect();
        ("Show,Season,Episode,imdbID,WatchedDate", rows)
    };
    let mut csv = String::from(header);
    for r in &rows {
        csv.push('\n');
        csv.push_str(r);
    }
    std::fs::write(path, csv)?;
    Ok(rows.len())
}
