use std::{io::ErrorKind, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use client::Client;
use protocol::{BackendRequest, BackendResponse, CoverArtId};
use tauri::ipc::Response;

fn cache_dir(remote_id: &str) -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("iroh-fm")
        .join("covers")
        .join(URL_SAFE_NO_PAD.encode(remote_id))
}

fn cache_path(remote_id: &str, cover_art_id: &str, full_quality: bool) -> PathBuf {
    let mut key = blake3::Hasher::new();
    key.update(cover_art_id.as_bytes());
    key.update(&[u8::from(full_quality)]);
    cache_dir(remote_id).join(format!("{}.cover", key.finalize().to_hex()))
}

fn payload(content_type: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let content_type = content_type.as_bytes();
    let content_type_len = u16::try_from(content_type.len())
        .map_err(|_| "cover content type is too long".to_string())?;
    let mut payload = Vec::with_capacity(2 + content_type.len() + bytes.len());
    payload.extend_from_slice(&content_type_len.to_be_bytes());
    payload.extend_from_slice(content_type);
    payload.extend_from_slice(bytes);
    Ok(payload)
}

fn valid_payload(payload: &[u8]) -> bool {
    let Some(length) = payload.get(..2) else {
        return false;
    };
    let content_type_len = u16::from_be_bytes([length[0], length[1]]) as usize;
    payload.len() > 2 + content_type_len
}

pub(super) async fn fetch(
    client: Client,
    cover_art_id: String,
    full_quality: bool,
    offline_only: bool,
) -> Result<Response, String> {
    let path = cache_path(&client.remote_id().to_string(), &cover_art_id, full_quality);
    if let Ok(payload) = tokio::fs::read(&path).await
        && valid_payload(&payload)
    {
        return Ok(Response::new(payload));
    }
    if offline_only {
        return Err("cover is not available in the desktop offline cache".to_string());
    }

    let response = client
        .request(BackendRequest::GetCoverArt {
            cover_art_id: CoverArtId(cover_art_id),
            full_quality,
        })
        .await
        .map_err(|error| error.to_string())?;
    let BackendResponse::CoverArt(cover) = response else {
        return Err("backend returned an unexpected cover response".to_string());
    };
    let payload = payload(&cover.content_type, &cover.bytes)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(path, &payload)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Response::new(payload))
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
    fn cache_separates_quality_and_encodes_binary_response() {
        assert_ne!(
            cache_path("remote", "cover", false),
            cache_path("remote", "cover", true)
        );

        let payload = payload("image/webp", &[1, 2, 3]).unwrap();
        assert!(valid_payload(&payload));
        assert_eq!(u16::from_be_bytes([payload[0], payload[1]]), 10);
        assert_eq!(&payload[2..12], b"image/webp");
        assert_eq!(&payload[12..], &[1, 2, 3]);
        assert!(!valid_payload(&payload[..12]));
    }
}
