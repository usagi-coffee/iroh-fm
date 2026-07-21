use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::Arc,
    time::Duration,
};

use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{DesktopState, track};

const CROSSFADE: Duration = Duration::from_millis(1_500);
const CROSSFADE_STEPS: u32 = 30;
const QUEUE_MONITOR_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Default, Serialize)]
pub(super) struct DesktopTransfer {
    pub(super) received: u64,
    pub(super) total: u64,
    pub(super) active: bool,
    pub(super) cached: bool,
    #[serde(rename = "memoryCached")]
    pub(super) memory_cached: bool,
}

pub(super) struct DesktopAudio {
    device: Option<MixerDeviceSink>,
    player: Option<Arc<Player>>,
    pub(super) client_handle: u64,
    generation: u64,
    queue: Vec<String>,
    active: VecDeque<usize>,
    prefetching: Option<usize>,
    loading: bool,
    volume: f32,
    repeat: bool,
    shuffle: bool,
    pub(super) transfers: HashMap<String, DesktopTransfer>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopPlayerState {
    generation: u64,
    track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_index: Option<usize>,
    playing: bool,
    loading: bool,
    position: f64,
    duration: f64,
    repeat: bool,
    shuffle: bool,
    volume: f32,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    transfers: HashMap<String, DesktopTransfer>,
}

fn decoder(bytes: Vec<u8>) -> Result<Decoder<Cursor<Vec<u8>>>, String> {
    let byte_len = bytes.len() as u64;
    Decoder::builder()
        .with_data(Cursor::new(bytes))
        .with_byte_len(byte_len)
        .with_seekable(true)
        .with_coarse_seek(true)
        .build()
        .map_err(|error| error.to_string())
}

fn sync_active(active: &mut VecDeque<usize>, remaining: usize) {
    while active.len() > remaining {
        active.pop_front();
    }
}

fn sync(audio: &mut DesktopAudio) {
    let remaining = audio.player.as_ref().map_or(0, |player| player.len());
    sync_active(&mut audio.active, remaining);
}

pub(super) fn close(audio: &mut DesktopAudio) {
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

pub(super) fn close_native(state: &DesktopState) {
    if let Ok(mut registry) = state.0.lock() {
        close(&mut registry.audio);
    }
}

fn snapshot(
    audio: &mut DesktopAudio,
    include_queue: bool,
    drain_completed_transfers: bool,
) -> DesktopPlayerState {
    sync(audio);
    let current_index = audio.active.front().copied().unwrap_or(0);
    let transfers = audio.transfers.clone();
    if drain_completed_transfers {
        // Active transfers remain available to progress polls. A completed
        // transfer is a one-shot notification and must not grow every later state.
        audio.transfers.retain(|_, transfer| transfer.active);
    }
    DesktopPlayerState {
        generation: audio.generation,
        track_id: audio
            .active
            .front()
            .and_then(|index| audio.queue.get(*index))
            .cloned(),
        queue: include_queue.then(|| audio.queue.clone()),
        current_index: include_queue.then_some(current_index),
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
        transfers,
    }
}

fn next_prefetch_index(audio: &DesktopAudio) -> Option<usize> {
    if audio.queue.len() < 2 || audio.active.len() >= 2 || audio.prefetching.is_some() {
        return None;
    }
    let current = audio.active.front().copied()?;
    let next = (current + 1) % audio.queue.len();
    (!audio.active.contains(&next)).then_some(next)
}

fn schedule_prefetch(state: DesktopState, client_handle: u64) {
    let scheduled = {
        let mut registry = match state.0.lock() {
            Ok(registry) => registry,
            Err(_) => return,
        };
        let audio = &mut registry.audio;
        sync(audio);
        let Some(next) = next_prefetch_index(audio) else {
            return;
        };
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
        let result = track::download(state.clone(), client, track_id.clone())
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

fn monitor_queue(state: DesktopState, client_handle: u64, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(QUEUE_MONITOR_INTERVAL).await;
            let running = {
                let mut registry = match state.0.lock() {
                    Ok(registry) => registry,
                    Err(_) => return,
                };
                let audio = &mut registry.audio;
                if audio.generation != generation {
                    false
                } else {
                    sync(audio);
                    audio.player.is_some() && !audio.queue.is_empty()
                }
            };
            if !running {
                return;
            }
            schedule_prefetch(state.clone(), client_handle);
        }
    });
}

async fn start(
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
    let source = track::download(state.clone(), client, track_id.clone())
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
            audio.device.as_ref().expect("device exists").mixer(),
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
        (snapshot(audio, true, true), outgoing, player)
    };
    if let Some(outgoing) = outgoing {
        let fade_state = state.clone();
        tauri::async_runtime::spawn(async move {
            for step in 1..=CROSSFADE_STEPS {
                tokio::time::sleep(CROSSFADE / CROSSFADE_STEPS).await;
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
    schedule_prefetch(state.clone(), client_handle);
    monitor_queue(state, client_handle, generation);
    Ok(result)
}

#[tauri::command]
pub(super) async fn desktop_play(
    state: State<'_, DesktopState>,
    handle: u64,
    track_id: String,
    queue: Vec<String>,
) -> Result<DesktopPlayerState, String> {
    let selected = queue
        .iter()
        .position(|id| id == &track_id)
        .ok_or_else(|| "selected track is not in the desktop queue".to_string())?;
    start((*state).clone(), handle, queue, selected).await
}

#[tauri::command]
pub(super) async fn desktop_player_state(
    state: State<'_, DesktopState>,
    handle: u64,
    include_queue: Option<bool>,
) -> Result<DesktopPlayerState, String> {
    let result = {
        let mut registry = state
            .0
            .lock()
            .map_err(|_| "desktop native registry lock poisoned".to_string())?;
        snapshot(&mut registry.audio, include_queue.unwrap_or(false), true)
    };
    let _ = handle;
    Ok(result)
}

#[tauri::command]
pub(super) fn desktop_cache_progress(
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
pub(super) async fn desktop_player_command(
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
        sync(audio);
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
        return start((*state).clone(), handle, queue, selected).await;
    }
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "desktop native registry lock poisoned".to_string())?;
    Ok(snapshot(&mut registry.audio, false, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_state_omits_queue_and_drains_completed_transfers() {
        let mut audio = DesktopAudio {
            queue: vec!["first".into(), "second".into()],
            transfers: HashMap::from([
                (
                    "first".into(),
                    DesktopTransfer {
                        received: 10,
                        total: 10,
                        active: false,
                        cached: true,
                        memory_cached: false,
                    },
                ),
                (
                    "second".into(),
                    DesktopTransfer {
                        received: 5,
                        total: 10,
                        active: true,
                        cached: false,
                        memory_cached: false,
                    },
                ),
            ]),
            ..DesktopAudio::default()
        };

        let compact = snapshot(&mut audio, false, true);
        assert!(compact.queue.is_none());
        assert!(compact.current_index.is_none());
        assert_eq!(compact.transfers.len(), 2);
        assert!(!audio.transfers.contains_key("first"));
        assert!(audio.transfers.contains_key("second"));

        let full = snapshot(&mut audio, true, false);
        assert_eq!(full.queue.as_deref(), Some(audio.queue.as_slice()));
        assert!(full.current_index.is_some());
    }

    #[test]
    fn completed_sources_advance_the_active_queue() {
        let mut active = VecDeque::from([3, 4, 5]);

        sync_active(&mut active, 2);
        assert_eq!(active, VecDeque::from([4, 5]));

        sync_active(&mut active, 1);
        assert_eq!(active, VecDeque::from([5]));
    }

    #[test]
    fn automatic_advance_opens_another_prefetch_slot() {
        let mut audio = DesktopAudio {
            queue: vec!["first".into(), "second".into(), "third".into()],
            active: VecDeque::from([0, 1]),
            ..DesktopAudio::default()
        };

        assert_eq!(next_prefetch_index(&audio), None);
        sync_active(&mut audio.active, 1);
        assert_eq!(next_prefetch_index(&audio), Some(2));
    }
}
