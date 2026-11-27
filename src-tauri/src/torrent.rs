//! The torrent engine. Torrents run on librqbit, which fetches the pieces
//! under the player's read position first, so a stream starts long before the
//! file is complete.
//!
//! Some torrents also carry HTTP web seeds (`url-list`) — the Internet
//! Archive's and the Blender films. librqbit cannot read those, so they are
//! the fallback: a stream with no peers is read from the web seed instead, and
//! a download that finds no peers switches to fetching the file over HTTP.
//! The swarm comes first because some seeds are slow — webtorrent.io serves
//! the Blender films at ~25 KB/s while their swarm gives megabytes.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use bytes::Bytes;
use futures::StreamExt;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
};
use parking_lot::Mutex;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub type ManagedTorrentHandle = Arc<ManagedTorrent>;

use crate::settings::{self, Settings};
use crate::types::{Stream, TorrentHandle, TorrentStats};
use crate::{server, store, util};

pub const TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://explodie.org:6969/announce",
];

const METADATA_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Disposable: lives in the cache folder and is wiped on exit.
    Stream,
    /// Kept: lives in the downloads folder.
    Download,
}

pub struct TFile {
    pub name: String,
    /// Path below the torrent's folder.
    pub rel: PathBuf,
    pub len: u64,
}

pub struct Torrent {
    pub hash: String,
    pub name: String,
    pub files: Vec<TFile>,
    /// Where the files are written: the base folder, plus the torrent's name for multi-file ones.
    pub folder: PathBuf,
    pub torrent_bytes: Bytes,
    /// HTTP copies of the torrent's files (BEP 19), if it names any.
    pub web_seeds: Vec<String>,
    pub mode: Mode,
    backend: Backend,
    wanted: Mutex<BTreeSet<usize>>,
    /// The file the player last asked for.
    streaming: Mutex<Option<usize>>,
    /// Bumped by every stream start, so a pending release can tell it was superseded.
    starts: AtomicU64,
    created: Instant,
}

enum Backend {
    Peers(ManagedTorrentHandle),
    Web(WebSeeds),
}

struct WebSeeds {
    jobs: Mutex<HashMap<usize, Arc<HttpJob>>>,
}

#[derive(Default)]
struct HttpJob {
    downloaded: AtomicU64,
    done: AtomicBool,
    error: Mutex<Option<String>>,
    cancel: CancellationToken,
    meter: Mutex<SpeedMeter>,
}

/// Bytes per second over the last few seconds.
#[derive(Default)]
struct SpeedMeter {
    samples: Vec<(Instant, u64)>,
}

impl SpeedMeter {
    fn add(&mut self, bytes: u64) {
        let now = Instant::now();
        self.samples.push((now, bytes));
        self.samples.retain(|(t, _)| now.duration_since(*t) < Duration::from_secs(4));
    }

    fn rate(&self) -> f64 {
        let Some((first, _)) = self.samples.first() else { return 0.0 };
        let span = first.elapsed().as_secs_f64().max(1.0);
        self.samples.iter().map(|(_, b)| *b).sum::<u64>() as f64 / span
    }
}

impl Torrent {
    pub fn path_of(&self, idx: usize) -> Option<PathBuf> {
        self.files.get(idx).map(|f| self.folder.join(&f.rel))
    }

    pub fn is_web(&self) -> bool {
        matches!(self.backend, Backend::Web(_))
    }

    /// The HTTP copy of a file, for torrents that have web seeds.
    pub fn web_url(&self, idx: usize) -> Option<String> {
        let file = self.files.get(idx)?;
        let base = self.web_seeds.first()?;
        Some(web_seed_url(base, &self.name, file, self.files.len() > 1))
    }
}

/// BEP 19: a multi-file torrent's seed is a folder holding `name/path`; a
/// single-file one is either the file itself or a folder holding `name`.
fn web_seed_url(base: &str, name: &str, file: &TFile, multi: bool) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    const SEGMENT: &AsciiSet = &CONTROLS
        .add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?')
        .add(b'`').add(b'{').add(b'}').add(b'/').add(b'\\').add(b'[').add(b']').add(b'^').add(b'|');
    let enc = |s: &str| utf8_percent_encode(s, SEGMENT).to_string();
    if multi {
        let mut url = base.trim_end_matches('/').to_string();
        url.push('/');
        url.push_str(&enc(name));
        for part in file.rel.components() {
            url.push('/');
            url.push_str(&enc(&part.as_os_str().to_string_lossy()));
        }
        url
    } else if base.ends_with('/') {
        format!("{base}{}", enc(name))
    } else {
        base.to_string()
    }
}

