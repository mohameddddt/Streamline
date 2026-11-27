//! Wire types shared with the renderer; field names match src/shared/types.ts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorHints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binge_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_idx: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_hints: Option<BehaviorHints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addon_name: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Stream {
    pub fn filename_hint(&self) -> Option<&str> {
        self.behavior_hints.as_ref()?.filename.as_deref()
    }

    pub fn file_index(&self) -> Option<usize> {
        self.file_idx.and_then(|i| usize::try_from(i).ok())
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TorrentHandle {
    pub url: String,
    pub info_hash: String,
    pub file_idx: usize,
    pub file_name: String,
    pub file_length: u64,
    pub mime: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStats {
    pub info_hash: String,
    pub progress: f64,
    pub downloaded: u64,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub peers: usize,
    pub ready: bool,
    pub file_progress: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaybackSource {
    #[serde(rename = "torrent", rename_all = "camelCase")]
    Torrent { info_hash: String, file_idx: usize },
    #[serde(rename = "local", rename_all = "camelCase")]
    Local { file_path: String },
    #[serde(rename = "url")]
    Url { url: String },
}

/// What this window's decoder handles beyond the baseline, reported by the renderer.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DecodeCaps {
    pub hevc: bool,
    pub ac3: bool,
    pub eac3: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPlan {
    pub mode: &'static str,
    pub url: String,
    /// The untouched file, for an external player that decodes everything itself.
    pub direct_url: String,
    pub duration: f64,
    pub reason: String,
    pub video_codec: String,
    pub audio_codec: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub title: String,
    pub meta_id: String,
    pub meta_type: String,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    #[serde(default)]
    pub video_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    /// `infoHash:fileIdx` — one torrent can hold several downloads (a season pack).
    #[serde(default)]
    pub id: String,
    pub info_hash: String,
    pub file_idx: usize,
    #[serde(default)]
    pub magnet: String,
    pub title: String,
    pub meta_id: String,
    pub meta_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    pub file_name: String,
    pub file_path: String,
    pub length: u64,
    pub added_at: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_file: Option<String>,
    /// Filled in when listed; never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_poster: Option<String>,
    /// The stream it came from, so a download can be re-added from scratch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub info_hash: String,
    pub progress: f64,
    pub downloaded: u64,
    pub download_speed: f64,
    pub peers: usize,
    pub time_remaining: f64,
}
