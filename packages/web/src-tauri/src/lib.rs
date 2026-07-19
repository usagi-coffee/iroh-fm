use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
};
use client::{Client, IrohConfig};
use iroh::{EndpointAddr, EndpointId, RelayUrl, SecretKey, endpoint::RecvStream};
use iroh_tickets::endpoint::EndpointTicket;
use protocol::{BackendRequest, BackendResponse, CoverArtId, TrackId};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State, ipc::Response};
use tokio::sync::Mutex as AsyncMutex;

const TRACK_CROSSFADE: Duration = Duration::from_millis(1_500);
const CROSSFADE_STEPS: u32 = 30;
#[cfg(all(desktop, not(debug_assertions)))]
const LOCALHOST_PORT: u16 = 13_592;

#[derive(Default)]
struct NativeRegistry {
    next_handle: u64,
    clients: HashMap<u64, Client>,
    streams: HashMap<u64, Arc<AsyncMutex<DesktopStream>>>,
    audio: DesktopAudio,
    offline_only: bool,
}

#[derive(Clone, Default, Serialize)]
struct DesktopTransfer {
    received: u64,
    total: u64,
    active: bool,
    cached: bool,
}

struct DesktopAudio {
    device: Option<MixerDeviceSink>,
    player: Option<Arc<Player>>,
    client_handle: u64,
    generation: u64,
    queue: Vec<String>,
    active: VecDeque<usize>,
    prefetching: Option<usize>,
    loading: bool,
    volume: f32,
    repeat: bool,
    shuffle: bool,
    transfers: HashMap<String, DesktopTransfer>,
}

impl Default for DesktopAudio {
    fn default() -> Self {
        Self {
            device: None,
            player: None,
            client_handle: 0,
            generation: 0,
            queue: Vec::new(),
            active: VecDeque::new(),
            prefetching: None,
            loading: false,
            volume: 0.5,
            repeat: false,
            shuffle: false,
            transfers: HashMap::new(),
        }
    }
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
#[serde(rename_all = "camelCase")]
struct DesktopPlayerState {
    track_id: Option<String>,
    queue: Vec<String>,
    current_index: usize,
    playing: bool,
    loading: bool,
    position: f64,
    duration: f64,
    repeat: bool,
    shuffle: bool,
    volume: f32,
    transfers: HashMap<String, DesktopTransfer>,
}

#[derive(Serialize)]
struct PreparedPlay {
    generation: u64,
    selected: usize,
}

fn raw_header_u64(request: &tauri::ipc::Request<'_>, name: &str) -> Result<u64, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("missing or invalid {name} header"))
}

fn raw_bytes(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("desktop audio upload requires a raw binary body".to_string());
    };
    Ok(bytes.clone())
}

fn track_cache_dir(remote_id: &str) -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("iroh-fm")
        .join("tracks")
        .join(URL_SAFE_NO_PAD.encode(remote_id))
}

fn track_cache_path(remote_id: &str, track_id: &str) -> PathBuf {
    track_cache_dir(remote_id).join(URL_SAFE_NO_PAD.encode(track_id))
}