pub struct Engine {
    session: tokio::sync::OnceCell<Arc<Session>>,
    torrents: Mutex<HashMap<String, Arc<Torrent>>>,
    /// One add/start at a time per torrent, so a double-click cannot add it twice.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Torrents whose metadata is still being fetched.
    resolving: Mutex<HashSet<String>>,
}

pub static ENGINE: LazyLock<Engine> = LazyLock::new(|| Engine {
    session: tokio::sync::OnceCell::new(),
    torrents: Mutex::new(HashMap::new()),
    locks: Mutex::new(HashMap::new()),
    resolving: Mutex::new(HashSet::new()),
});

fn limit(bps: u64) -> Option<std::num::NonZeroU32> {
    std::num::NonZeroU32::new(bps.min(u32::MAX as u64) as u32)
}

fn torrent_file_for(hash: &str) -> PathBuf {
    store::path("torrents").join(format!("{hash}.torrent"))
}

pub fn saved_torrent(hash: &str) -> Option<Bytes> {
    std::fs::read(torrent_file_for(hash)).ok().map(Bytes::from)
}

pub fn save_torrent(t: &Torrent) {
    let path = torrent_file_for(&t.hash);
    if path.exists() {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(err) = std::fs::write(&path, &t.torrent_bytes) {
        tracing::warn!("could not keep the .torrent: {err}");
    }
}

pub fn forget_torrent_file(hash: &str) {
    let _ = std::fs::remove_file(torrent_file_for(hash));
}

/// Which file to play: the one the addon named, else the biggest video.
pub fn pick_file(files: &[TFile], idx: Option<usize>, hint: Option<&str>) -> usize {
    if let Some(i) = idx.filter(|i| *i < files.len()) {
        return i;
    }
    if let Some(hint) = hint {
        if let Some(i) = files.iter().position(|f| f.name == hint) {
            return i;
        }
    }
    files
        .iter()
        .enumerate()
        .filter(|(_, f)| util::is_video(&f.name))
        .max_by_key(|(_, f)| f.len)
        .map(|(i, _)| i)
        .unwrap_or(0)
}

/// What is needed to (re)create a torrent: its hash plus where the stream said to look.
#[derive(Clone)]
pub struct Want {
    pub hash: String,
    pub sources: Vec<String>,
    pub name: Option<String>,
}

impl Want {
    pub fn from_stream(stream: &Stream) -> anyhow::Result<Self> {
        let hash = stream
            .info_hash
            .as_deref()
            .context("This source has no torrent.")?
            .trim()
            .to_lowercase();
        if hash.len() != 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            bail!("This source has an invalid torrent hash.");
        }
        Ok(Self {
            hash,
            sources: stream.sources.clone().unwrap_or_default(),
            name: stream.filename_hint().map(str::to_string),
        })
    }

    pub fn magnet(&self) -> String {
        use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
        let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        let mut out = format!("magnet:?xt=urn:btih:{}", self.hash);
        if let Some(name) = &self.name {
            out.push_str(&format!("&dn={}", enc(name)));
        }
        for t in self.trackers() {
            out.push_str(&format!("&tr={}", enc(&t)));
        }
        out
    }

    /// Our public trackers plus any the addon named. WebRTC (`wss:`) trackers
    /// need a browser, so they are left out.
    fn trackers(&self) -> Vec<String> {
        let mut list: Vec<String> = TRACKERS.iter().map(|s| s.to_string()).collect();
        for src in &self.sources {
            if let Some(t) = src.strip_prefix("tracker:") {
                if !t.starts_with("ws") && !list.iter().any(|x| x == t) {
                    list.push(t.to_string());
                }
            }
        }
        list
    }

    /// HTTP copies of the .torrent (`xs`), which start without any peers.
    fn exact_sources(&self) -> impl Iterator<Item = &str> {
        self.sources.iter().filter_map(|s| s.strip_prefix("xs:"))
    }
}

struct Resolved {
    bytes: Bytes,
    peers: Vec<SocketAddr>,
}

