//! A small JSON API that lets the Streamline web app, open in a browser on
//! this machine, use this app's torrent engine and converter — browsers
//! cannot talk to torrent peers themselves.
//!
//! Off until switched on in Settings, loopback only, and every call needs the
//! token shown in Settings, so other sites open in the browser cannot drive it.

use std::sync::LazyLock;

use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::settings::{self, COMPANION_PORT};
use crate::torrent::ENGINE;
use crate::types::{DecodeCaps, PlaybackSource, Stream};
use crate::{playback, subtitles, util};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    role: &'static str,
    enabled: bool,
    url: String,
    token: String,
    connected: bool,
    version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct State {
    stop: Option<oneshot::Sender<()>>,
    error: Option<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State { stop: None, error: None }));

pub fn info() -> CompanionInfo {
    let s = settings::get();
    let st = STATE.lock();
    CompanionInfo {
        role: "host",
        enabled: st.stop.is_some(),
        url: format!("http://127.0.0.1:{COMPANION_PORT}"),
        token: s.companion_token,
        connected: st.stop.is_some(),
        version: env!("CARGO_PKG_VERSION"),
        error: st.error.clone(),
    }
}

fn with_cors(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
    // Chrome asks before a public page may reach a loopback address.
    h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    resp
}

fn send(status: StatusCode, body: Value) -> Response {
    let mut resp = (status, axum::Json(body)).into_response();
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn error(status: StatusCode, msg: impl ToString) -> Response {
    send(status, json!({ "error": msg.to_string() }))
}

fn token_ok(req: &Request) -> bool {
    let expected = format!("Bearer {}", settings::get().companion_token);
    let given = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    util::constant_time_eq(given.as_bytes(), expected.as_bytes())
}

async fn body_json<T: for<'de> Deserialize<'de>>(req: Request) -> Result<T, Response> {
    let bytes = to_bytes(req.into_body(), 1_000_000)
        .await
        .map_err(|_| error(StatusCode::PAYLOAD_TOO_LARGE, "request too large"))?;
    let raw = if bytes.is_empty() { &b"{}"[..] } else { &bytes[..] };
    serde_json::from_slice(raw).map_err(|_| error(StatusCode::BAD_REQUEST, "invalid JSON"))
}

fn query(req: &Request, key: &str) -> String {
    req.uri()
        .query()
        .and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned()))
        .unwrap_or_default()
}

async fn route(req: Request) -> Response {
    if req.method() == Method::OPTIONS {
        return with_cors(StatusCode::NO_CONTENT.into_response());
    }
    if !token_ok(&req) {
        return with_cors(error(StatusCode::UNAUTHORIZED, "Wrong or missing companion token."));
    }
    let key = format!("{} {}", req.method(), req.uri().path());
    let resp = match key.as_str() {
        "GET /api/hello" => send(StatusCode::OK, json!({ "app": "streamline", "version": env!("CARGO_PKG_VERSION") })),
        "POST /api/torrent/warm" => match ENGINE.warm().await {
            Ok(()) => send(StatusCode::OK, json!({})),
            Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
        },
        "POST /api/torrent/start" => {
            #[derive(Deserialize)]
            struct B {
                stream: Stream,
            }
            match body_json::<B>(req).await {
                Err(r) => r,
                Ok(b) => match ENGINE.start_stream(&b.stream).await {
                    Ok(h) => send(StatusCode::OK, serde_json::to_value(h).unwrap_or_default()),
                    Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
                },
            }
        }
        "GET /api/torrent/stats" => send(StatusCode::OK, serde_json::to_value(ENGINE.stats(&query(&req, "h"))).unwrap_or_default()),
        "POST /api/torrent/remove" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct B {
                info_hash: String,
            }
            match body_json::<B>(req).await {
                Err(r) => r,
                Ok(b) => {
                    ENGINE.release(&b.info_hash);
                    send(StatusCode::OK, json!({}))
                }
            }
        }
        "POST /api/playback/plan" => {
            #[derive(Deserialize)]
            struct B {
                source: PlaybackSource,
                #[serde(default)]
                caps: DecodeCaps,
            }
            match body_json::<B>(req).await {
                Err(r) => r,
                // Files on disk are the desktop app's business; never serve paths here.
                Ok(B { source: PlaybackSource::Local { .. }, .. }) => {
                    error(StatusCode::BAD_REQUEST, "Only torrent and link sources can be planned remotely.")
                }
                Ok(b) => match playback::plan(&b.source, &b.caps).await {
                    Ok(p) => send(StatusCode::OK, serde_json::to_value(p).unwrap_or_default()),
                    Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
                },
            }
        }
        "GET /api/subtitles/vtt" => match subtitles::fetch_vtt(&query(&req, "url")).await {
            Ok(vtt) => {
                let mut r = (StatusCode::OK, Body::from(vtt)).into_response();
                r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/vtt; charset=utf-8"));
                r
            }
            Err(e) => error(StatusCode::BAD_REQUEST, e),
        },
        _ => error(StatusCode::NOT_FOUND, "not found"),
    };
    with_cors(resp)
}

async fn start() -> anyhow::Result<()> {
    if STATE.lock().stop.is_some() {
        return Ok(());
    }
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", COMPANION_PORT)).await {
        Ok(l) => l,
        Err(err) => {
            let msg = format!("Could not listen on port {COMPANION_PORT}: {err}");
            STATE.lock().error = Some(msg.clone());
            anyhow::bail!(msg);
        }
    };
    let (tx, rx) = oneshot::channel::<()>();
    let app = Router::new().fallback(route);
    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = serve.await {
            tracing::warn!("companion stopped: {err}");
        }
    });
    let mut st = STATE.lock();
    st.stop = Some(tx);
    st.error = None;
    tracing::info!("companion listening on http://127.0.0.1:{COMPANION_PORT}");
    Ok(())
}

pub fn stop() {
    if let Some(tx) = STATE.lock().stop.take() {
        let _ = tx.send(());
    }
}

/// Brings the server in line with the setting.
pub async fn sync() -> CompanionInfo {
    if settings::get().companion_enabled {
        if let Err(err) = start().await {
            tracing::warn!("{err}");
        }
    } else {
        stop();
    }
    info()
}
