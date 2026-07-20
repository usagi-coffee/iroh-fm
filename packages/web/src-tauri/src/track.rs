use std::path::PathBuf;

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

pub(super) async fn download(
    state: DesktopState,
    client: Client,
    track_id: String,
) -> Result<Vec<u8>, String> {
    let remote_id = client.remote_id().to_string();
    let path = cache_path(&remote_id, &track_id);
    let cached = match tokio::fs::read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(_) => tokio::fs::read(legacy_cache_path(&remote_id, &track_id))
            .await
            .ok(),
    };
    if let Some(bytes) = cached {
        if let Ok(mut registry) = state.0.lock() {
            registry.audio.transfers.insert(
                track_id,
                DesktopTransfer {
                    received: bytes.len() as u64,
                    total: bytes.len() as u64,
                    active: false,
                    cached: true,
                },
            );
        }
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
    if let Ok(mut registry) = state.0.lock() {
        registry.audio.transfers.insert(
            track_id,
            DesktopTransfer {
                received: descriptor.file_size,
                total: descriptor.file_size,
                active: false,
                cached: true,
            },
        );
    }
    Ok(bytes)
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
}