impl Engine {
    async fn session(&self) -> anyhow::Result<Arc<Session>> {
        self.session
            .get_or_try_init(|| async {
                let s = settings::get();
                let cache = s.cache_dir();
                std::fs::create_dir_all(&cache).ok();
                let opts = SessionOptions {
                    fastresume: false,
                    persistence: None,
                    disable_dht: false,
                    disable_dht_persistence: false,
                    dht_config: Some(librqbit::dht::PersistentDhtConfig {
                        config_filename: Some(store::path("dht.json")),
                        dump_interval: Some(Duration::from_secs(300)),
                    }),
                    listen_port_range: Some(42069..42169),
                    enable_upnp_port_forwarding: true,
                    ratelimits: librqbit::limits::LimitsConfig {
                        upload_bps: limit(s.upload_limit),
                        download_bps: limit(s.download_limit),
                    },
                    ..Default::default()
                };
                let session = Session::new_with_opts(cache, opts)
                    .await
                    .context("could not start the torrent engine")?;
                tracing::info!("torrent engine ready");
                Ok::<_, anyhow::Error>(session)
            })
            .await
            .cloned()
    }

    /// Starting the engine bootstraps the DHT, which takes a moment; do it
    /// before the first click needs it.
    pub async fn warm(&self) -> anyhow::Result<()> {
        self.session().await.map(|_| ())
    }

    pub fn apply_limits(&self, s: &Settings) {
        if let Some(session) = self.session.get() {
            session.ratelimits.set_upload_bps(limit(s.upload_limit));
            session.ratelimits.set_download_bps(limit(s.download_limit));
        }
    }

    pub fn get(&self, hash: &str) -> Option<Arc<Torrent>> {
        self.torrents.lock().get(&hash.to_lowercase()).cloned()
    }

    fn lock_for(&self, hash: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().entry(hash.to_string()).or_default().clone()
    }

    async fn resolve(&self, want: &Want) -> anyhow::Result<Resolved> {
        if let Some(bytes) = saved_torrent(&want.hash) {
            return Ok(Resolved { bytes, peers: vec![] });
        }
        for url in want.exact_sources() {
            match fetch_torrent(url).await {
                Ok(bytes) => return Ok(Resolved { bytes, peers: vec![] }),
                Err(err) => tracing::warn!("could not fetch {url}: {err}"),
            }
        }
        if util::is_offline() {
            bail!("You are offline, and this torrent has never been opened here before.");
        }
        let session = self.session().await?;
        let opts = AddTorrentOptions {
            list_only: true,
            trackers: Some(want.trackers()),
            ..Default::default()
        };
        let magnet = want.magnet();
        let res = tokio::time::timeout(
            METADATA_TIMEOUT,
            session.add_torrent(AddTorrent::from_url(magnet.as_str()), Some(opts)),
        )
        .await
        .map_err(|_| anyhow!("Timed out finding peers for this torrent. Try another source."))??;
        match res {
            AddTorrentResponse::ListOnly(r) => Ok(Resolved { bytes: r.torrent_bytes, peers: r.seen_peers }),
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => {
                let bytes = h.with_metadata(|m| m.torrent_bytes.clone())?;
                Ok(Resolved { bytes, peers: vec![] })
            }
        }
    }

    /// Reads a .torrent's file list without starting anything.
    async fn describe(&self, bytes: &Bytes) -> anyhow::Result<(String, Vec<TFile>)> {
        let session = self.session().await?;
        let opts = AddTorrentOptions { list_only: true, ..Default::default() };
        let res = session.add_torrent(AddTorrent::from_bytes(bytes.clone()), Some(opts)).await?;
        let info = match res {
            AddTorrentResponse::ListOnly(r) => r.info,
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => {
                h.with_metadata(|m| m.info.clone())?
            }
        };
        let name = info
            .name
            .as_ref()
            .map(|n| String::from_utf8_lossy(n.as_ref()).into_owned())
            .unwrap_or_else(|| "download".into());
        let mut files = Vec::new();
        for fd in info.iter_file_details()? {
            let parts = fd.filename.to_vec()?;
            let rel: PathBuf = parts.iter().map(|p| util::safe_file_name(p)).collect();
            let file_name = parts.last().cloned().unwrap_or_else(|| name.clone());
            files.push(TFile { name: file_name, rel, len: fd.len });
        }
        Ok((name, files))
    }

    /// Adds a torrent in `mode` with `wanted` selected, replacing a copy kept in the other mode.
    async fn create(
        &self,
        want: &Want,
        mode: Mode,
        over_http: bool,
        pick: impl FnOnce(&[TFile]) -> usize,
    ) -> anyhow::Result<(Arc<Torrent>, usize)> {
        self.resolving.lock().insert(want.hash.clone());
        let result = self.create_inner(want, mode, over_http, pick).await;
        self.resolving.lock().remove(&want.hash);
        result
    }

