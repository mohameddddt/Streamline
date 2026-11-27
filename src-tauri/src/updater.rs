//! Self-update from GitHub Releases: checks the latest release, downloads its
//! installer in the background (verified against the SHA-256 digest GitHub
//! publishes for each asset), and runs it on request or when the app quits.

use std::path::PathBuf;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context};
use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::util;

const REPO: &str = "mohameddddt/Streamline";

#[derive(Serialize, Clone, Debug)]
pub struct UpdateState {
    status: &'static str,
    version: String,
    notes: String,
    progress: f64,
}

static STATE: LazyLock<Mutex<UpdateState>> =
    LazyLock::new(|| Mutex::new(UpdateState { status: "idle", version: String::new(), notes: String::new(), progress: 0.0 }));
static APP: OnceLock<AppHandle> = OnceLock::new();
static INSTALLER: Mutex<Option<PathBuf>> = Mutex::new(None);
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn state() -> UpdateState {
    STATE.lock().clone()
}

fn set(f: impl FnOnce(&mut UpdateState)) {
    let snapshot = {
        let mut s = STATE.lock();
        f(&mut s);
        s.clone()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("update:state", snapshot);
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

fn version_parts(v: &str) -> Vec<u64> {
    v.trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    version_parts(candidate) > version_parts(current)
}

pub async fn check(silent: bool) -> UpdateState {
    if cfg!(debug_assertions) {
        set(|s| {
            s.status = "dev";
            s.notes = "Updates only apply to the installed app.".into();
        });
        return state();
    }
    let Ok(_guard) = CHECKING.try_lock() else { return state() };
    if matches!(state().status, "ready" | "downloading") {
        return state();
    }
    set(|s| s.status = "checking");
    if let Err(err) = check_inner().await {
        if silent {
            set(|s| s.status = "idle");
        } else {
            set(|s| {
                s.status = "error";
                s.notes = err.to_string();
            });
        }
    }
    state()
}

async fn check_inner() -> anyhow::Result<()> {
    let release: Release = util::http()
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let current = env!("CARGO_PKG_VERSION");
    if release.draft || release.prerelease || !is_newer(&release.tag_name, current) {
        set(|s| {
            s.status = "current";
            s.version = current.into();
        });
        return Ok(());
    }
    let asset = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            n.ends_with(".exe") && n.contains("setup")
        })
        .context("The latest release has no Windows installer.")?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    let notes = release.body.clone().unwrap_or_default();
    set(|s| {
        s.status = "downloading";
        s.version = version.clone();
        s.progress = 0.0;
    });

    let dir = std::env::temp_dir().join("streamline-update");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(util::safe_file_name(&asset.name));
    let res = util::http().get(&asset.browser_download_url).send().await?.error_for_status()?;
    let total = res.content_length().unwrap_or(asset.size).max(1);
    let mut file = tokio::fs::File::create(&path).await?;
    let mut hasher = Sha256::new();
    let mut got = 0u64;
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        got += chunk.len() as u64;
        let progress = got as f64 / total as f64;
        set(|s| s.progress = progress.min(1.0));
    }
    file.flush().await?;
    drop(file);
    if let Some(expected) = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        let actual = hex::encode(hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&path).await;
            bail!("The downloaded update did not match its checksum; it was discarded.");
        }
    }
    *INSTALLER.lock() = Some(path);
    set(|s| {
        s.status = "ready";
        s.notes = notes;
        s.progress = 1.0;
    });
    Ok(())
}

fn run_installer(args: &[&str]) -> bool {
    let Some(path) = INSTALLER.lock().take() else { return false };
    match std::process::Command::new(&path).args(args).spawn() {
        Ok(_) => true,
        Err(err) => {
            tracing::error!("could not start the installer: {err}");
            false
        }
    }
}

/// Restarts into the new version. Only valid once the status is `ready`.
pub fn install_now(app: &AppHandle) {
    if state().status != "ready" {
        return;
    }
    if run_installer(&["/P", "/R"]) {
        app.exit(0);
    }
}

/// A downloaded update installs quietly as the app closes.
pub fn install_on_quit() {
    if state().status == "ready" {
        run_installer(&["/S"]);
    }
}

pub fn check_on_startup() {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(8)).await;
        check(true).await;
    });
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn versions() {
        assert!(is_newer("v0.5.1", "0.5.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("v0.5.0", "0.5.0"));
        assert!(!is_newer("0.4.2", "0.5.0"));
    }
}
