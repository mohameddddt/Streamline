//! The loopback media server the player reads from: torrent files as they
//! arrive, files on disk, and ffmpeg's live output.
//!
//! Every URL starts with a secret minted at launch. The Electron build served
//! `/local?p=<any path>` to anyone who asked, which let any web page open in a
//! browser on this machine read downloaded files through it.

use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, Request};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::TryStreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::OnceCell;
use tokio_util::io::ReaderStream;

use crate::torrent::ENGINE;
use crate::{playback, settings, util};

struct Server {
    port: u16,
}

/// Minted once per launch; handlers read it without touching the server cell.
static TOKEN: LazyLock<String> = LazyLock::new(|| util::random_token(24));
static SERVER: OnceCell<Server> = OnceCell::const_new();

async fn server() -> &'static Server {
    SERVER
        .get_or_init(|| async {
            // Loopback only: nothing about these files should be reachable off-machine.
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind the local media server");
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            let app = router();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = axum::serve(listener, app).await {
                    tracing::error!("local media server stopped: {err}");
                }
            });
            tracing::info!("media server on http://127.0.0.1:{port}");
            Server { port }
        })
        .await
}

/// Built outside `server()`: the handlers call back into it, and keeping the
/// two apart lets the compiler see that everything here is `Send`.
fn router() -> Router {
    Router::new()
        .route("/{token}/stream/{hash}/{idx}", get(stream_file))
        .route("/{token}/local", get(local_file))
        .route("/{token}/transcode", get(transcode))
        .fallback(|| async { StatusCode::NOT_FOUND })
}

pub async fn base() -> String {
    let s = server().await;
    format!("http://127.0.0.1:{}/{}", s.port, *TOKEN)
}

pub async fn stream_url(hash: &str, idx: usize) -> String {
    format!("{}/stream/{}/{idx}", base().await, hash.to_lowercase())
}

pub async fn local_url(path: &std::path::Path) -> String {
    let p = utf8_percent_encode(&path.to_string_lossy(), NON_ALPHANUMERIC).to_string();
    format!("{}/local?p={p}", base().await)
}

/// Our own URLs, which ffmpeg and the subtitle fetcher may read.
pub async fn is_own_url(url: &str) -> bool {
    url.starts_with(&format!("{}/", base().await))
}

fn token_ok(token: &str) -> bool {
    util::constant_time_eq(token.as_bytes(), TOKEN.as_bytes())
}

// ------------------------------------------------------------------ ranges

#[derive(Debug, PartialEq)]
pub enum Range {
    Full,
    Partial(u64, u64),
    Unsatisfiable,
}

/// Reads a `Range: bytes=…` header for a file of `total` bytes. Only the first
/// range of a multi-range request is served. `bytes=-500` is the last 500
/// bytes — the old server read it as the first 500.
pub fn parse_range(header: Option<&str>, total: u64) -> Range {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Range::Full };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else { return Range::Full };
    let (a, b) = (a.trim(), b.trim());
    if total == 0 {
        return Range::Unsatisfiable;
    }
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (true, true) => return Range::Full,
        (true, false) => {
            let Ok(n) = b.parse::<u64>() else { return Range::Full };
            if n == 0 {
                return Range::Unsatisfiable;
            }
            (total.saturating_sub(n), total - 1)
        }
        (false, _) => {
            let Ok(start) = a.parse::<u64>() else { return Range::Full };
            let end = if b.is_empty() { total - 1 } else { b.parse::<u64>().unwrap_or(total - 1) };
            (start, end.min(total - 1))
        }
    };
    if start >= total || start > end {
        return Range::Unsatisfiable;
    }
    Range::Partial(start, end)
}

fn cors(headers: &mut HeaderMap) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
}

/// Status and headers for a (possibly partial) response. `None` means 416.
fn range_head(req_headers: &HeaderMap, total: u64, mime: &str) -> Result<(StatusCode, HeaderMap, u64, u64), Response> {
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap_or(HeaderValue::from_static("video/mp4")));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    cors(&mut h);
    let range = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range, total) {
        Range::Full => {
            h.insert(header::CONTENT_LENGTH, total.into());
            Ok((StatusCode::OK, h, 0, total.saturating_sub(1)))
        }
        Range::Partial(start, end) => {
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
            );
            h.insert(header::CONTENT_LENGTH, (end - start + 1).into());
            Ok((StatusCode::PARTIAL_CONTENT, h, start, end))
        }
        Range::Unsatisfiable => {
            let mut h = HeaderMap::new();
            h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{total}")).unwrap());
            Err((StatusCode::RANGE_NOT_SATISFIABLE, h).into_response())
        }
    }
}

fn plain(status: StatusCode, msg: &'static str) -> Response {
    (status, msg).into_response()
}

// ---------------------------------------------------------------- handlers