    async fn create_inner(
        &self,
        want: &Want,
        mode: Mode,
        over_http: bool,
        pick: impl FnOnce(&[TFile]) -> usize,
    ) -> anyhow::Result<(Arc<Torrent>, usize)> {
        let resolved = self.resolve(want).await?;
        let (name, files) = self.describe(&resolved.bytes).await?;
        if files.is_empty() {
            bail!("This torrent has no files.");
        }
        let idx = pick(&files);
        let s = settings::get();
        let base = match mode {
            Mode::Stream => s.cache_dir(),
            Mode::Download => s.downloads_dir(),
        };
        let folder = if files.len() > 1 { base.join(util::safe_file_name(&name)) } else { base };
        std::fs::create_dir_all(&folder).with_context(|| format!("could not create {}", folder.display()))?;

        let seeds = web_seeds(&resolved.bytes);
        let backend = if over_http && !seeds.is_empty() {
            Backend::Web(WebSeeds { jobs: Mutex::new(HashMap::new()) })
        } else {
            let session = self.session().await?;
            let opts = AddTorrentOptions {
                output_folder: Some(folder.to_string_lossy().into_owned()),
                only_files: Some(vec![idx]),
                overwrite: true,
                initial_peers: Some(resolved.peers),
                trackers: Some(want.trackers()),
                storage_factory: Some(crate::storage::FastStartFactory::boxed_for(&folder)),
                ..Default::default()
            };
            let res = session.add_torrent(AddTorrent::from_bytes(resolved.bytes.clone()), Some(opts)).await?;
            let handle = res.into_handle().context("the torrent engine did not take this torrent")?;
            Backend::Peers(handle)
        };

        let torrent = Arc::new(Torrent {
            hash: want.hash.clone(),
            name,
            files,
            folder,
            torrent_bytes: resolved.bytes,
            web_seeds: seeds,
            mode,
            backend,
            wanted: Mutex::new(BTreeSet::from([idx])),
            streaming: Mutex::new(None),
            starts: AtomicU64::new(0),
            created: Instant::now(),
        });
        self.torrents.lock().insert(want.hash.clone(), torrent.clone());
        Ok((torrent, idx))
    }

    async fn select(&self, t: &Torrent, files: BTreeSet<usize>) -> anyhow::Result<()> {
        *t.wanted.lock() = files.clone();
        match &t.backend {
            Backend::Peers(handle) => {
                let session = self.session().await?;
                let set: HashSet<usize> = files.into_iter().collect();
                session.update_only_files(handle, &set).await?;
                if handle.is_paused() {
                    session.unpause(handle).await?;
                }
            }
            Backend::Web(_) => {
                if t.mode == Mode::Download {
                    for idx in files {
                        self.start_http_job(t, idx);
                    }
                }
            }
        }
        Ok(())
    }

    /// Frees the bandwidth a stream the user moved on from was still using.
    async fn pause_other_streams(&self, keep: &str) {
        let others: Vec<Arc<Torrent>> = self
            .torrents
            .lock()
            .values()
            .filter(|t| t.mode == Mode::Stream && t.hash != keep)
            .cloned()
            .collect();
        let Ok(session) = self.session().await else { return };
        for t in others {
            if let Backend::Peers(handle) = &t.backend {
                if !handle.is_paused() {
                    let _ = session.pause(handle).await;
                }
            }
        }
    }

    /// Adds (or reuses) the torrent and returns a local URL the player can read.
    pub async fn start_stream(&self, stream: &Stream) -> anyhow::Result<TorrentHandle> {
        let want = Want::from_stream(stream)?;
        let lock = self.lock_for(&want.hash);
        let _guard = lock.lock().await;
        let hint = stream.filename_hint();
        let (torrent, idx) = match self.get(&want.hash) {
            Some(t) => {
                let idx = pick_file(&t.files, stream.file_index(), hint);
                let files = match t.mode {
                    // A stream spends all of its bandwidth on the one file.
                    Mode::Stream => BTreeSet::from([idx]),
                    // A download keeps what it was getting, plus this file.
                    Mode::Download => {
                        let mut w = t.wanted.lock().clone();
                        w.insert(idx);
                        w
                    }
                };
                self.select(&t, files).await?;
                (t, idx)
            }
            None => self.create(&want, Mode::Stream, false, |files| pick_file(files, stream.file_index(), hint)).await?,
        };
        *torrent.streaming.lock() = Some(idx);
        torrent.starts.fetch_add(1, Ordering::SeqCst);
        self.pause_other_streams(&want.hash).await;
        if let Backend::Peers(handle) = &torrent.backend {
            tokio::time::timeout(METADATA_TIMEOUT, handle.wait_until_initialized())
                .await
                .map_err(|_| anyhow!("The torrent took too long to start."))??;
        }
        let file = &torrent.files[idx];
        Ok(TorrentHandle {
            url: server::stream_url(&want.hash, idx).await,
            info_hash: want.hash.clone(),
            file_idx: idx,
            file_name: file.name.clone(),
            file_length: file.len,
            mime: util::mime_for(&file.name).into(),
        })
    }

