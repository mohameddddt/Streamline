//! Streamline's desktop backend: window, commands, and the work that runs
//! behind them. The renderer reaches all of it through `window.api`
//! (src/desktop/api.ts), which turns each call into one of these commands.
//!
//! Commands are `async` so they run on the worker pool: Tauri runs plain
//! `fn` commands on the UI thread, where a disk write would stall the window.

mod companion;
mod downloads;
mod importer;
mod library;
mod local;
mod playback;
mod server;
mod settings;
mod storage;
mod store;
mod subtitles;
mod torrent;
mod trackers;
mod types;
mod updater;
mod util;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use library::{LibraryItem, ProgressEntry, RatingEntry, WatchChange};
use torrent::ENGINE;
use types::{DecodeCaps, DownloadInfo, PlaybackSource, Stream};
use util::{err_text, CmdResult};

// ------------------------------------------------------------------ dialogs

async fn pick_folder(app: &AppHandle) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    rx.await.ok().flatten().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

async fn pick_files(app: &AppHandle, name: &str, exts: &[&str], many: bool) -> Vec<PathBuf> {
    let (tx, rx) = oneshot::channel();
    let dialog = app.dialog().file().add_filter(name, exts);
    if many {
        dialog.pick_files(move |f| {
            let _ = tx.send(f.unwrap_or_default());
        });
    } else {
        dialog.pick_file(move |f| {
            let _ = tx.send(f.into_iter().collect());
        });
    }
    rx.await.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
}

async fn save_file(app: &AppHandle, suggested: &str, name: &str, exts: &[&str]) -> Option<PathBuf> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().set_file_name(suggested).add_filter(name, exts).save_file(move |f| {
        let _ = tx.send(f);
    });
    rx.await.ok().flatten().and_then(|f| f.into_path().ok())
}

// ----------------------------------------------------------------- settings

#[tauri::command]
async fn settings_get() -> settings::Settings {
    settings::get()
}

#[tauri::command]
async fn settings_set(patch: Value) -> CmdResult<settings::Settings> {
    let keys: Vec<String> = patch.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let next = settings::patch(patch).map_err(err_text)?;
    ENGINE.apply_limits(&next);
    if keys.iter().any(|k| k == "companionEnabled") {
        companion::sync().await;
    }
    if keys.iter().any(|k| k == "localFolders") {
        tauri::async_runtime::spawn(local::rescan());
    }
    Ok(next)
}

#[tauri::command]
async fn settings_pick_folder(app: AppHandle) -> Option<String> {
    pick_folder(&app).await
}

#[tauri::command]
async fn settings_pick_file(app: AppHandle) -> Option<String> {
    pick_files(&app, "Applications", &["exe", "bat", "cmd"], false)
        .await
        .into_iter()
        .next()
        .map(|p| p.to_string_lossy().into_owned())
}

// -------------------------------------------------------------------- local

#[tauri::command]
async fn local_status() -> local::LocalStatus {
    local::status()
}

#[tauri::command]
async fn local_rescan() -> local::LocalStatus {
    local::rescan().await
}

#[tauri::command]
async fn local_catalog(kind: String, extra: Option<Map<String, Value>>) -> Vec<Value> {
    local::catalog(&kind, &extra.unwrap_or_default()).await
}

#[tauri::command]
async fn local_meta(id: String) -> Option<Value> {
    local::meta(&id)
}

#[tauri::command]
async fn local_streams(kind: String, id: String) -> Vec<Value> {
    local::streams(&kind, &id).await
}

#[tauri::command]
async fn local_subtitles(kind: String, id: String) -> Vec<Value> {
    local::subtitles(&kind, &id).await
}

// ------------------------------------------------------------------ torrent

#[tauri::command]
async fn torrent_warm() -> CmdResult<()> {
    ENGINE.warm().await.map_err(err_text)
}

#[tauri::command]
async fn torrent_start(stream: Stream) -> CmdResult<types::TorrentHandle> {
    ENGINE.start_stream(&stream).await.map_err(err_text)
}

#[tauri::command]
async fn torrent_stats(info_hash: String) -> Option<types::TorrentStats> {
    ENGINE.stats(&info_hash)
}

