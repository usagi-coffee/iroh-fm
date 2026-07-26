mod cover;
mod player;
mod track;

use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Arc, Mutex},
};

use client::{Client, IrohConfig};
use iroh::{EndpointAddr, EndpointId, RelayUrl, SecretKey, endpoint::RecvStream};
use iroh_tickets::endpoint::EndpointTicket;
use player::{desktop_cache_progress, desktop_play, desktop_player_command, desktop_player_state};
use protocol::{BackendRequest, TrackId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State, ipc::Response};
use tokio::sync::Mutex as AsyncMutex;

#[cfg(all(desktop, not(debug_assertions)))]
const REMOTE_APP_URL: &str = "https://usagi-coffee.github.io/iroh-fm/";

#[derive(Default)]
struct NativeRegistry {
    next_handle: u64,
    clients: HashMap<u64, Client>,
    streams: HashMap<u64, Arc<AsyncMutex<DesktopStream>>>,
    audio: player::DesktopAudio,
    memory_tracks: track::MemoryTrackCache,
    offline_only: bool,
}

struct DesktopStream {
    stream: RecvStream,
    track_id: String,
    received: u64,
    total: u64,
}

#[derive(Clone, Default)]
struct DesktopState(Arc<Mutex<NativeRegistry>>);

impl DesktopState {
    fn client(&self, handle: u64) -> Result<Client, String> {
        self.0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?
            .clients
            .get(&handle)
            .cloned()
            .ok_or_else(|| "desktop client is closed".to_string())
    }