    /// Makes sure `file` is downloading into the downloads folder. A copy kept
    /// as a stream in the cache is dropped first, or the file would vanish on exit.
    pub async fn ensure_download(
        &self,
        want: &Want,
        idx: Option<usize>,
        hint: Option<&str>,
    ) -> anyhow::Result<(Arc<Torrent>, usize)> {
        let lock = self.lock_for(&want.hash);
        let _guard = lock.lock().await;
        if let Some(t) = self.get(&want.hash) {
            if t.mode == Mode::Download {
                let i = pick_file(&t.files, idx, hint);
                let mut w = t.wanted.lock().clone();
                w.insert(i);
                self.select(&t, w).await?;
                return Ok((t, i));
            }
            self.remove(&want.hash, true).await;
        }
        let (t, i) = self.create(want, Mode::Download, false, |files| pick_file(files, idx, hint)).await?;
        if t.is_web() {
            self.start_http_job(&t, i);
        }
        Ok((t, i))
    }

    /// A download that found no peers carries on from the torrent's web seed.
    pub async fn fallback_to_web(&self, hash: &str) -> bool {
        let lock = self.lock_for(hash);
        let _guard = lock.lock().await;
        let Some(t) = self.get(hash) else { return false };
        if t.is_web() || t.web_seeds.is_empty() || t.mode != Mode::Download {
            return false;
        }
        let wanted: Vec<usize> = t.wanted.lock().iter().copied().collect();
        let Some(&first) = wanted.first() else { return false };
        let want = Want { hash: t.hash.clone(), sources: vec![], name: None };
        save_torrent(&t);
        self.remove(hash, false).await;
        match self.create(&want, Mode::Download, true, |_| first).await {
            Ok((t, _)) => {
                tracing::info!("no peers for {}; downloading from its web seed", t.name);
                if let Err(err) = self.select(&t, wanted.into_iter().collect()).await {
                    tracing::warn!("{err}");
                }
                true
            }
            Err(err) => {
                tracing::warn!("could not switch to the web seed: {err}");
                false
            }
        }
    }