async fn download_track(
    state: DesktopState,
    client: Client,
    track_id: String,
) -> Result<Vec<u8>, String> {
    let remote_id = client.remote_id().to_string();
    let path = track_cache_path(&remote_id, &track_id);
    if let Ok(bytes) = tokio::fs::read(&path).await {
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
        if let Ok(mut registry) = state.0.lock() {
            if let Some(transfer) = registry.audio.transfers.get_mut(&track_id) {
                transfer.received = bytes.len() as u64;
            }
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

fn decoder(bytes: Vec<u8>) -> Result<Decoder<Cursor<Vec<u8>>>, String> {
    Decoder::try_from(Cursor::new(bytes)).map_err(|error| error.to_string())
}

fn sync_audio(audio: &mut DesktopAudio) {
    let remaining = audio.player.as_ref().map_or(0, |player| player.len());
    while audio.active.len() > remaining {
        audio.active.pop_front();
    }
}

fn close_audio_device(audio: &mut DesktopAudio) {
    audio.generation = audio.generation.saturating_add(1);
    if let Some(player) = audio.player.take() {
        player.stop();
    }
    // Drop the CPAL stream after the player so ALSA/PipeWire sees an orderly
    // disconnect. A later play request will open a completely new device.
    audio.device.take();
    audio.active.clear();
    audio.queue.clear();
    audio.prefetching = None;
    audio.loading = false;
}

fn close_native_audio(state: &DesktopState) {
    if let Ok(mut registry) = state.0.lock() {
        close_audio_device(&mut registry.audio);
    }
}

fn player_state(audio: &mut DesktopAudio) -> DesktopPlayerState {
    sync_audio(audio);
    let current_index = audio.active.front().copied().unwrap_or(0);
    DesktopPlayerState {
        track_id: audio
            .active
            .front()
            .and_then(|index| audio.queue.get(*index))
            .cloned(),
        queue: audio.queue.clone(),
        current_index,
        playing: audio
            .player
            .as_ref()
            .is_some_and(|player| !player.is_paused() && !player.empty()),
        loading: audio.loading,
        position: audio
            .player
            .as_ref()
            .map_or(0.0, |player| player.get_pos().as_secs_f64()),
        duration: 0.0,
        repeat: audio.repeat,
        shuffle: audio.shuffle,
        volume: audio.volume,
        transfers: audio.transfers.clone(),
    }
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
) -> Result<Value, String> {
    let response = state
        .client(handle)?
        .request(BackendRequest::GetCoverArt {
            cover_art_id: CoverArtId(cover_art_id),
        })
        .await
        .map_err(|error| error.to_string())?;
    let BackendResponse::CoverArt(cover) = response else {
        return Err("backend returned an unexpected cover response".to_string());
    };
    Ok(serde_json::json!({
        "contentType": cover.content_type,
        "bytesBase64": BASE64.encode(cover.bytes),
    }))
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

fn schedule_audio_prefetch(state: DesktopState, client_handle: u64) {
    let scheduled = {
        let mut registry = match state.0.lock() {
            Ok(registry) => registry,
            Err(_) => return,
        };
        let audio = &mut registry.audio;
        sync_audio(audio);
        let Some(&current) = audio.active.front() else {
            return;
        };
        if audio.queue.len() < 2 || audio.active.len() >= 2 || audio.prefetching.is_some() {
            return;
        }
        let next = (current + 1) % audio.queue.len();
        if audio.active.contains(&next) {
            return;
        }
        audio.prefetching = Some(next);
        (
            audio.generation,
            next,
            audio.queue[next].clone(),
            registry.clients.get(&client_handle).cloned(),
        )
    };
    let (generation, index, track_id, Some(client)) = scheduled else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let result = download_track(state.clone(), client, track_id.clone())
            .await
            .and_then(decoder);
        let mut registry = match state.0.lock() {
            Ok(registry) => registry,
            Err(_) => return,
        };
        let audio = &mut registry.audio;
        if audio.generation != generation || audio.prefetching != Some(index) {
            return;
        }
        audio.prefetching = None;
        match result {
            Ok(source) => {
                if let Some(player) = &audio.player {
                    player.append(source);
                    audio.active.push_back(index);
                    log::info!("desktop player queued track_id={track_id}");
                }
            }
            Err(error) => log::warn!("desktop player prefetch failed track_id={track_id}: {error}"),
        }
    });
}

async fn start_audio(
    state: DesktopState,
    client_handle: u64,
    queue: Vec<String>,
    selected: usize,
) -> Result<DesktopPlayerState, String> {
    let (generation, client, track_id) = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        let client = registry
            .clients
            .get(&client_handle)
            .cloned()
            .ok_or_else(|| "desktop client is closed".to_string())?;
        let audio = &mut registry.audio;
        audio.generation = audio.generation.saturating_add(1);
        audio.client_handle = client_handle;
        audio.queue = queue;
        audio.active.clear();
        audio.prefetching = None;
        audio.loading = true;
        let track_id = audio
            .queue
            .get(selected)
            .cloned()
            .ok_or_else(|| "selected track is not in the desktop queue".to_string())?;
        (audio.generation, client, track_id)
    };
    let source = download_track(state.clone(), client, track_id.clone())
        .await
        .and_then(decoder)?;
    let (result, outgoing, incoming) = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        let audio = &mut registry.audio;
        if audio.generation != generation {
            return Err("desktop playback request was replaced".to_string());
        }
        if audio.device.is_none() {
            audio.device =
                Some(DeviceSinkBuilder::open_default_sink().map_err(|error| {
                    format!("could not open the default audio device: {error}")
                })?);
        }
        let outgoing = audio.player.take();
        let player = Arc::new(Player::connect_new(
            &audio.device.as_ref().expect("device exists").mixer(),
        ));
        player.set_volume(if outgoing.is_some() {
            0.0
        } else {
            audio.volume
        });
        player.append(source);
        audio.player = Some(player.clone());
        audio.active.push_back(selected);
        audio.loading = false;
        log::info!("desktop player started track_id={track_id}");
        (player_state(audio), outgoing, player)
    };
    if let Some(outgoing) = outgoing {
        let fade_state = state.clone();
        tauri::async_runtime::spawn(async move {
            for step in 1..=CROSSFADE_STEPS {
                tokio::time::sleep(TRACK_CROSSFADE / CROSSFADE_STEPS).await;
                let target = {
                    let Ok(registry) = fade_state.0.lock() else {
                        return;
                    };
                    if registry.audio.generation != generation {
                        outgoing.stop();
                        return;
                    }
                    registry.audio.volume
                };
                let progress = step as f32 / CROSSFADE_STEPS as f32;
                outgoing.set_volume(target * (1.0 - progress));
                incoming.set_volume(target * progress);
            }
            outgoing.stop();
            log::info!("desktop player crossfade complete");
        });
    }
    schedule_audio_prefetch(state, client_handle);
    Ok(result)
}