async fn stream_file(Path((token, hash, idx)): Path<(String, String, usize)>, req: Request) -> Response {
    if !token_ok(&token) {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some((torrent, handle)) = ENGINE.handle(&hash) else {
        return plain(StatusCode::NOT_FOUND, "torrent not ready");
    };
    let Some(file) = torrent.files.get(idx) else {
        return plain(StatusCode::NOT_FOUND, "file not found");
    };
    let (status, headers, start, end) = match range_head(req.headers(), file.len, util::mime_for(&file.name)) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if req.method() == Method::HEAD || file.len == 0 {
        return (status, headers).into_response();
    }
    let len = end - start + 1;

    // A finished file plays straight off disk, with no torrent bookkeeping in the way.
    if let Some(path) = torrent.path_of(idx) {
        if ENGINE.file_progress(&hash, idx).is_some_and(|(done, total, ..)| done >= total) {
            if let Ok(body) = file_body(&path, start, len).await {
                return (status, headers, body).into_response();
            }
        }
    }

    // A swarm with nobody in it (the Archive's torrents, mostly): give it a
    // moment to find someone, then read the file from its web seed instead.
    if handle.is_some() {
        if let Some(url) = torrent.web_url(idx) {
            if !ENGINE.swarm_alive(&hash).await {
                return proxy_web_seed(&url, status, headers, start, end, file.len).await;
            }
        }
    }

    match handle {
        Some(handle) => {
            let mut stream = match handle.stream(idx) {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!("could not open torrent stream: {err}");
                    return plain(StatusCode::SERVICE_UNAVAILABLE, "torrent not ready");
                }
            };
            if let Err(err) = stream.seek(SeekFrom::Start(start)).await {
                tracing::warn!("torrent seek failed: {err}");
                return plain(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
            }
            let body = Body::from_stream(ReaderStream::with_capacity(stream.take(len), 256 * 1024));
            (status, headers, body).into_response()
        }
        None => {
            let Some(url) = torrent.web_url(idx) else {
                return plain(StatusCode::NOT_FOUND, "no source for this file");
            };
            proxy_web_seed(&url, status, headers, start, end, file.len).await
        }
    }
}

async fn file_body(path: &std::path::Path, start: u64, len: u64) -> std::io::Result<Body> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(SeekFrom::Start(start)).await?;
    Ok(Body::from_stream(ReaderStream::with_capacity(f.take(len), 256 * 1024)))
}

/// Streams a byte range of a web-seeded file from its HTTP server.
async fn proxy_web_seed(url: &str, status: StatusCode, headers: HeaderMap, start: u64, end: u64, total: u64) -> Response {
    let res = util::http()
        .get(url)
        .header(header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await;
    match res {
        Ok(r) if r.status() == StatusCode::PARTIAL_CONTENT || (r.status().is_success() && start == 0 && end + 1 == total) => {
            let body = Body::from_stream(r.bytes_stream().map_err(std::io::Error::other));
            (status, headers, body).into_response()
        }
        Ok(r) => {
            tracing::warn!("web seed answered {} for {url}", r.status());
            plain(StatusCode::BAD_GATEWAY, "web seed unavailable")
        }
        Err(err) => {
            tracing::warn!("web seed request failed: {err}");
            plain(StatusCode::BAD_GATEWAY, "web seed unavailable")
        }
    }
}

#[derive(Deserialize)]
struct LocalQuery {
    p: String,
}

/// A file straight off disk — but only from the downloads, poster and library folders.
async fn local_file(Path(token): Path<String>, Query(q): Query<LocalQuery>, req: Request) -> Response {
    if !token_ok(&token) {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    let target = PathBuf::from(&q.p);
    let allowed = tokio::task::spawn_blocking({
        let target = target.clone();
        move || settings::is_local_media_path(&target)
    })
    .await
    .unwrap_or(false);
    if !allowed {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    let Ok(meta) = tokio::fs::metadata(&target).await else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    let name = target.to_string_lossy();
    let (status, headers, start, end) = match range_head(req.headers(), meta.len(), util::mime_for(&name)) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if req.method() == Method::HEAD || meta.len() == 0 {
        return (status, headers).into_response();
    }
    match file_body(&target, start, end - start + 1).await {
        Ok(body) => (status, headers, body).into_response(),
        Err(_) => plain(StatusCode::NOT_FOUND, "not found"),
    }
}

async fn transcode(Path(token): Path<String>, Query(q): Query<playback::TranscodeQuery>) -> Response {
    if !token_ok(&token) {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    playback::transcode_response(q).await
}

/// Waits for a URL on our own server to answer, for callers that race its startup.
pub async fn ready() {
    let _ = tokio::time::timeout(Duration::from_secs(5), server()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Range::Full);
        assert_eq!(parse_range(Some("bytes=0-"), 100), Range::Partial(0, 99));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Range::Partial(10, 19));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Range::Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Range::Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=-500"), 100), Range::Partial(0, 99));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1, 5-9"), 100), Range::Partial(0, 1));
    }
}