    /// Whether a web-seeded torrent's swarm has anyone in it. A new torrent gets
    /// a few seconds to find peers; after that the answer is immediate, so only
    /// the first request ever waits.
    pub async fn swarm_alive(&self, hash: &str) -> bool {
        const GRACE: Duration = Duration::from_secs(5);
        let Some(t) = self.get(hash) else { return false };
        loop {
            match self.live_peers(hash) {
                Some(n) if n > 0 => return true,
                None => return false,
                _ => {}
            }
            if t.created.elapsed() >= GRACE {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Connected peers, for a swarm torrent.
    pub fn live_peers(&self, hash: &str) -> Option<usize> {
        let t = self.get(hash)?;
        match &t.backend {
            Backend::Peers(h) => Some(h.stats().live.as_ref().map(|l| l.snapshot.peer_stats.live).unwrap_or(0)),
            Backend::Web(_) => None,
        }
    }

    /// Stops getting one file; the torrent goes once nothing in it is wanted.
    pub async fn deselect(&self, hash: &str, idx: usize) {
        let Some(t) = self.get(hash) else { return };
        if let Backend::Web(ws) = &t.backend {
            if let Some(job) = ws.jobs.lock().remove(&idx) {
                job.cancel.cancel();
            }
        }
        let rest: BTreeSet<usize> = t.wanted.lock().iter().copied().filter(|i| *i != idx).collect();
        if rest.is_empty() {
            self.remove(hash, false).await;
        } else if let Err(err) = self.select(&t, rest).await {
            tracing::warn!("could not update the torrent's files: {err}");
        }
    }

    /// The player is done with a stream: pause it shortly after, unless
    /// something starts it again first (the next episode of a season pack).
    /// Downloads are left alone — they run until they finish.
    pub fn release(&'static self, hash: &str) {
        let Some(t) = self.get(hash) else { return };
        if t.mode != Mode::Stream {
            return;
        }
        let generation = t.starts.load(Ordering::SeqCst);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if t.starts.load(Ordering::SeqCst) != generation {
                return;
            }
            if let (Backend::Peers(handle), Some(session)) = (&t.backend, self.session.get()) {
                if !handle.is_paused() {
                    let _ = session.pause(handle).await;
                }
            }
        });
    }

    pub async fn remove(&self, hash: &str, delete_files: bool) {
        let hash = hash.to_lowercase();
        let Some(t) = self.torrents.lock().remove(&hash) else { return };
        match &t.backend {
            Backend::Peers(handle) => {
                if let Some(session) = self.session.get() {
                    let id = librqbit::api::TorrentIdOrHash::Id(handle.id());
                    if let Err(err) = session.delete(id, delete_files).await {
                        tracing::warn!("could not remove torrent {hash}: {err}");
                    }
                }
            }
            Backend::Web(ws) => {
                for (_, job) in ws.jobs.lock().drain() {
                    job.cancel.cancel();
                }
            }
        }
    }

    /// Progress of one file: (bytes on disk, length, bytes/s, peers, seconds left).
    pub fn file_progress(&self, hash: &str, idx: usize) -> Option<(u64, u64, f64, usize, f64)> {
        let t = self.get(hash)?;
        let len = t.files.get(idx)?.len;
        match &t.backend {
            Backend::Peers(handle) => {
                let stats = handle.stats();
                let done = stats.file_progress.get(idx).copied().unwrap_or(0);
                let (speed, peers) = stats
                    .live
                    .as_ref()
                    .map(|l| (l.download_speed.mbps * 1024.0 * 1024.0, l.snapshot.peer_stats.live))
                    .unwrap_or((0.0, 0));
                let left = if speed > 0.0 { (len.saturating_sub(done)) as f64 / speed } else { 0.0 };
                Some((done, len, speed, peers, left))
            }
            Backend::Web(ws) => {
                let job = ws.jobs.lock().get(&idx).cloned();
                let (done, speed) = match job {
                    Some(j) => {
                        let done = if j.done.load(Ordering::Relaxed) { len } else { j.downloaded.load(Ordering::Relaxed) };
                        (done, j.meter.lock().rate())
                    }
                    None => (std::fs::metadata(t.folder.join(&t.files[idx].rel)).map(|m| m.len().min(len)).unwrap_or(0), 0.0),
                };
                let left = if speed > 0.0 { (len.saturating_sub(done)) as f64 / speed } else { 0.0 };
                Some((done, len, speed, 1, left))
            }
        }
    }

    pub fn file_error(&self, hash: &str, idx: usize) -> Option<String> {
        let t = self.get(hash)?;
        match &t.backend {
            Backend::Peers(handle) => handle.stats().error,
            Backend::Web(ws) => ws.jobs.lock().get(&idx).and_then(|j| j.error.lock().clone()),
        }
    }

    pub fn stats(&self, hash: &str) -> Option<TorrentStats> {
        let hash = hash.to_lowercase();
        let Some(t) = self.get(&hash) else {
            return self.resolving.lock().contains(&hash).then(|| TorrentStats {
                info_hash: hash.clone(),
                ..Default::default()
            });
        };
        let idx = t.streaming.lock().or_else(|| t.wanted.lock().iter().next().copied()).unwrap_or(0);
        match &t.backend {
            Backend::Peers(handle) => {
                let s = handle.stats();
                let total = s.total_bytes.max(1);
                let (down, up, peers) = s
                    .live
                    .as_ref()
                    .map(|l| {
                        (
                            l.download_speed.mbps * 1024.0 * 1024.0,
                            l.upload_speed.mbps * 1024.0 * 1024.0,
                            l.snapshot.peer_stats.live,
                        )
                    })
                    .unwrap_or((0.0, 0.0, 0));
                let file_len = t.files.get(idx).map(|f| f.len).unwrap_or(1).max(1);
                let file_done = s.file_progress.get(idx).copied().unwrap_or(0);
                Some(TorrentStats {
                    info_hash: hash,
                    progress: s.progress_bytes as f64 / total as f64,
                    downloaded: s.progress_bytes,
                    download_speed: down,
                    upload_speed: up,
                    peers,
                    ready: true,
                    file_progress: file_done as f64 / file_len as f64,
                })
            }
            Backend::Web(_) => {
                let (done, len, speed, _, _) = self.file_progress(&hash, idx).unwrap_or((0, 1, 0.0, 1, 0.0));
                Some(TorrentStats {
                    info_hash: hash,
                    progress: done as f64 / len.max(1) as f64,
                    downloaded: done,
                    download_speed: speed,
                    upload_speed: 0.0,
                    peers: 1,
                    ready: true,
                    file_progress: done as f64 / len.max(1) as f64,
                })
            }
        }
    }

    /// The live torrent behind a stream URL, for the local server.
    pub fn handle(&self, hash: &str) -> Option<(Arc<Torrent>, Option<ManagedTorrentHandle>)> {
        let t = self.get(hash)?;
        let h = match &t.backend {
            Backend::Peers(h) => Some(h.clone()),
            Backend::Web(_) => None,
        };
        Some((t, h))
    }

    fn start_http_job(&self, t: &Torrent, idx: usize) {
        let Backend::Web(ws) = &t.backend else { return };
        let Some(url) = t.web_url(idx) else { return };
        let Some(path) = t.path_of(idx) else { return };
        let len = t.files[idx].len;
        let mut jobs = ws.jobs.lock();
        if jobs.get(&idx).is_some_and(|j| !j.cancel.is_cancelled()) {
            return;
        }
        let job = Arc::new(HttpJob::default());
        jobs.insert(idx, job.clone());
        tauri::async_runtime::spawn(async move {
            let mut attempt = 0u32;
            loop {
                match http_download(&url, &path, len, &job).await {
                    Ok(()) => {
                        job.done.store(true, Ordering::Relaxed);
                        *job.error.lock() = None;
                        return;
                    }
                    Err(_) if job.cancel.is_cancelled() => return,
                    Err(err) => {
                        attempt += 1;
                        tracing::warn!("web seed download failed (attempt {attempt}): {err}");
                        *job.error.lock() = Some(err.to_string());
                        if attempt >= 8 {
                            return;
                        }
                        let wait = Duration::from_secs(2u64.pow(attempt.min(5)));
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = job.cancel.cancelled() => return,
                        }
                    }
                }
            }
        });
    }

