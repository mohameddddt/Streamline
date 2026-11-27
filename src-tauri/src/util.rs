//! Small things every module needs: time, tokens, paths, the HTTP client and
//! child processes that never outlive the app.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;

pub type CmdResult<T> = Result<T, String>;

/// Turns any error into the message the renderer shows.
pub fn err_text(err: impl std::fmt::Display) -> String {
    err.to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `n` random bytes as URL-safe base64, like Node's `randomBytes(n).toString('base64url')`.
pub fn random_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// Compares secrets without leaking how much of them matched.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// --------------------------------------------------------------- network

static ONLINE: AtomicBool = AtomicBool::new(true);

/// The window reports `navigator.onLine` as it changes; `STREAMLINE_OFFLINE=1`
/// forces offline, to try the offline paths without pulling the cable.
pub fn set_online(online: bool) {
    ONLINE.store(online, Ordering::Relaxed);
}

pub fn is_offline() -> bool {
    std::env::var("STREAMLINE_OFFLINE").is_ok_and(|v| v == "1") || !ONLINE.load(Ordering::Relaxed)
}

pub fn user_agent() -> String {
    format!("Streamline/{}", env!("CARGO_PKG_VERSION"))
}

/// One shared client: its connection pool is what makes repeat requests fast.
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(user_agent())
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .expect("http client")
    })
}

/// GET a JSON document with a deadline. `Ok(None)` for a 404.
pub async fn get_json<T: serde::de::DeserializeOwned>(url: &str, timeout: Duration) -> anyhow::Result<Option<T>> {
    let res = http()
        .get(url)
        .header("accept", "application/json")
        .timeout(timeout)
        .send()
        .await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        anyhow::bail!("{} for {url}", res.status());
    }
    Ok(Some(res.json::<T>().await?))
}

// ------------------------------------------------------------------ paths

/// True when `target` is `root` or somewhere below it. Both are resolved
/// first, so `..` segments and different spellings cannot sneak out.
pub fn is_inside(root: &Path, target: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return false;
    }
    match (std::fs::canonicalize(root), std::fs::canonicalize(target)) {
        (Ok(root), Ok(target)) => target.starts_with(root),
        _ => false,
    }
}

/// A torrent's name made safe as a Windows folder name.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "download".into()
    } else {
        trimmed
    }
}

/// Removes empty folders from `from`'s parent up to, but not including, `root`.
pub fn prune_empty_dirs(root: &Path, from: &Path) {
    let Ok(root) = std::fs::canonicalize(root) else { return };
    let mut dir: Option<PathBuf> = from.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        let Ok(canon) = std::fs::canonicalize(&d) else { return };
        if canon == root || !canon.starts_with(&root) {
            return;
        }
        if std::fs::remove_dir(&d).is_err() {
            return; // not empty, or in use
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

pub fn ext_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

const VIDEO_EXT: &[&str] = &[
    "mp4", "mkv", "avi", "webm", "mov", "m4v", "mpg", "mpeg", "flv", "ts", "m2ts", "wmv", "ogv",
];

pub fn is_video(name: &str) -> bool {
    VIDEO_EXT.contains(&ext_lower(name).as_str())
}

pub fn mime_for(name: &str) -> &'static str {
    match ext_lower(name).as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "ts" | "m2ts" => "video/mp2t",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "img" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// `1.2 GB` / `640 MB`, the form the source parser reads sizes from.
pub fn size_label(bytes: u64) -> String {
    let gb = 1024f64.powi(3);
    if bytes as f64 >= gb {
        format!("{:.2} GB", bytes as f64 / gb)
    } else {
        format!("{} MB", ((bytes as f64 / 1024f64.powi(2)).round() as u64).max(1))
    }
}

// -------------------------------------------------------- child processes

/// A console program started from a GUI app on Windows flashes a console
/// window unless told not to.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);
    cmd
}

/// Ties a child to a Windows job object that kills it when this process ends —
/// even on a crash — so no ffmpeg is ever left converting in the background.
pub fn adopt_child(child: &tokio::process::Child) {
    #[cfg(windows)]
    if let Some(handle) = child.raw_handle() {
        job::assign(handle as isize);
    }
    #[cfg(not(windows))]
    let _ = child;
}

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(isize);
    // The handle is only ever passed to thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(handle as isize))
        })
        .as_ref()
    }

    pub fn assign(process: isize) {
        if let Some(job) = job() {
            unsafe {
                AssignProcessToJobObject(job.0 as _, process as _);
            }
        }
    }
}

// --------------------------------------------------------------- power

/// Keeps the display awake while something plays. Execution state belongs to
/// a thread on Windows, so one long-lived thread owns it.
pub fn keep_awake(on: bool) {
    #[cfg(windows)]
    {
        use std::sync::mpsc;
        static TX: OnceLock<mpsc::Sender<bool>> = OnceLock::new();
        let tx = TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::Builder::new()
                .name("keep-awake".into())
                .spawn(move || {
                    use windows_sys::Win32::System::Power::{
                        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
                    };
                    for on in rx {
                        unsafe {
                            if on {
                                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
                            } else {
                                SetThreadExecutionState(ES_CONTINUOUS);
                            }
                        }
                    }
                })
                .expect("keep-awake thread");
            tx
        });
        let _ = tx.send(on);
    }
    #[cfg(not(windows))]
    let _ = on;
}
