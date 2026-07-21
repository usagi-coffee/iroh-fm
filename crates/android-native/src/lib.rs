use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Arc, LazyLock, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use client::{Client, IrohConfig};
use iroh::{EndpointAddr, EndpointId, RelayUrl, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use jni::{
    JNIEnv,
    objects::{JByteArray, JClass, JObject, JString},
    sys::{jboolean, jbyteArray, jint, jlong, jstring},
};
use protocol::{BackendRequest, BackendResponse, CoverArtId, TrackId};
use serde::{Deserialize, Serialize};
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| Runtime::new().expect("tokio runtime"));
static STATE: LazyLock<Mutex<NativeState>> = LazyLock::new(|| Mutex::new(NativeState::default()));
#[cfg(target_os = "android")]
static ANDROID_APPLICATION_CONTEXT: std::sync::OnceLock<jni::objects::GlobalRef> =
    std::sync::OnceLock::new();

#[derive(Default)]
struct NativeState {
    next_handle: i64,
    clients: HashMap<i64, Client>,
    streams: HashMap<i64, Arc<NativeStream>>,
}

struct NativeStream {
    recv: tokio::sync::Mutex<iroh::endpoint::RecvStream>,
    cancellation: CancellationToken,
}

#[derive(Deserialize)]
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
    handle: i64,
    endpoint_id: String,
    remote_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedStream {
    handle: i64,
    content_type: String,
    file_size: u64,
}

fn next_handle(state: &mut NativeState) -> i64 {
    state.next_handle = state.next_handle.saturating_add(1).max(1);
    state.next_handle
}

