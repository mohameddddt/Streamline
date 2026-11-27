//! Where the app keeps its files, and how JSON gets to and from disk.
//!
//! Every write goes to a temporary file that is then renamed over the real one,
//! so a crash or a full disk mid-write can never leave half a library behind.
//! A file that does not parse is set aside rather than overwritten: the old
//! Electron build fell back to an empty library and then saved that over the
//! damaged one, losing everything in it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Files already backed up this run; one `.bak` per launch is plenty.
static BACKED_UP: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// The same folder the Electron build used (`%APPDATA%\streamline`), so an
/// upgrade keeps its settings, library and downloads.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("STREAMLINE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("streamline")
}

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = DATA_DIR.set(dir);
}

pub fn data_dir() -> &'static Path {
    DATA_DIR.get_or_init(default_data_dir)
}

pub fn path(name: &str) -> PathBuf {
    data_dir().join(name)
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

fn backup_of(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".bak");
    PathBuf::from(s)
}

/// Reads `name`, falling back to its `.bak` when the main copy is missing or damaged.
pub fn read_json<T: DeserializeOwned>(name: &str) -> Option<T> {
    let main = path(name);
    match fs::read(&main) {
        Ok(bytes) => match serde_json::from_slice::<T>(strip_bom(&bytes)) {
            Ok(value) => return Some(value),
            Err(err) => {
                tracing::warn!("{name} could not be read ({err}); keeping a copy and trying the backup");
                let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
                let _ = fs::copy(&main, main.with_extension(format!("damaged-{stamp}.json")));
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!("{name} could not be opened: {err}"),
    }
    let bytes = fs::read(backup_of(&main)).ok()?;
    serde_json::from_slice(strip_bom(&bytes)).ok()
}

/// Writes `name` atomically. `pretty` keeps the small hand-readable files readable.
pub fn write_json<T: Serialize + ?Sized>(name: &str, value: &T, pretty: bool) -> anyhow::Result<()> {
    let main = path(name);
    if let Some(dir) = main.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = if pretty {
        serde_json::to_vec_pretty(value)?
    } else {
        serde_json::to_vec(value)?
    };
    let backed = BACKED_UP.get_or_init(|| Mutex::new(HashSet::new()));
    if main.exists() && backed.lock().insert(name.to_string()) {
        let _ = fs::copy(&main, backup_of(&main));
    }
    let mut tmp = main.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, &main)?;
    Ok(())
}

/// Logs instead of failing: losing one progress tick is better than an error dialog.
pub fn save<T: Serialize + ?Sized>(name: &str, value: &T, pretty: bool) {
    if let Err(err) = write_json(name, value, pretty) {
        tracing::error!("could not save {name}: {err}");
    }
}