    /// Drops the disposable streams — and, when asked, their cache — at exit.
    pub async fn shutdown(&self) {
        let s = settings::get();
        let streams: Vec<String> = self
            .torrents
            .lock()
            .values()
            .filter(|t| t.mode == Mode::Stream)
            .map(|t| t.hash.clone())
            .collect();
        for hash in streams {
            self.remove(&hash, s.delete_on_exit).await;
        }
        if let Some(session) = self.session.get() {
            session.stop().await;
        }
        if s.delete_on_exit {
            clear_cache(&s);
        }
    }
}

/// Only the app's own temp folder is ever deleted whole. A cache folder the
/// user pointed somewhere else just loses the empty folders streams left.
pub fn clear_cache(s: &Settings) {
    let cache = s.cache_dir();
    if paths_equal(&cache, &settings::default_cache_dir()) {
        let _ = std::fs::remove_dir_all(&cache);
    } else if let Ok(entries) = std::fs::read_dir(&cache) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                let _ = std::fs::remove_dir(e.path());
            }
        }
    }
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    norm(a) == norm(b)
}

async fn fetch_torrent(url: &str) -> anyhow::Result<Bytes> {
    let res = util::http().get(url).timeout(Duration::from_secs(20)).send().await?;
    if !res.status().is_success() {
        bail!("{}", res.status());
    }
    let bytes = res.bytes().await?;
    if bytes.first() != Some(&b'd') {
        bail!("not a .torrent file");
    }
    Ok(bytes)
}