#[tauri::command]
fn desktop_prepare_play(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
    queue: Vec<String>,
) -> Result<PreparedPlay, String> {
    let selected = queue
        .iter()
        .position(|id| id == &track_id)
        .ok_or_else(|| "selected track is not in the desktop queue".to_string())?;
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    if !registry.clients.contains_key(&handle) {
        return Err("desktop client is closed".to_string());
    }
    let audio = &mut registry.audio;
    audio.generation = audio.generation.saturating_add(1);
    audio.client_handle = handle;
    audio.queue = queue;
    audio.active.clear();
    audio.prefetching = None;
    audio.loading = true;
    Ok(PreparedPlay {
        generation: audio.generation,
        selected,
    })
}

#[tauri::command]
fn desktop_play_uploaded(
    state: State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<DesktopPlayerState, String> {
    let handle = raw_header_u64(&request, "x-iroh-handle")?;
    let generation = raw_header_u64(&request, "x-iroh-generation")?;
    let selected = usize::try_from(raw_header_u64(&request, "x-iroh-index")?)
        .map_err(|_| "invalid desktop queue index".to_string())?;
    let source = decoder(raw_bytes(&request)?)?;
    let (result, outgoing, incoming) = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        let audio = &mut registry.audio;
        if audio.client_handle != handle || audio.generation != generation {
            return Err("desktop playback upload was replaced".to_string());
        }
        if audio.device.is_none() {
            audio.device =
                Some(DeviceSinkBuilder::open_default_sink().map_err(|error| {
                    format!("could not open the default audio device: {error}")
                })?);
        }
        let outgoing = audio.player.take();
        let player = Arc::new(Player::connect_new(
            &audio.device.as_ref().expect("device exists").mixer(),
        ));
        player.set_volume(if outgoing.is_some() {
            0.0
        } else {
            audio.volume
        });
        player.append(source);
        audio.player = Some(player.clone());
        audio.active.push_back(selected);
        audio.loading = false;
        (player_state(audio), outgoing, player)
    };
    if let Some(outgoing) = outgoing {
        let fade_state = (*state).clone();
        tauri::async_runtime::spawn(async move {
            for step in 1..=CROSSFADE_STEPS {
                tokio::time::sleep(TRACK_CROSSFADE / CROSSFADE_STEPS).await;
                let target = {
                    let Ok(registry) = fade_state.0.lock() else {
                        return;
                    };
                    if registry.audio.generation != generation {
                        outgoing.stop();
                        return;
                    }
                    registry.audio.volume
                };
                let progress = step as f32 / CROSSFADE_STEPS as f32;
                outgoing.set_volume(target * (1.0 - progress));
                incoming.set_volume(target * progress);
            }
            outgoing.stop();
        });
    }
    Ok(result)
}

#[tauri::command]
fn desktop_queue_uploaded(
    state: State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let handle = raw_header_u64(&request, "x-iroh-handle")?;
    let generation = raw_header_u64(&request, "x-iroh-generation")?;
    let index = usize::try_from(raw_header_u64(&request, "x-iroh-index")?)
        .map_err(|_| "invalid desktop queue index".to_string())?;
    let source = decoder(raw_bytes(&request)?)?;
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    let audio = &mut registry.audio;
    if audio.client_handle != handle || audio.generation != generation {
        return Ok(false);
    }
    if audio.active.contains(&index) {
        return Ok(true);
    }
    let player = audio
        .player
        .as_ref()
        .ok_or_else(|| "desktop player is not ready".to_string())?;
    player.append(source);
    audio.active.push_back(index);
    Ok(true)
}

#[tauri::command]
async fn desktop_play(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
    queue: Vec<String>,
) -> Result<DesktopPlayerState, String> {
    let selected = queue
        .iter()
        .position(|id| id == &track_id)
        .ok_or_else(|| "selected track is not in the desktop queue".to_string())?;
    start_audio((*state).clone(), handle, queue, selected).await
}

