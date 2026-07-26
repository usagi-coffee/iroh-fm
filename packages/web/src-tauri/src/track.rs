use std::{
    collections::{HashMap, VecDeque},
    io::ErrorKind,
    path::PathBuf,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use client::Client;
use protocol::TrackId;

use crate::{DesktopState, player::DesktopTransfer};

fn cache_dir(remote_id: &str) -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("iroh-fm")
        .join("tracks")
        .join(URL_SAFE_NO_PAD.encode(remote_id))
}

fn cache_path(remote_id: &str, track_id: &str) -> PathBuf {
    cache_dir(remote_id).join(format!(
        "{}.track",
        blake3::hash(track_id.as_bytes()).to_hex()
    ))
}

fn cache_id_path(remote_id: &str, track_id: &str) -> PathBuf {
    cache_dir(remote_id).join(format!("{}.id", blake3::hash(track_id.as_bytes()).to_hex()))
}

fn legacy_cache_path(remote_id: &str, track_id: &str) -> PathBuf {
    cache_dir(remote_id).join(URL_SAFE_NO_PAD.encode(track_id))
}

const DEFAULT_MEMORY_CACHE_BYTES: usize = 256 * 1024 * 1024;

pub(super) struct MemoryTrackCache {
    entries: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
    bytes: usize,
    max_bytes: usize,
}

pub(super) struct MemoryTrackId {
    pub(super) remote_id: String,
    pub(super) track_id: String,
}

impl Default for MemoryTrackCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_bytes: DEFAULT_MEMORY_CACHE_BYTES,
        }
    }
}

impl MemoryTrackCache {
    fn key(remote_id: &str, track_id: &str) -> String {
        format!("{remote_id}\u{0}{track_id}")
    }

    fn get(&mut self, remote_id: &str, track_id: &str) -> Option<Vec<u8>> {
        let key = Self::key(remote_id, track_id);
        let bytes = self.entries.get(&key)?.clone();
        self.order.retain(|item| item != &key);
        self.order.push_back(key);
        Some(bytes)
    }

    fn id(key: &str) -> MemoryTrackId {
        let (remote_id, track_id) = key.split_once('\0').unwrap_or_default();
        MemoryTrackId {
            remote_id: remote_id.to_string(),
            track_id: track_id.to_string(),
        }
    }

    fn evict_oldest(&mut self) -> Option<MemoryTrackId> {
        let oldest = self.order.pop_front()?;
        if let Some(previous) = self.entries.remove(&oldest) {
            self.bytes -= previous.len();
        }
        Some(Self::id(&oldest))
    }

    fn insert(
        &mut self,
        remote_id: &str,
        track_id: &str,
        bytes: Vec<u8>,
    ) -> (bool, Vec<MemoryTrackId>) {
        if bytes.is_empty() || bytes.len() > self.max_bytes {
            return (false, Vec::new());
        }
        let key = Self::key(remote_id, track_id);
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes -= previous.len();
        }
        self.order.retain(|item| item != &key);
        let mut evicted = Vec::new();
        while self.bytes + bytes.len() > self.max_bytes {
            let Some(oldest) = self.evict_oldest() else {
                break;
            };
            evicted.push(oldest);
        }
        self.bytes += bytes.len();
        self.entries.insert(key.clone(), bytes);
        self.order.push_back(key);
        (true, evicted)
    }

    pub(super) fn resize(&mut self, max_bytes: usize) -> Vec<MemoryTrackId> {
        self.max_bytes = max_bytes;
        let mut evicted = Vec::new();
        while self.bytes > self.max_bytes {
            let Some(oldest) = self.evict_oldest() else {
                break;
            };
            evicted.push(oldest);
        }
        evicted
    }
}

fn transfer(
    state: &DesktopState,
    track_id: &str,
    received: u64,
    total: u64,
    cached: bool,
    memory_cached: bool,
) {
    if let Ok(mut registry) = state.0.lock() {
        registry.audio.transfers.insert(
            track_id.to_string(),
            DesktopTransfer {
                received,
                total,
                active: false,
                cached,
                memory_cached,
            },
        );
    }
}