/// Downloads one file from a web seed, resuming whatever is already on disk.
async fn http_download(url: &str, path: &Path, len: u64, job: &HttpJob) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut have = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    if have > len {
        have = 0;
    }
    job.downloaded.store(have, Ordering::Relaxed);
    if have == len && len > 0 {
        return Ok(());
    }
    let res = util::http()
        .get(url)
        .header("range", format!("bytes={have}-"))
        .send()
        .await?;
    let status = res.status();
    let append = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !append && !status.is_success() {
        bail!("{status} from the web seed");
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .await?;
    if !append {
        have = 0;
        job.downloaded.store(0, Ordering::Relaxed);
    }
    let mut body = res.bytes_stream();
    loop {
        let chunk = tokio::select! {
            c = body.next() => c,
            _ = job.cancel.cancelled() => bail!("cancelled"),
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        have += chunk.len() as u64;
        job.downloaded.store(have, Ordering::Relaxed);
        job.meter.lock().add(chunk.len() as u64);
    }
    file.flush().await?;
    if have < len {
        bail!("the web seed stopped early ({have} of {len} bytes)");
    }
    Ok(())
}

// --------------------------------------------------------------- bencode

/// The `url-list` of a .torrent (BEP 19), read straight from its bencoding.
fn web_seeds(torrent: &[u8]) -> Vec<String> {
    let mut pos = 0;
    let Some(Value::Dict(top)) = parse_value(torrent, &mut pos, 0) else { return vec![] };
    let urls = match top.into_iter().find(|(k, _)| k == b"url-list").map(|(_, v)| v) {
        Some(Value::Bytes(b)) => vec![b],
        Some(Value::List(items)) => items
            .into_iter()
            .filter_map(|v| if let Value::Bytes(b) = v { Some(b) } else { None })
            .collect(),
        _ => vec![],
    };
    urls.into_iter()
        .filter_map(|b| String::from_utf8(b).ok())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .collect()
}

enum Value {
    Int,
    Bytes(Vec<u8>),
    List(Vec<Value>),
    Dict(Vec<(Vec<u8>, Value)>),
}

fn parse_value(buf: &[u8], pos: &mut usize, depth: u32) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    match *buf.get(*pos)? {
        b'i' => {
            let end = buf[*pos..].iter().position(|&c| c == b'e')? + *pos;
            *pos = end + 1;
            Some(Value::Int)
        }
        b'l' => {
            *pos += 1;
            let mut items = Vec::new();
            while *buf.get(*pos)? != b'e' {
                items.push(parse_value(buf, pos, depth + 1)?);
            }
            *pos += 1;
            Some(Value::List(items))
        }
        b'd' => {
            *pos += 1;
            let mut items = Vec::new();
            while *buf.get(*pos)? != b'e' {
                let Value::Bytes(key) = parse_value(buf, pos, depth + 1)? else { return None };
                // The info dict is large and never needed here; skip over it cheaply.
                let value = parse_value(buf, pos, depth + 1)?;
                items.push((key, value));
            }
            *pos += 1;
            Some(Value::Dict(items))
        }
        b'0'..=b'9' => {
            let colon = buf[*pos..].iter().position(|&c| c == b':')? + *pos;
            let len: usize = std::str::from_utf8(&buf[*pos..colon]).ok()?.parse().ok()?;
            let start = colon + 1;
            let end = start.checked_add(len)?;
            let bytes = buf.get(start..end)?.to_vec();
            *pos = end;
            Some(Value::Bytes(bytes))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_url_list() {
        let t = b"d8:announce3:abc4:infod4:name3:abc6:lengthi5ee8:url-listl20:https://example.com/ee";
        assert_eq!(web_seeds(t), vec!["https://example.com/".to_string()]);
        let single = b"d8:url-list19:https://example.com4:infod4:name1:xee";
        assert_eq!(web_seeds(single), vec!["https://example.com".to_string()]);
    }

    #[test]
    fn builds_web_seed_urls() {
        let f = TFile { name: "b c.mp4".into(), rel: PathBuf::from("sub").join("b c.mp4"), len: 1 };
        assert_eq!(web_seed_url("https://h/x/", "Name", &f, true), "https://h/x/Name/sub/b%20c.mp4");
        let one = TFile { name: "a.mp4".into(), rel: PathBuf::from("a.mp4"), len: 1 };
        assert_eq!(web_seed_url("https://h/x/", "a.mp4", &one, false), "https://h/x/a.mp4");
        assert_eq!(web_seed_url("https://h/a.mp4", "a.mp4", &one, false), "https://h/a.mp4");
    }

    #[test]
    fn picks_the_biggest_video() {
        let files = vec![
            TFile { name: "a.nfo".into(), rel: "a.nfo".into(), len: 900 },
            TFile { name: "a.mkv".into(), rel: "a.mkv".into(), len: 500 },
            TFile { name: "sample.mkv".into(), rel: "sample.mkv".into(), len: 50 },
        ];
        assert_eq!(pick_file(&files, None, None), 1);
        assert_eq!(pick_file(&files, Some(2), None), 2);
        assert_eq!(pick_file(&files, None, Some("sample.mkv")), 2);
    }
}