#[tauri::command]
async fn desktop_player_state(
    state: State<'_, DesktopState>,
    handle: u64,
) -> Result<DesktopPlayerState, String> {
    let result = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        player_state(&mut registry.audio)
    };
    let _ = handle;
    Ok(result)
}

#[tauri::command]
async fn desktop_cached_track_ids(
    state: State<'_, DesktopState>,
    handle: u64,
) -> Result<Vec<String>, String> {
    let remote_id = state.client(handle)?.remote_id().to_string();
    let mut ids = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(track_cache_dir(&remote_id)).await else {
        return Ok(ids);
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
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

#[tauri::command]
async fn desktop_cache_track(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
) -> Result<Value, String> {
    download_track((*state).clone(), state.client(handle)?, track_id).await?;
    Ok(serde_json::json!({ "cached": true }))
}

#[tauri::command]
fn desktop_cache_progress(
    state: State<'_, DesktopState>,
    track_id: String,
) -> Result<DesktopTransfer, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?
        .audio
        .transfers
        .get(&track_id)
        .cloned()
        .unwrap_or_default())
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
    let mut count = 0_u64;
    let mut size = 0_u64;
    if let Ok(mut entries) = tokio::fs::read_dir(track_cache_dir(&remote_id)).await {
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    count += 1;
                    size = size.saturating_add(metadata.len());
                }
            }
        }
    }
    Ok(serde_json::json!({
        "tracks": { "count": count, "size": size },
        "covers": { "count": 0, "size": 0 },
    }))
}

#[tauri::command]
async fn desktop_player_command(
    state: State<'_, DesktopState>,
    handle: u64,
    command: String,
    payload: Value,
) -> Result<DesktopPlayerState, String> {
    let switch = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        let audio = &mut registry.audio;
        sync_audio(audio);
        match command.as_str() {
            "next" | "previous" => {
                if audio.queue.is_empty() {
                    return Err("desktop playback queue is empty".to_string());
                }
                let current = audio.active.front().copied().unwrap_or(0);
                let offset = if command == "next" {
                    1
                } else {
                    audio.queue.len() - 1
                };
                Some(((current + offset) % audio.queue.len(), audio.queue.clone()))
            }
            "toggle" => {
                if let Some(player) = &audio.player {
                    if player.is_paused() {
                        player.play()
                    } else {
                        player.pause()
                    }
                }
                None
            }
            "seek" => {
                if let Some(player) = &audio.player {
                    player
                        .try_seek(Duration::from_secs_f64(
                            payload
                                .get("seconds")
                                .and_then(Value::as_f64)
                                .unwrap_or(0.0)
                                .max(0.0),
                        ))
                        .map_err(|error| error.to_string())?;
                }
                None
            }
            "volume" => {
                audio.volume = payload
                    .get("value")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.5)
                    .clamp(0.0, 1.0) as f32;
                if let Some(player) = &audio.player {
                    player.set_volume(audio.volume)
                }
                None
            }
            "repeat" => {
                audio.repeat = payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                None
            }
            "shuffle" => {
                audio.shuffle = payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                None
            }
            "stop" => {
                audio.player.take();
                audio.active.clear();
                audio.queue.clear();
                None
            }
            _ => return Err(format!("unsupported desktop player command: {command}")),
        }
    };
    if let Some((selected, queue)) = switch {
        return start_audio((*state).clone(), handle, queue, selected).await;
    }
    desktop_player_state(state, handle).await
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
        close_audio_device(&mut registry.audio);
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

    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(
        tauri_plugin_localhost::Builder::new(LOCALHOST_PORT)
            .host("127.0.0.1")
            .build(),
    );

    builder
        .setup(move |_app| {
            #[cfg(all(desktop, not(debug_assertions)))]
            _app.get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main webview window is missing"))?
                .navigate(format!("http://127.0.0.1:{LOCALHOST_PORT}").parse()?)?;

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
            desktop_prepare_play,
            desktop_play_uploaded,
            desktop_queue_uploaded,
            desktop_play,
            desktop_player_state,
            desktop_player_command,
            desktop_cached_track_ids,
            desktop_cache_track,
            desktop_cache_progress,
            desktop_set_offline_only,
            desktop_cache_stats,
            desktop_close,
            desktop_generate_identity,
            desktop_endpoint_id_for_secret,
            desktop_parse_ticket,
        ])
        .build(tauri::generate_context!())
        .expect("error while building iroh-fm desktop")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                close_native_audio(&app.state::<DesktopState>());
            }
        });
}