/// Called when the player closes: lets a stream rest. Downloads keep going.
#[tauri::command]
async fn torrent_remove(info_hash: String) {
    ENGINE.release(&info_hash)
}

// ------------------------------------------------------------------ library

#[tauri::command]
async fn library_get() -> library::LibraryList {
    library::list()
}

#[tauri::command]
async fn library_toggle_favorite(item: LibraryItem) -> bool {
    library::toggle_favorite(item)
}

#[tauri::command]
async fn library_set_progress(entry: ProgressEntry) {
    library::set_progress(entry)
}

#[tauri::command]
async fn library_clear_progress(key: String) {
    library::clear_progress(&key)
}

#[tauri::command]
async fn library_mark_watched(key: String, watched: bool, seed: Option<ProgressEntry>) {
    library::mark_watched(&key, watched, seed)
}

#[tauri::command]
async fn library_mark_many_watched(changes: Vec<WatchChange>) {
    library::mark_many_watched(changes)
}

#[tauri::command]
async fn library_set_rating(entry: RatingEntry, rating: Option<f64>) {
    library::set_rating(entry, rating)
}

#[tauri::command]
async fn library_get_last_stream(key: String) -> Option<Value> {
    library::get_last_stream(&key)
}

#[tauri::command]
async fn library_set_last_stream(key: String, stream: Value) {
    library::set_last_stream(&key, stream)
}

#[derive(serde::Serialize)]
struct Count {
    count: usize,
}

#[tauri::command]
async fn library_backup(app: AppHandle) -> CmdResult<Option<Count>> {
    let stamp = chrono::Local::now().format("%Y-%m-%d");
    let Some(path) = save_file(&app, &format!("streamline-library-{stamp}.json"), "Streamline backup", &["json"]).await else {
        return Ok(None);
    };
    let backup = library::make_backup();
    let count = backup.items.len() + backup.progress.len() + backup.ratings.len();
    std::fs::write(&path, serde_json::to_vec_pretty(&backup).map_err(err_text)?).map_err(err_text)?;
    Ok(Some(Count { count }))
}

#[tauri::command]
async fn library_restore(app: AppHandle) -> CmdResult<Option<Count>> {
    let Some(path) = pick_files(&app, "Streamline backup", &["json"], false).await.into_iter().next() else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(err_text)?;
    let backup: library::LibraryBackup =
        serde_json::from_slice(&bytes).map_err(|_| "That file is not a Streamline backup.".to_string())?;
    Ok(Some(Count { count: library::merge_backup(backup).map_err(err_text)? }))
}

// ---------------------------------------------------------------- companion

#[tauri::command]
async fn companion_info() -> companion::CompanionInfo {
    companion::info()
}

#[derive(Deserialize)]
struct CompanionPatch {
    enabled: Option<bool>,
    regenerate: Option<bool>,
}

#[tauri::command]
async fn companion_configure(patch: CompanionPatch) -> companion::CompanionInfo {
    if patch.regenerate == Some(true) {
        settings::update(|s| s.companion_token = util::random_token(18));
    }
    if let Some(enabled) = patch.enabled {
        settings::update(|s| s.companion_enabled = enabled);
    }
    companion::sync().await
}

// ------------------------------------------------------------------- import