    fn next_handle(registry: &mut NativeRegistry) -> u64 {
        registry.next_handle = registry.next_handle.saturating_add(1).max(1);
        registry.next_handle
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectOptions {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    relays: Vec<String>,
    secret: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connected {
    handle: u64,
    endpoint_id: String,
    remote_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedStream {
    handle: u64,
    content_type: String,
    file_size: u64,
}

#[derive(Serialize)]
struct Identity {
    secret: String,
    #[serde(rename = "endpointId")]
    endpoint_id: String,
}

#[derive(Serialize)]
struct ParsedTicket {
    #[serde(rename = "endpointId")]
    endpoint_id: String,
    relays: Vec<String>,
}

#[derive(Serialize)]
struct NativeBuildInfo {
    platform: &'static str,
    commit: &'static str,
    epoch: u64,
    #[serde(rename = "epochCommit")]
    epoch_commit: &'static str,
}

fn address(options: &ConnectOptions) -> Result<EndpointAddr, String> {
    if !options.ticket.trim().is_empty() {
        return EndpointTicket::from_str(options.ticket.trim())
            .map(|ticket| ticket.endpoint_addr().clone())
            .map_err(|error| format!("invalid endpoint ticket: {error}"));
    }
    let endpoint = EndpointId::from_str(options.endpoint.trim())
        .map_err(|error| format!("invalid server endpoint ID: {error}"))?;
    let mut address = EndpointAddr::new(endpoint);
    for relay in &options.relays {
        if !relay.trim().is_empty() {
            address = address.with_relay_url(
                RelayUrl::from_str(relay.trim())
                    .map_err(|error| format!("invalid relay URL: {error}"))?,
            );
        }
    }
    Ok(address)
}

fn encode_secret(secret: &SecretKey) -> String {
    secret
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tauri::command]
async fn desktop_connect(
    state: State<'_, DesktopState>,
    options: ConnectOptions,
) -> Result<Connected, String> {
    let address = address(&options)?;
    let config = IrohConfig {
        secret: options.secret.filter(|value| !value.trim().is_empty()),
        ..IrohConfig::default()
    };
    let client = Client::connect_addr_with_config(address, config)
        .await
        .map_err(|error| error.to_string())?;
    let connected = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        let handle = DesktopState::next_handle(&mut registry);
        let connected = Connected {
            handle,
            endpoint_id: client.endpoint_id().to_string(),
            remote_id: client.remote_id().to_string(),
        };
        registry.clients.insert(handle, client);
        connected
    };
    Ok(connected)
}

#[tauri::command]
async fn desktop_request(
    state: State<'_, DesktopState>,
    handle: u64,
    request: Value,
) -> Result<Value, String> {
    let request: BackendRequest =
        serde_json::from_value(request).map_err(|error| error.to_string())?;
    let response = state
        .client(handle)?
        .request(request)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(response).map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_cover_art(
    state: State<'_, DesktopState>,
    handle: u64,
    cover_art_id: String,
    full_quality: bool,
) -> Result<Response, String> {
    let client = state.client(handle)?;
    let offline_only = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .offline_only;
    cover::fetch(client, cover_art_id, full_quality, offline_only).await
}

#[tauri::command]
async fn desktop_connection_info(
    state: State<'_, DesktopState>,
    handle: u64,
) -> Result<client::ConnectionInfo, String> {
    state
        .client(handle)?
        .connection_info()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_open_stream(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
) -> Result<OpenedStream, String> {
    let (descriptor, stream) = state
        .client(handle)?
        .stream_open(TrackId(track_id.clone()))
        .await
        .map_err(|error| error.to_string())?;
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    let handle = DesktopState::next_handle(&mut registry);
    log::info!(
        "desktop stream opened handle={handle} track_id={track_id} bytes={}",
        descriptor.file_size
    );
    registry.streams.insert(
        handle,
        Arc::new(AsyncMutex::new(DesktopStream {
            stream,
            track_id,
            received: 0,
            total: descriptor.file_size,
        })),
    );
    Ok(OpenedStream {
        handle,
        content_type: descriptor.content_type,
        file_size: descriptor.file_size,
    })
}

#[tauri::command]
async fn desktop_read_stream(
    state: State<'_, DesktopState>,
    stream_handle: u64,
    length: usize,
) -> Result<Response, String> {
    let stream = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .streams
        .get(&stream_handle)
        .cloned()
        .ok_or_else(|| "desktop stream is closed".to_string())?;
    let mut buffer = vec![0_u8; length.clamp(1, 1024 * 1024)];
    let (read, ended, received, total, track_id) = {
        let mut stream = stream.lock().await;
        let mut read = 0;
        let mut ended = false;
        while read < buffer.len() {
            match stream
                .stream
                .read(&mut buffer[read..])
                .await
                .map_err(|error| error.to_string())?
            {
                Some(0) | None => {
                    ended = true;
                    break;
                }
                Some(chunk) => read += chunk,
            }
        }
        stream.received = stream.received.saturating_add(read as u64);
        (
            read,
            ended,
            stream.received,
            stream.total,
            stream.track_id.clone(),
        )
    };
    buffer.truncate(read);
    if ended {
        if received != total {
            if let Ok(mut registry) = state.0.lock() {
                registry.streams.remove(&stream_handle);
            }
            log::warn!(
                "desktop stream ended early handle={stream_handle} track_id={track_id} received={received} total={total}"
            );
            return Err(format!("track stream ended at {received} of {total} bytes"));
        }
        // A final read may contain both the last bytes and the stream EOF. Keep
        // the handle alive until the caller's next read receives an empty body;
        // otherwise that normal EOF probe becomes "desktop stream is closed".
        if read == 0 {
            if let Ok(mut registry) = state.0.lock() {
                registry.streams.remove(&stream_handle);
            }
            log::info!(
                "desktop stream complete handle={stream_handle} track_id={track_id} bytes={received}"
            );
        }
    }
    Ok(Response::new(buffer))
}

#[tauri::command]
async fn desktop_cached_track_ids(
    state: State<'_, DesktopState>,
    handle: u64,
) -> Result<Vec<String>, String> {
    let remote_id = state.client(handle)?.remote_id().to_string();
    track::cached_ids(&remote_id).await
}

#[tauri::command]
async fn desktop_cache_track(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
) -> Result<Value, String> {
    track::download_to_disk((*state).clone(), state.client(handle)?, track_id).await?;
    Ok(serde_json::json!({ "cached": true }))
}

#[tauri::command]
fn desktop_set_offline_only(state: State<'_, DesktopState>, enabled: bool) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .offline_only = enabled;
    Ok(())
}

#[tauri::command]
async fn desktop_cache_stats(state: State<'_, DesktopState>, handle: u64) -> Result<Value, String> {
    let remote_id = state.client(handle)?.remote_id().to_string();
    let (track_count, track_size) = track::stats(&remote_id).await?;
    let (cover_count, cover_size) = cover::stats(&remote_id).await?;
    Ok(serde_json::json!({
        "tracks": { "count": track_count, "size": track_size },
        "covers": { "count": cover_count, "size": cover_size },
    }))
}

#[tauri::command]
async fn desktop_clear_cache(
    state: State<'_, DesktopState>,
    handle: u64,
    kind: String,
) -> Result<(), String> {
    let remote_id = state.client(handle)?.remote_id().to_string();
    match kind.as_str() {
        "tracks" => track::clear(&remote_id).await,
        "covers" => cover::clear(&remote_id).await,
        _ => Err(format!("unknown offline cache kind: {kind}")),
    }
}

#[tauri::command]
fn desktop_set_memory_cache_size(
    state: State<'_, DesktopState>,
    handle: u64,
    bytes: u64,
) -> Result<(), String> {
    let bytes = usize::try_from(bytes).map_err(|_| "memory cache size is too large".to_string())?;
    let remote_id = state.client(handle)?.remote_id().to_string();
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    let evicted = registry.memory_tracks.resize(bytes);
    for evicted in evicted {
        if evicted.remote_id == remote_id {
            registry.audio.transfers.insert(
                evicted.track_id,
                player::DesktopTransfer {
                    memory_cached: false,
                    ..player::DesktopTransfer::default()
                },
            );
        }
    }
    Ok(())
}

#[tauri::command]
fn desktop_close_stream(state: State<'_, DesktopState>, stream_handle: u64) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .streams
        .remove(&stream_handle);
    Ok(())
}

#[tauri::command]
fn desktop_close(state: State<'_, DesktopState>, handle: u64) -> Result<(), String> {
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    registry.clients.remove(&handle);
    if registry.audio.client_handle == handle {
        player::close(&mut registry.audio);
    }
    Ok(())
}

#[tauri::command]
fn desktop_generate_identity() -> Identity {
    let secret = SecretKey::generate();
    Identity {
        secret: encode_secret(&secret),
        endpoint_id: secret.public().to_string(),
    }
}

#[tauri::command]
fn desktop_endpoint_id_for_secret(secret: String) -> Result<String, String> {
    SecretKey::from_str(secret.trim())
        .map(|secret| secret.public().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_parse_ticket(ticket: String) -> Result<ParsedTicket, String> {
    let ticket = EndpointTicket::from_str(ticket.trim()).map_err(|error| error.to_string())?;
    Ok(ParsedTicket {
        endpoint_id: ticket.endpoint_addr().id.to_string(),
        relays: ticket
            .endpoint_addr()
            .relay_urls()
            .map(ToString::to_string)
            .collect(),
    })
}

#[tauri::command]
fn desktop_build_info() -> NativeBuildInfo {
    NativeBuildInfo {
        platform: "Desktop",
        commit: option_env!("RELEASE_SHA")
            .or(option_env!("GITHUB_SHA"))
            .unwrap_or("development"),
        epoch: env!("DESKTOP_EPOCH").parse().unwrap_or(0),
        epoch_commit: env!("DESKTOP_EPOCH_COMMIT"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(DesktopState::default());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Warn)
            .level_for("iroh", log::LevelFilter::Error)
            .level_for("tracing", log::LevelFilter::Error)
            .level_for("quinn", log::LevelFilter::Error)
            .level_for("iroh_fm_desktop", log::LevelFilter::Info)
            .build(),
    );

    builder
        .setup(move |app| {
            let main_webview = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main webview window is missing"))?;

            #[cfg(debug_assertions)]
            main_webview.eval(
                r#"
                if ('serviceWorker' in navigator) {
                  navigator.serviceWorker.getRegistration().then(async (registration) => {
                    if (!registration) return;
                    const controlled = Boolean(navigator.serviceWorker.controller);
                    const unregistered = await registration.unregister();
                    console.info('[tauri dev] unregistered service worker', {
                      scope: registration.scope,
                      unregistered,
                      controlled,
                    });
                    if (controlled) location.reload();
                  }).catch((error) => console.error('[tauri dev] service worker cleanup failed', error));
                }
                "#,
            )?;

            #[cfg(all(desktop, not(debug_assertions)))]
            main_webview.navigate(REMOTE_APP_URL.parse()?)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_connect,
            desktop_request,
            desktop_cover_art,
            desktop_connection_info,
            desktop_open_stream,
            desktop_read_stream,
            desktop_close_stream,
            desktop_play,
            desktop_player_state,
            desktop_player_command,
            desktop_cached_track_ids,
            desktop_cache_track,
            desktop_cache_progress,
            desktop_set_offline_only,
            desktop_cache_stats,
            desktop_clear_cache,
            desktop_set_memory_cache_size,
            desktop_close,
            desktop_generate_identity,
            desktop_endpoint_id_for_secret,
            desktop_parse_ticket,
            desktop_build_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building iroh-fm desktop")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                player::close_native(&app.state::<DesktopState>());
            }
        });
}
