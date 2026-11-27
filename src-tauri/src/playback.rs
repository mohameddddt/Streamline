//! Decides how a file plays and runs ffmpeg when the window cannot play it as is.
//!
//! The window's decoder covers H.264/VP9/AV1 video and AAC/Opus/MP3 audio.
//! Anything else goes through the bundled ffmpeg: the audio alone is converted
//! when only it is the problem (the common AC3 case, near-zero CPU), the video
//! too when it has to be (HEVC on machines without a HEVC decoder).

use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::OnceLock;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use anyhow::{bail, Context};
use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::Stream;
use serde::Deserialize;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, ChildStdout};
use tokio::sync::OnceCell;
use tokio_util::io::ReaderStream;

use crate::torrent::ENGINE;
use crate::types::{DecodeCaps, PlaybackPlan, PlaybackSource};
use crate::{server, settings, util};

const PLAYABLE_VIDEO: &[&str] = &["h264", "vp8", "vp9", "av1", "theora"];
const PLAYABLE_AUDIO: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac"];

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// The bundled tool, else one from a development checkout, else whatever is on PATH.
fn tool(name: &str) -> PathBuf {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut candidates = Vec::new();
    if let Some(dir) = RESOURCE_DIR.get() {
        candidates.push(dir.join("ffmpeg").join(&exe));
    }
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            candidates.push(dir.join("ffmpeg").join(&exe));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg").join(&exe));
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(exe))
}

// -------------------------------------------------------------------- probe

#[derive(Debug, Default)]
pub struct Probe {
    pub duration: f64,
    pub video_codec: String,
    pub audio_codec: String,
    pub container: String,
}

#[derive(Deserialize)]
struct FfprobeOut {
    #[serde(default)]
    streams: Vec<FfStream>,
    format: Option<FfFormat>,
}

#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
}

#[derive(Deserialize)]
struct FfFormat {
    duration: Option<String>,
    format_name: Option<String>,
}

pub async fn probe(input: &str) -> anyhow::Result<Probe> {
    let mut cmd = util::command(tool("ffprobe"));
    cmd.args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        // Over a torrent every probe byte is a piece fetched from peers first, so
        // these stay small: all we need is codecs, container and duration.
        .args(["-analyzeduration", "3000000", "-probesize", "2000000"])
        // An AVI keeps its index at the very end; reading it costs a seek across
        // the whole file (and over a torrent, its last pieces). The header has
        // what is needed.
        .args(["-fflags", "+ignidx"])
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let child = cmd.spawn().context("could not start ffprobe")?;
    util::adopt_child(&child);
    let out = tokio::time::timeout(Duration::from_secs(40), child.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("Timed out inspecting this file. It may still be buffering."))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(if err.is_empty() { format!("ffprobe exited {}", out.status) } else { err });
    }
    let data: FfprobeOut = serde_json::from_slice(&out.stdout).context("Could not read this file’s format.")?;
    let first = |kind: &str| {
        data.streams
            .iter()
            .find(|s| s.codec_type.as_deref() == Some(kind))
            .and_then(|s| s.codec_name.clone())
            .unwrap_or_default()
    };
    Ok(Probe {
        duration: data.format.as_ref().and_then(|f| f.duration.as_ref()?.parse().ok()).unwrap_or(0.0),
        video_codec: first("video"),
        audio_codec: first("audio"),
        container: data.format.and_then(|f| f.format_name).unwrap_or_default(),
    })
}

// --------------------------------------------------------- hardware encoders

fn encoder_args(name: &str) -> &'static [&'static str] {
    match name {
        "h264_nvenc" => &["-preset", "p4", "-tune", "ll", "-b:v", "6M"],
        "h264_qsv" => &["-preset", "veryfast", "-b:v", "6M"],
        "h264_amf" => &["-quality", "speed", "-b:v", "6M"],
        _ => &["-preset", "veryfast", "-crf", "23"],
    }
}

