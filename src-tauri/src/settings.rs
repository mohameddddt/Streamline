//! Settings on disk (`settings.json`), in the same shape the renderer's
//! `Settings` type describes. Keys this build does not know are carried along
//! untouched, so a newer or older version never strips each other's settings.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{store, util};

const FILE: &str = "settings.json";

pub const BUILTIN_ARCHIVE: &str = "streamline://archive/manifest.json";
pub const BUILTIN_OPEN_MOVIES: &str = "streamline://open-movies/manifest.json";
pub const BUILTIN_LOCAL: &str = "streamline://local/manifest.json";

/// Mirrors `portableDefaults()` in src/shared/config.ts — keep the two in step.
const DEFAULT_ADDONS: &[&str] = &[
    "https://v3-cinemeta.strem.io/manifest.json",
    "https://torrentio.strem.fun/manifest.json",
    "https://torrentsdb.com/manifest.json",
    "https://opensubtitles-v3.strem.io/manifest.json",
];

pub const COMPANION_PORT: u16 = 11480;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub addons: Vec<String>,
    pub debrid_provider: String,
    pub debrid_api_key: String,
    pub tmdb_api_key: String,
    pub download_path: String,
    pub downloads_path: String,
    pub external_player_path: String,
    pub max_conns: u32,
    pub download_limit: u64,
    pub upload_limit: u64,
    pub delete_on_exit: bool,
    pub preferred_lang: String,
    pub trakt_client_id: String,
    pub trakt_client_secret: String,
    pub trakt_token: String,
    pub trakt_refresh: String,
    pub simkl_client_id: String,
    pub simkl_token: String,
    pub auto_update: bool,
    pub accent: String,
    pub preferred_quality: String,
    pub autoplay_next: bool,
    pub companion_enabled: bool,
    pub companion_token: String,
    pub engine_url: String,
    pub engine_token: String,
    pub local_folders: Vec<String>,
    pub builtins_seeded: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The cache streams are written to. Only this exact folder is ever wiped whole.
pub fn default_cache_dir() -> PathBuf {
    std::env::temp_dir().join("streamline")
}

impl Default for Settings {
    fn default() -> Self {
        let downloads = dirs::download_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"))
            .join("Streamline");
        Self {
            addons: DEFAULT_ADDONS.iter().map(|s| s.to_string()).collect(),
            debrid_provider: "none".into(),
            debrid_api_key: String::new(),
            tmdb_api_key: String::new(),
            download_path: default_cache_dir().to_string_lossy().into_owned(),
            downloads_path: downloads.to_string_lossy().into_owned(),
            external_player_path: String::new(),
            max_conns: 80,
            download_limit: 0,
            upload_limit: 262_144,
            delete_on_exit: true,
            preferred_lang: "eng".into(),
            trakt_client_id: String::new(),
            trakt_client_secret: String::new(),
            trakt_token: String::new(),
            trakt_refresh: String::new(),
            simkl_client_id: String::new(),
            simkl_token: String::new(),
            auto_update: true,
            accent: "volt".into(),
            preferred_quality: "1080p".into(),
            autoplay_next: true,
            companion_enabled: false,
            companion_token: String::new(),
            engine_url: format!("http://127.0.0.1:{COMPANION_PORT}"),
            engine_token: String::new(),
            local_folders: Vec::new(),
            builtins_seeded: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl Settings {
    pub fn cache_dir(&self) -> PathBuf {
        if self.download_path.trim().is_empty() {
            default_cache_dir()
        } else {
            PathBuf::from(&self.download_path)
        }
    }

    pub fn downloads_dir(&self) -> PathBuf {
        if self.downloads_path.trim().is_empty() {
            PathBuf::from(Settings::default().downloads_path)
        } else {
            PathBuf::from(&self.downloads_path)
        }
    }
}

static SETTINGS: OnceLock<RwLock<Settings>> = OnceLock::new();

fn cell() -> &'static RwLock<Settings> {
    SETTINGS.get_or_init(|| {
        let mut s: Settings = store::read_json(FILE).unwrap_or_default();
        let mut dirty = seed_builtins(&mut s, &[BUILTIN_ARCHIVE, BUILTIN_OPEN_MOVIES, BUILTIN_LOCAL]);
        // The companion token is a secret; mint one the first time it is needed.
        if s.companion_token.is_empty() {
            s.companion_token = util::random_token(18);
            dirty = true;
        }
        if dirty {
            store::save(FILE, &s, true);
        }
        RwLock::new(s)
    })
}

/// Installs each built-in the first time this copy sees it, and remembers
/// having done so, so one the user removed stays removed.
fn seed_builtins(s: &mut Settings, available: &[&str]) -> bool {
    let fresh: Vec<&str> = available
        .iter()
        .copied()
        .filter(|u| !s.builtins_seeded.iter().any(|x| x == u))
        .collect();
    if fresh.is_empty() {
        return false;
    }
    for url in &fresh {
        if !s.addons.iter().any(|a| a == url) {
            s.addons.push(url.to_string());
        }
        s.builtins_seeded.push(url.to_string());
    }
    true
}

pub fn get() -> Settings {
    cell().read().clone()
}

/// Applies a partial update from the renderer: only the keys it sent change.
pub fn patch(patch: Value) -> anyhow::Result<Settings> {
    let Value::Object(patch) = patch else {
        anyhow::bail!("settings patch must be an object");
    };
    let mut guard = cell().write();
    let mut current = serde_json::to_value(&*guard)?;
    if let Value::Object(map) = &mut current {
        for (k, v) in patch {
            map.insert(k, v);
        }
    }
    let next: Settings = serde_json::from_value(current)?;
    *guard = next.clone();
    store::save(FILE, &next, true);
    Ok(next)
}

pub fn update(f: impl FnOnce(&mut Settings)) -> Settings {
    let mut guard = cell().write();
    f(&mut guard);
    store::save(FILE, &*guard, true);
    guard.clone()
}

pub fn posters_dir() -> PathBuf {
    store::path("posters")
}

/// Files the local server may hand out: downloads, their posters, and the
/// library folders picked in Settings.
pub fn is_local_media_path(target: &Path) -> bool {
    let s = get();
    let mut roots = vec![s.downloads_dir(), posters_dir(), s.cache_dir()];
    roots.extend(s.local_folders.iter().map(PathBuf::from));
    roots.iter().any(|root| util::is_inside(root, target))
}
