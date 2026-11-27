//! A thin layer over librqbit's file storage that makes starting a torrent fast.
//!
//! Before a torrent starts, librqbit reads and hashes every piece to find what
//! is already on disk. On Windows its reads past the end of a file come back
//! as "0 bytes, no error", so a file that does not exist yet is never noticed:
//! the check hashes the torrent's full size — 28 GB for the Archive's Elephants
//! Dream, 10 GB for a typical film — before the first byte can stream.
//!
//! Here a file that was empty or missing when the torrent was opened refuses
//! reads until something has been written to it. Nothing valid could be in it
//! before that anyway, so the check marks its pieces "needed" at once.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use librqbit::storage::filesystem::FilesystemStorageFactory;
use librqbit::storage::{BoxStorageFactory, StorageFactory, StorageFactoryExt, TorrentStorage};
use librqbit::{ManagedTorrentShared, TorrentMetadata};

#[derive(Clone)]
pub struct FastStartFactory {
    /// The torrent's output folder; librqbit does not share it with storage layers.
    folder: PathBuf,
}

impl FastStartFactory {
    pub fn boxed_for(folder: &Path) -> BoxStorageFactory {
        Self { folder: folder.to_path_buf() }.boxed()
    }
}

impl StorageFactory for FastStartFactory {
    type Storage = FastStartStorage;

    fn create(&self, shared: &ManagedTorrentShared, metadata: &TorrentMetadata) -> anyhow::Result<FastStartStorage> {
        let inner = FilesystemStorageFactory {}.create(shared, metadata)?;
        Ok(FastStartStorage { inner: Box::new(inner), folder: self.folder.clone(), fresh: Vec::new() })
    }

    fn clone_box(&self) -> BoxStorageFactory {
        self.clone().boxed()
    }
}

pub struct FastStartStorage {
    inner: Box<dyn TorrentStorage>,
    folder: PathBuf,
    /// Per file: nothing has been written to it yet.
    fresh: Vec<AtomicBool>,
}

impl FastStartStorage {
    fn is_fresh(&self, file_id: usize) -> bool {
        self.fresh.get(file_id).is_some_and(|f| f.load(Ordering::Acquire))
    }
}

impl TorrentStorage for FastStartStorage {
    fn init(&mut self, shared: &ManagedTorrentShared, metadata: &TorrentMetadata) -> anyhow::Result<()> {
        // Looked at before the inner storage creates (and sizes) the files.
        self.fresh = metadata
            .file_infos
            .iter()
            .map(|fi| {
                let empty = std::fs::metadata(self.folder.join(&fi.relative_filename)).map(|m| m.len() == 0).unwrap_or(true);
                AtomicBool::new(empty)
            })
            .collect();
        self.inner.init(shared, metadata)
    }

    fn pread_exact(&self, file_id: usize, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        if self.is_fresh(file_id) {
            anyhow::bail!("not downloaded yet");
        }
        self.inner.pread_exact(file_id, offset, buf)
    }

    fn pwrite_all(&self, file_id: usize, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        if let Some(f) = self.fresh.get(file_id) {
            f.store(false, Ordering::Release);
        }
        self.inner.pwrite_all(file_id, offset, buf)
    }

    fn remove_file(&self, file_id: usize, filename: &Path) -> anyhow::Result<()> {
        self.inner.remove_file(file_id, filename)
    }

    fn remove_directory_if_empty(&self, path: &Path) -> anyhow::Result<()> {
        self.inner.remove_directory_if_empty(path)
    }

    fn ensure_file_length(&self, file_id: usize, length: u64) -> anyhow::Result<()> {
        self.inner.ensure_file_length(file_id, length)
    }

    fn take(&self) -> anyhow::Result<Box<dyn TorrentStorage>> {
        Ok(Box::new(FastStartStorage {
            inner: self.inner.take()?,
            folder: self.folder.clone(),
            fresh: self.fresh.iter().map(|f| AtomicBool::new(f.load(Ordering::Acquire))).collect(),
        }))
    }
}