/// `ffmpeg -encoders` lists what was compiled in, not what this machine can
/// run, so each candidate encodes one real frame with the real flags.
async fn encoder_works(name: &str) -> bool {
    let mut cmd = util::command(tool("ffmpeg"));
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1"])
        .args(["-frames:v", "1", "-c:v", name])
        .args(encoder_args(name))
        .args(["-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return false };
    util::adopt_child(&child);
    matches!(tokio::time::timeout(Duration::from_secs(15), child.wait()).await, Ok(Ok(s)) if s.success())
}

static ENCODER: OnceCell<&'static str> = OnceCell::const_new();

/// Picked once, at startup, so the first conversion does not wait on the tests.
pub async fn video_encoder() -> &'static str {
    ENCODER
        .get_or_init(|| async {
            for candidate in ["h264_nvenc", "h264_qsv", "h264_amf"] {
                if encoder_works(candidate).await {
                    tracing::info!("video encoder: {candidate}");
                    return candidate;
                }
            }
            tracing::info!("video encoder: libx264");
            "libx264"
        })
        .await
}

// --------------------------------------------------------------------- plan

/// What ffmpeg reads (a local file is faster read straight off disk), what
/// the player reads, and the file name the container guess goes by.
async fn inputs(source: &PlaybackSource) -> anyhow::Result<(String, String, String)> {
    Ok(match source {
        PlaybackSource::Local { file_path } => {
            let path = PathBuf::from(file_path);
            (file_path.clone(), server::local_url(&path).await, file_path.clone())
        }
        PlaybackSource::Url { url } => {
            let name = url::Url::parse(url).map(|u| u.path().to_string()).unwrap_or_default();
            (url.clone(), url.clone(), name)
        }
        PlaybackSource::Torrent { info_hash, file_idx } => {
            let t = ENGINE.get(info_hash).context("That torrent is no longer running. Pick the source again.")?;
            let name = t.files.get(*file_idx).map(|f| f.name.clone()).unwrap_or_default();
            let url = server::stream_url(info_hash, *file_idx).await;
            // No swarm: ffmpeg reads the web seed itself rather than through
            // our proxy, which saves a hop on every one of its range requests.
            let read_from = match t.web_url(*file_idx) {
                Some(seed) if !ENGINE.swarm_alive(info_hash).await => seed,
                _ => url.clone(),
            };
            (read_from, url, name)
        }
    })
}

async fn transcode_url(input: &str, copy_video: bool, copy_audio: bool, hevc: bool) -> anyhow::Result<String> {
    let mut url = url::Url::parse(&format!("{}/transcode", server::base().await))?;
    url.query_pairs_mut()
        .append_pair("src", input)
        .append_pair("v", if copy_video { "copy" } else { "encode" })
        .append_pair("a", if copy_audio { "copy" } else { "encode" })
        .append_pair("hevc", if hevc { "1" } else { "0" })
        .append_pair("t", "0");
    Ok(url.to_string())
}

/// Containers the window cannot open, whatever their codecs. WebM shares
/// Matroska's format name, so the file's extension tells the two apart.
fn needs_repackaging(container: &str, name: &str) -> bool {
    let c = container.to_lowercase();
    let ext = util::ext_lower(name);
    if c.is_empty() {
        return matches!(ext.as_str(), "mkv" | "avi" | "ts" | "m2ts" | "flv" | "wmv" | "mpg" | "mpeg");
    }
    let webm = ext == "webm";
    (c.contains("matroska") && !webm) || ["avi", "mpegts", "flv", "asf", "mpeg"].iter().any(|k| c.split(',').any(|p| p == *k))
}

pub async fn plan(source: &PlaybackSource, caps: &DecodeCaps) -> anyhow::Result<PlaybackPlan> {
    let (input, direct_url, name) = inputs(source).await?;
    let info = match probe(&input).await {
        Ok(info) => info,
        Err(err) => {
            tracing::warn!("probe failed: {err}");
            // A container the window cannot open would only fail in the player;
            // convert it blind instead. Anything else gets a try as it is.
            if needs_repackaging("", &name) {
                return Ok(PlaybackPlan {
                    mode: "transcode",
                    url: transcode_url(&input, false, false, false).await?,
                    direct_url,
                    duration: 0.0,
                    reason: "Could not inspect this file, so it is being converted.".into(),
                    video_codec: String::new(),
                    audio_codec: String::new(),
                });
            }
            return Ok(PlaybackPlan {
                mode: "direct",
                url: direct_url.clone(),
                direct_url,
                duration: 0.0,
                reason: "Could not inspect this file, playing it directly.".into(),
                video_codec: String::new(),
                audio_codec: String::new(),
            });
        }
    };
    let v = info.video_codec.as_str();
    let a = info.audio_codec.as_str();
    let hevc = v == "hevc" && caps.hevc;
    let video_ok = v.is_empty() || PLAYABLE_VIDEO.contains(&v) || hevc;
    let audio_ok = a.is_empty() || PLAYABLE_AUDIO.contains(&a) || (a == "ac3" && caps.ac3) || (a == "eac3" && caps.eac3);

    if video_ok && audio_ok && !needs_repackaging(&info.container, &name) {
        return Ok(PlaybackPlan {
            mode: "direct",
            url: direct_url.clone(),
            direct_url,
            duration: info.duration,
            reason: "Playing the original file.".into(),
            video_codec: info.video_codec,
            audio_codec: info.audio_codec,
        });
    }

    let mode = if video_ok { "remux" } else { "transcode" };
    let url = transcode_url(&input, video_ok, audio_ok, hevc).await?;
    let reason = if !video_ok {
        format!("Converting {} video in real time.", info.video_codec)
    } else if !audio_ok {
        format!("Repackaging on the fly ({} → AAC).", if a.is_empty() { "audio" } else { a })
    } else {
        "Repackaging on the fly for the player.".to_string()
    };
    Ok(PlaybackPlan {
        mode,
        url,
        direct_url,
        duration: info.duration,
        reason,
        video_codec: info.video_codec,
        audio_codec: info.audio_codec,
    })
}

// ---------------------------------------------------------------- transcode

#[derive(Deserialize)]
pub struct TranscodeQuery {
    src: String,
    #[serde(default)]
    v: String,
    #[serde(default)]
    a: String,
    #[serde(default)]
    hevc: String,
    #[serde(default)]
    t: String,
}

async fn allowed_source(src: &str) -> bool {
    if server::is_own_url(src).await {
        return true;
    }
    if src.starts_with("https://") || src.starts_with("http://") {
        return true; // a direct link an addon gave us
    }
    let path = PathBuf::from(src);
    path.is_absolute() && tokio::task::spawn_blocking(move || settings::is_local_media_path(&path)).await.unwrap_or(false)
}

/// ffmpeg's stdout as a response body. The child lives inside the body, so it
/// is killed the moment the player stops reading.
struct ChildBody {
    _child: Child,
    out: ReaderStream<ChildStdout>,
}

impl Stream for ChildBody {
    type Item = std::io::Result<Bytes>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.out).poll_next(cx)
    }
}