pub(super) async fn download(
    state: DesktopState,
    client: Client,
    track_id: String,
) -> Result<Vec<u8>, String> {
    let remote_id = client.remote_id().to_string();
    let path = cache_path(&remote_id, &track_id);
    let cached = state
        .0
        .lock()
        .ok()
        .and_then(|mut registry| registry.memory_tracks.get(&remote_id, &track_id))
        .map(|bytes| (bytes, false, true));
    let cached = match cached {
        Some(cached) => Some(cached),
        None => match tokio::fs::read(&path).await {
            Ok(bytes) => Some((bytes, true, false)),
            Err(_) => tokio::fs::read(legacy_cache_path(&remote_id, &track_id))
                .await
                .ok()
                .map(|bytes| (bytes, true, false)),
        },
    };
    if let Some(bytes) = cached {
        let (bytes, persistent, memory_cached) = bytes;
        transfer(
            &state,
            &track_id,
            bytes.len() as u64,
            bytes.len() as u64,
            persistent,
            memory_cached,
        );
        return Ok(bytes);
    }
    if state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .offline_only
    {
        return Err("track is not available in the desktop offline cache".to_string());
    }
    let (descriptor, mut stream) = client
        .stream_open(TrackId(track_id.clone()))
        .await
        .map_err(|error| error.to_string())?;
    let capacity = usize::try_from(descriptor.file_size).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = vec![0_u8; 1024 * 1024];
    if let Ok(mut registry) = state.0.lock() {
        registry.audio.transfers.insert(
            track_id.clone(),
            DesktopTransfer {
                total: descriptor.file_size,
                active: true,
                ..DesktopTransfer::default()
            },
        );
    }
    while let Some(read) = stream
        .read(&mut buffer)
        .await
        .map_err(|error| error.to_string())?
    {
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Ok(mut registry) = state.0.lock()
            && let Some(transfer) = registry.audio.transfers.get_mut(&track_id)
        {
            transfer.received = bytes.len() as u64;
        }
    }
    if bytes.len() as u64 != descriptor.file_size {
        return Err(format!(
            "track {track_id} ended at {} of {} bytes",
            bytes.len(),
            descriptor.file_size
        ));
    }
    let memory_cached = if let Ok(mut registry) = state.0.lock() {
        let (stored, evicted) = registry
            .memory_tracks
            .insert(&remote_id, &track_id, bytes.clone());
        for evicted in evicted {
            if evicted.remote_id == remote_id {
                registry.audio.transfers.insert(
                    evicted.track_id,
                    DesktopTransfer {
                        memory_cached: false,
                        ..DesktopTransfer::default()
                    },
                );
            }
        }
        stored
    } else {
        false
    };
    transfer(
        &state,
        &track_id,
        descriptor.file_size,
        descriptor.file_size,
        false,
        memory_cached,
    );
    Ok(bytes)
}

pub(super) async fn download_to_disk(
    state: DesktopState,
    client: Client,
    track_id: String,
) -> Result<(), String> {
    let remote_id = client.remote_id().to_string();
    let bytes = download(state.clone(), client, track_id.clone()).await?;
    let path = cache_path(&remote_id, &track_id);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::write(cache_id_path(&remote_id, &track_id), track_id.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    transfer(
        &state,
        &track_id,
        bytes.len() as u64,
        bytes.len() as u64,
        true,
        false,
    );
    Ok(())
}

pub(super) async fn cached_ids(remote_id: &str) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(cache_dir(remote_id)).await else {
        return Ok(ids);
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".id") {
            let audio_path = entry.path().with_extension("track");
            if tokio::fs::metadata(audio_path).await.is_ok()
                && let Ok(id) = tokio::fs::read_to_string(entry.path()).await
            {
                ids.push(id);
            }
            continue;
        }
        if name.ends_with(".track") {
            continue;
        }
        let encoded = entry.file_name();
        let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded.to_string_lossy().as_bytes()) else {
            continue;
        };
        if let Ok(id) = String::from_utf8(bytes) {
            ids.push(id);
        }
    }
    Ok(ids)
}

pub(super) async fn stats(remote_id: &str) -> Result<(u64, u64), String> {
    let mut count = 0_u64;
    let mut size = 0_u64;
    if let Ok(mut entries) = tokio::fs::read_dir(cache_dir(remote_id)).await {
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            if let Ok(metadata) = entry.metadata().await
                && metadata.is_file()
                && !entry.file_name().to_string_lossy().ends_with(".id")
            {
                count += 1;
                size = size.saturating_add(metadata.len());
            }
        }
    }
    Ok((count, size))
}

pub(super) async fn clear(remote_id: &str) -> Result<(), String> {
    match tokio::fs::remove_dir_all(cache_dir(remote_id)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_names_have_fixed_length_for_long_multibyte_track_ids() {
        let track_id = "青空Jumping Heart (黒澤ダイヤ Solo Ver.)/".repeat(20);
        let path = cache_path("remote", &track_id);
        let id_path = cache_id_path("remote", &track_id);

        assert_eq!(path.file_name().unwrap().to_string_lossy().len(), 70);
        assert_eq!(id_path.file_name().unwrap().to_string_lossy().len(), 67);
        assert_ne!(
            cache_path("remote", &track_id),
            cache_path("remote", "other")
        );
    }

    #[test]
    fn memory_cache_reports_rejected_and_evicted_tracks() {
        let mut cache = MemoryTrackCache::default();
        cache.resize(4);

        let (stored, evicted) = cache.insert("remote", "first", vec![1; 3]);
        assert!(stored);
        assert!(evicted.is_empty());

        let (stored, evicted) = cache.insert("remote", "second", vec![2; 3]);
        assert!(stored);
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].remote_id, "remote");
        assert_eq!(evicted[0].track_id, "first");

        let (stored, evicted) = cache.insert("remote", "oversized", vec![3; 5]);
        assert!(!stored);
        assert!(evicted.is_empty());
        assert!(cache.get("remote", "oversized").is_none());
    }
}