fn to_rust_string(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, String> {
    env.get_string(&value)
        .map(String::from)
        .map_err(|error| error.to_string())
}

fn java_string(env: &mut JNIEnv<'_>, value: Result<String, String>) -> jstring {
    let payload = match value {
        Ok(value) => serde_json::json!({ "ok": value }),
        Err(error) => serde_json::json!({ "error": error }),
    }
    .to_string();
    env.new_string(payload)
        .map(|value| value.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

fn client_for(handle: i64) -> Result<Client, String> {
    STATE
        .lock()
        .map_err(|_| "native state lock poisoned".to_string())?
        .clients
        .get(&handle)
        .cloned()
        .ok_or_else(|| "native client is closed".to_string())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_initialize(
    mut env: JNIEnv,
    _class: JClass,
    _application_context: JObject,
) -> jstring {
    #[cfg(target_os = "android")]
    let result = (|| {
        if ANDROID_APPLICATION_CONTEXT.get().is_none() {
            let vm = env.get_java_vm().map_err(|error| error.to_string())?;
            let context = env
                .new_global_ref(_application_context)
                .map_err(|error| error.to_string())?;
            unsafe {
                iroh_dns::install_android_jni_context(
                    vm.get_java_vm_pointer().cast(),
                    context.as_obj().as_raw().cast(),
                );
            }
            ANDROID_APPLICATION_CONTEXT
                .set(context)
                .map_err(|_| "Android application context was already initialized".to_string())?;
        }
        Ok("initialized".to_string())
    })();
    #[cfg(not(target_os = "android"))]
    let result: Result<String, String> = Ok("initialized".to_string());
    java_string(&mut env, result)
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
        if relay.trim().is_empty() {
            continue;
        }
        address = address.with_relay_url(
            RelayUrl::from_str(relay.trim())
                .map_err(|error| format!("invalid relay URL: {error}"))?,
        );
    }
    Ok(address)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_connect(
    mut env: JNIEnv,
    _class: JClass,
    options: JString,
) -> jstring {
    let result = (|| {
        let options: ConnectOptions = serde_json::from_str(&to_rust_string(&mut env, options)?)
            .map_err(|error| error.to_string())?;
        let address = address(&options)?;
        let config = IrohConfig {
            secret: options.secret.filter(|value| !value.trim().is_empty()),
            ..IrohConfig::default()
        };
        let client = RUNTIME
            .block_on(Client::connect_addr_with_config(address, config))
            .map_err(|error| error.to_string())?;
        let mut state = STATE.lock().map_err(|_| "native state lock poisoned")?;
        let handle = next_handle(&mut state);
        let connected = Connected {
            handle,
            endpoint_id: client.endpoint_id().to_string(),
            remote_id: client.remote_id().to_string(),
        };
        state.clients.insert(handle, client);
        serde_json::to_string(&connected).map_err(|error| error.to_string())
    })();
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_request(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    request: JString,
) -> jstring {
    let result = (|| {
        let request: BackendRequest = serde_json::from_str(&to_rust_string(&mut env, request)?)
            .map_err(|error| error.to_string())?;
        let response = RUNTIME
            .block_on(client_for(handle)?.request(request))
            .map_err(|error| error.to_string())?;
        serde_json::to_string(&response).map_err(|error| error.to_string())
    })();
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_coverArt(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    cover_art_id: JString,
    full_quality: jboolean,
) -> jstring {
    let result = (|| {
        let cover_art_id = CoverArtId(to_rust_string(&mut env, cover_art_id)?);
        let response = RUNTIME
            .block_on(client_for(handle)?.request(BackendRequest::GetCoverArt {
                cover_art_id,
                full_quality: full_quality != 0,
            }))
            .map_err(|error| error.to_string())?;
        let BackendResponse::CoverArt(cover) = response else {
            return Err("backend returned an unexpected cover response".to_string());
        };
        serde_json::to_string(&serde_json::json!({
            "contentType": cover.content_type,
            "bytesBase64": BASE64.encode(cover.bytes),
        }))
        .map_err(|error| error.to_string())
    })();
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_connectionInfo(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let result = (|| {
        let info = RUNTIME
            .block_on(client_for(handle)?.connection_info())
            .map_err(|error| error.to_string())?;
        serde_json::to_string(&info).map_err(|error| error.to_string())
    })();
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_openStream(
    mut env: JNIEnv,
    _class: JClass,
    client_handle: jlong,
    track_id: JString,
) -> jstring {
    let result = (|| {
        let track_id = to_rust_string(&mut env, track_id)?;
        let (descriptor, stream) = RUNTIME
            .block_on(client_for(client_handle)?.stream_open(TrackId(track_id)))
            .map_err(|error| error.to_string())?;
        let mut state = STATE.lock().map_err(|_| "native state lock poisoned")?;
        let handle = next_handle(&mut state);
        state.streams.insert(
            handle,
            Arc::new(NativeStream {
                recv: tokio::sync::Mutex::new(stream),
                cancellation: CancellationToken::new(),
            }),
        );
        serde_json::to_string(&OpenedStream {
            handle,
            content_type: descriptor.content_type,
            file_size: descriptor.file_size,
        })
        .map_err(|error| error.to_string())
    })();
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_readStream(
    env: JNIEnv,
    _class: JClass,
    stream_handle: jlong,
    destination: JByteArray,
    offset: jint,
    length: jint,
) -> jint {
    if offset < 0 || length < 0 {
        return -2;
    }
    let stream = match STATE.lock() {
        Ok(state) => state.streams.get(&stream_handle).cloned(),
        Err(_) => return -2,
    };
    let Some(stream) = stream else {
        return -2;
    };
    let mut buffer = vec![0_u8; length as usize];
    let read = match RUNTIME.block_on(async {
        tokio::select! {
            _ = stream.cancellation.cancelled() => Ok(None),
            result = async { stream.recv.lock().await.read(&mut buffer).await } => result,
        }
    }) {
        Ok(None | Some(0)) => return -1,
        Ok(Some(read)) => read,
        Err(_) => return -2,
    };
    match env.set_byte_array_region(
        &destination,
        offset,
        &buffer[..read]
            .iter()
            .map(|byte| *byte as i8)
            .collect::<Vec<_>>(),
    ) {
        Ok(()) => read as jint,
        Err(_) => -2,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_closeStream(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    let stream = STATE
        .lock()
        .ok()
        .and_then(|mut state| state.streams.remove(&handle));
    if let Some(stream) = stream {
        stream.cancellation.cancel();
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_closeClient(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if let Ok(mut state) = STATE.lock() {
        state.clients.remove(&handle);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_generateIdentity(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = {
        let secret = SecretKey::generate();
        let encoded = secret
            .to_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        serde_json::to_string(&serde_json::json!({
            "secret": encoded,
            "endpointId": secret.public().to_string(),
        }))
        .map_err(|error| error.to_string())
    };
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_endpointIdForSecret(
    mut env: JNIEnv,
    _class: JClass,
    secret: JString,
) -> jstring {
    let result = to_rust_string(&mut env, secret).and_then(|secret| {
        SecretKey::from_str(secret.trim())
            .map(|secret| secret.public().to_string())
            .map_err(|error| error.to_string())
    });
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_parseTicket(
    mut env: JNIEnv,
    _class: JClass,
    ticket: JString,
) -> jstring {
    let result = to_rust_string(&mut env, ticket).and_then(|ticket| {
        let ticket = EndpointTicket::from_str(ticket.trim()).map_err(|error| error.to_string())?;
        serde_json::to_string(&serde_json::json!({
            "endpointId": ticket.endpoint_addr().id.to_string(),
            "relays": ticket.endpoint_addr().relay_urls().map(ToString::to_string).collect::<Vec<_>>(),
        }))
        .map_err(|error| error.to_string())
    });
    java_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fm_iroh_android_NativeCore_emptyBytes(
    env: JNIEnv,
    _class: JClass,
) -> jbyteArray {
    env.new_byte_array(0)
        .map(|array| array.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