#[tauri::command]
async fn import_pick_files(app: AppHandle) -> Vec<String> {
    pick_files(&app, "Exports", &["zip", "csv"], true)
        .await
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
async fn import_start(service: String, paths: Vec<String>) -> CmdResult<()> {
    importer::start(service, paths).map_err(err_text)
}

#[tauri::command]
async fn import_status() -> importer::ImportStatus {
    importer::status()
}

// ---------------------------------------------------------------- downloads

#[tauri::command]
async fn downloads_list() -> Vec<types::DownloadRecord> {
    downloads::list().await
}

#[tauri::command]
async fn downloads_progress() -> Vec<types::DownloadProgress> {
    downloads::progress()
}

#[tauri::command]
async fn downloads_start(stream: Stream, info: DownloadInfo) -> CmdResult<types::DownloadRecord> {
    downloads::start(stream, info).await.map_err(err_text)
}

#[tauri::command]
async fn downloads_pause(id: String) -> CmdResult<()> {
    downloads::pause(&id).await.map_err(err_text)
}

#[tauri::command]
async fn downloads_resume(id: String) -> CmdResult<()> {
    downloads::resume(&id).await.map_err(err_text)
}

#[tauri::command]
async fn downloads_remove(id: String, delete_files: bool) -> CmdResult<()> {
    downloads::remove(&id, delete_files).await.map_err(err_text)
}

#[tauri::command]
async fn downloads_play_source(id: String) -> CmdResult<PlaybackSource> {
    downloads::play_source(&id).await.map_err(err_text)
}

#[tauri::command]
async fn downloads_open_folder(app: AppHandle) -> CmdResult<bool> {
    let dir = settings::get().downloads_dir();
    std::fs::create_dir_all(&dir).map_err(err_text)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(err_text)?;
    Ok(true)
}

#[tauri::command]
async fn downloads_reveal(app: AppHandle, id: String) -> CmdResult<bool> {
    let path = downloads::file_path_for(&id).ok_or("That download is no longer in your library.")?;
    let path = PathBuf::from(path);
    if path.exists() {
        app.opener().reveal_item_in_dir(&path).map_err(err_text)?;
    } else {
        let dir = path.parent().map(PathBuf::from).unwrap_or_else(|| settings::get().downloads_dir());
        std::fs::create_dir_all(&dir).map_err(err_text)?;
        app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(err_text)?;
    }
    Ok(true)
}

// ----------------------------------------------------------------- playback

#[tauri::command]
async fn playback_plan(source: PlaybackSource, caps: Option<DecodeCaps>) -> CmdResult<types::PlaybackPlan> {
    playback::plan(&source, &caps.unwrap_or_default()).await.map_err(err_text)
}

#[tauri::command]
async fn subtitle_vtt(url: String) -> CmdResult<String> {
    subtitles::fetch_vtt(&url).await.map_err(err_text)
}

// ----------------------------------------------------------------- trackers

#[tauri::command]
async fn trackers_status() -> trackers::TrackerStatus {
    trackers::status()
}

#[tauri::command]
async fn trackers_disconnect(name: String) {
    trackers::disconnect(&name)
}

#[tauri::command]
async fn trakt_start() -> CmdResult<trackers::DeviceAuth> {
    trackers::trakt_start().await.map_err(err_text)
}

#[tauri::command]
async fn trakt_poll(auth: trackers::DeviceAuth) -> CmdResult<bool> {
    trackers::trakt_poll(auth).await.map_err(err_text)
}

#[tauri::command]
async fn simkl_start() -> CmdResult<trackers::DeviceAuth> {
    trackers::simkl_start().await.map_err(err_text)
}

#[tauri::command]
async fn simkl_poll(auth: trackers::DeviceAuth) -> CmdResult<bool> {
    trackers::simkl_poll(auth).await.map_err(err_text)
}

#[tauri::command]
async fn trackers_scrobble(action: String, entry: ProgressEntry) {
    trackers::scrobble(&action, entry).await
}

#[derive(serde::Serialize)]
struct Exported {
    path: String,
    count: usize,
}

#[tauri::command]
async fn trackers_export_csv(app: AppHandle, kind: String) -> CmdResult<Option<Exported>> {
    let suggested = if kind == "letterboxd" { "letterboxd-diary.csv" } else { "series-watched.csv" };
    let Some(path) = save_file(&app, suggested, "CSV", &["csv"]).await else { return Ok(None) };
    let count = trackers::export_csv(&kind, &path).map_err(err_text)?;
    Ok(Some(Exported { path: path.to_string_lossy().into_owned(), count }))
}

// ------------------------------------------------------------------ updates

#[tauri::command]
async fn update_state() -> updater::UpdateState {
    updater::state()
}

#[tauri::command]
async fn update_check() -> updater::UpdateState {
    updater::check(false).await
}

#[tauri::command]
async fn update_install(app: AppHandle) {
    updater::install_now(&app)
}

// ---------------------------------------------------------------------- app

#[tauri::command]
async fn app_open_external(app: AppHandle, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("Only web links can be opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err_text)
}

#[tauri::command]
async fn app_external_player(url: String, title: Option<String>) -> CmdResult<bool> {
    let player = settings::get().external_player_path;
    if player.trim().is_empty() {
        return Err("No external player configured in Settings.".into());
    }
    let mut cmd = std::process::Command::new(&player);
    cmd.arg(&url);
    if let Some(title) = title.filter(|_| player.to_lowercase().contains("vlc")) {
        cmd.arg(format!("--meta-title={title}"));
    }
    cmd.spawn().map_err(|e| format!("Could not start the external player: {e}"))?;
    Ok(true)
}

#[tauri::command]
async fn app_keep_awake(on: bool) -> bool {
    util::keep_awake(on);
    true
}

#[tauri::command]
async fn app_set_online(online: bool) {
    util::set_online(online);
}

#[tauri::command]
fn app_set_fullscreen(window: WebviewWindow, on: bool) {
    let _ = window.set_fullscreen(on);
}

/// The window starts hidden and is shown once the page has painted, so it
/// never flashes white.
#[tauri::command]
fn app_ready(window: WebviewWindow) {
    let _ = window.show();
}

#[tauri::command]
async fn meta_cache_load() -> Value {
    store::read_json::<Value>("meta-cache.json").filter(Value::is_object).unwrap_or_else(|| Value::Object(Map::new()))
}

#[tauri::command]
async fn meta_cache_save(all: Value) {
    store::save("meta-cache.json", &all, false);
}

// ---------------------------------------------------------------- lifecycle

fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("STREAMLINE_LOG")
        .unwrap_or_else(|_| EnvFilter::new("warn,streamline_lib=info,librqbit=warn,librqbit_dht=error"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).try_init();
}

/// The engine, the media server and everything that resumes work, started
/// together so the first click finds them ready.
fn start_background() {
    tauri::async_runtime::spawn(async {
        let s = settings::get();
        // Leftovers of a session that ended without cleaning up (a crash, a power cut).
        if s.delete_on_exit {
            let _ = tokio::task::spawn_blocking(move || torrent::clear_cache(&s)).await;
        }
        server::ready().await;
        if let Err(err) = ENGINE.warm().await {
            tracing::error!("{err:#}");
        }
        downloads::resume_all().await;
        downloads::monitor().await;
    });
    tauri::async_runtime::spawn(async {
        companion::sync().await;
    });
    tauri::async_runtime::spawn(async {
        playback::video_encoder().await;
    });
    if !settings::get().local_folders.is_empty() {
        // Picks up files added while the app was closed.
        tauri::async_runtime::spawn(local::rescan());
    }
    if settings::get().auto_update {
        updater::check_on_startup();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    store::init(store::default_data_dir());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                playback::set_resource_dir(dir);
            }
            updater::init(app.handle().clone());
            start_background();
            // Shown by `app_ready`; this is only the fallback if the page never says so.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            settings_pick_folder,
            settings_pick_file,
            local_status,
            local_rescan,
            local_catalog,
            local_meta,
            local_streams,
            local_subtitles,
            torrent_warm,
            torrent_start,
            torrent_stats,
            torrent_remove,
            library_get,
            library_toggle_favorite,
            library_set_progress,
            library_clear_progress,
            library_mark_watched,
            library_mark_many_watched,
            library_set_rating,
            library_get_last_stream,
            library_set_last_stream,
            library_backup,
            library_restore,
            companion_info,
            companion_configure,
            import_pick_files,
            import_start,
            import_status,
            downloads_list,
            downloads_progress,
            downloads_start,
            downloads_pause,
            downloads_resume,
            downloads_remove,
            downloads_play_source,
            downloads_open_folder,
            downloads_reveal,
            playback_plan,
            subtitle_vtt,
            trackers_status,
            trackers_disconnect,
            trakt_start,
            trakt_poll,
            simkl_start,
            simkl_poll,
            trackers_scrobble,
            trackers_export_csv,
            update_state,
            update_check,
            update_install,
            app_open_external,
            app_external_player,
            app_keep_awake,
            app_set_online,
            app_set_fullscreen,
            app_ready,
            meta_cache_load,
            meta_cache_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Streamline");

    static CLEANING: AtomicBool = AtomicBool::new(false);
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // Drop the disposable streams and their cache before going.
            if CLEANING.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            util::keep_awake(false);
            companion::stop();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(8), ENGINE.shutdown()).await;
                updater::install_on_quit();
                handle.exit(0);
            });
        }
    });
}