pub async fn transcode_response(q: TranscodeQuery) -> Response {
    if q.src.is_empty() || !allowed_source(&q.src).await {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let offset: f64 = q.t.parse().unwrap_or(0.0);
    let copy_video = q.v != "encode";
    let copy_audio = q.a != "encode";

    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
    if q.src.starts_with("http") && !server::is_own_url(&q.src).await {
        args.extend(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"].map(String::from));
    }
    if offset > 0.0 {
        args.extend(["-ss".into(), format!("{offset}")]);
    } else {
        // Starting from the top needs no index; an AVI's sits at the end of
        // the file, a long wait over a torrent or a slow web seed. Seeking
        // later restarts ffmpeg with the index read.
        args.extend(["-fflags", "+ignidx"].map(String::from));
    }
    args.extend(["-i".into(), q.src.clone(), "-map".into(), "0:v:0?".into(), "-map".into(), "0:a:0?".into()]);
    if copy_video {
        args.extend(["-c:v", "copy"].map(String::from));
        // The window only decodes HEVC in MP4 under the `hvc1` tag.
        if q.hevc == "1" {
            args.extend(["-tag:v", "hvc1"].map(String::from));
        }
    } else {
        let encoder = video_encoder().await;
        args.extend(["-c:v".to_string(), encoder.to_string()]);
        args.extend(encoder_args(encoder).iter().map(|s| s.to_string()));
        if encoder == "libx264" {
            // A CPU cannot convert 4K in real time; 1080p is what keeps up.
            args.extend(["-vf", "scale='min(1920,iw)':-2"].map(String::from));
        }
        args.extend(["-pix_fmt", "yuv420p"].map(String::from));
    }
    if copy_audio {
        args.extend(["-c:a", "copy"].map(String::from));
    } else {
        args.extend(["-c:a", "aac", "-ac", "2", "-b:a", "192k"].map(String::from));
    }
    args.extend(
        ["-sn", "-max_muxing_queue_size", "2048", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]
            .map(String::from),
    );

    let mut cmd = util::command(tool("ffmpeg"));
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            tracing::error!("ffmpeg spawn failed: {err}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "ffmpeg is missing").into_response();
        }
    };
    util::adopt_child(&child);
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    tracing::warn!("[ffmpeg] {}", line.chars().take(300).collect::<String>());
                }
            }
        });
    }
    let Some(stdout) = child.stdout.take() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "ffmpeg output unavailable").into_response();
    };
    let body = Body::from_stream(ChildBody { _child: child, out: ReaderStream::with_capacity(stdout, 256 * 1024) });
    // A live pipe: no Accept-Ranges, so the player will not try to seek into it.
    let mut resp = (StatusCode::OK, body).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containers() {
        assert!(needs_repackaging("matroska,webm", "Film.mkv"));
        assert!(!needs_repackaging("matroska,webm", "Tears of Steel.webm"));
        assert!(needs_repackaging("avi", "ed_hd.avi"));
        assert!(!needs_repackaging("mov,mp4,m4a,3gp,3g2,mj2", "a.mp4"));
        assert!(needs_repackaging("mpegts", "a.ts"));
    }
}
