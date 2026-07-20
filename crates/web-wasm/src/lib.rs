use std::{cell::RefCell, fmt::Write, rc::Rc, str::FromStr};

use futures_util::{
    StreamExt,
    future::{AbortHandle, Abortable},
};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr, endpoint::Connection,
    endpoint::presets,
};
use iroh_tickets::endpoint::EndpointTicket;
use js_sys::Uint8Array;
use protocol::{BackendRequest, BackendResponse, CoverArtId, IROH_ALPN, TrackId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

const MAX_MESSAGE_SIZE: u32 = 64 * 1024 * 1024;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// Browser-native iroh client for the iroh-fm protocol.
///
/// This is intentionally application-specific: the general-purpose
/// `@number0/iroh` package uses Node N-API and cannot run in a browser.
#[wasm_bindgen]
pub struct IrohFmClient {
    endpoint: Endpoint,
    connection: Connection,
    remote_id: String,
    cover_requests: Rc<RefCell<Vec<AbortHandle>>>,
}

#[wasm_bindgen]
impl IrohFmClient {
    /// Create a browser endpoint and connect using an iroh endpoint ticket.
    #[wasm_bindgen(js_name = connect)]
    pub async fn connect(ticket: String, secret: Option<String>) -> Result<IrohFmClient, JsError> {
        let ticket = EndpointTicket::from_str(ticket.trim())
            .map_err(|error| js_error(format!("invalid endpoint ticket: {error}")))?;
        Self::connect_addr(ticket.endpoint_addr().clone(), secret).await
    }

    /// Connect from the two address components exposed by an endpoint ticket.
    /// Browser connections require a relay because direct UDP is unavailable.
    #[wasm_bindgen(js_name = connectAdvanced)]
    pub async fn connect_advanced(
        endpoint_id: String,
        relays_json: String,
        secret: Option<String>,
    ) -> Result<IrohFmClient, JsError> {
        let endpoint_id = EndpointId::from_str(endpoint_id.trim())
            .map_err(|error| js_error(format!("invalid server endpoint ID: {error}")))?;
        let relays: Vec<String> = serde_json::from_str(&relays_json)
            .map_err(|error| js_error(format!("invalid relay list: {error}")))?;
        if relays.is_empty() {
            return Err(js_error(
                "browser connections require at least one relay URL",
            ));
        }
        let mut address = EndpointAddr::new(endpoint_id);
        for relay in relays {
            let relay = RelayUrl::from_str(relay.trim())
                .map_err(|error| js_error(format!("invalid relay URL: {error}")))?;
            address = address.with_relay_url(relay);
        }
        Self::connect_addr(address, secret).await
    }

    #[wasm_bindgen(getter, js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    #[wasm_bindgen(getter, js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.remote_id.clone()
    }

    #[wasm_bindgen(js_name = connectionInfo)]
    pub fn connection_info(&self) -> Result<String, JsError> {
        let paths = self.connection.paths();
        let selected = paths.iter().find(|path| path.is_selected());
        let (path_type, address) = match selected {
            Some(path) => match path.remote_addr() {
                TransportAddr::Relay(relay) => ("relay", relay.to_string()),
                TransportAddr::Ip(address) => ("direct", address.to_string()),
                TransportAddr::Custom(address) => ("custom", format!("{address:?}")),
                other => ("unknown", format!("{other:?}")),
            },
            None => ("unknown", String::new()),
        };
        serde_json::to_string(&ConnectionInfo {
            path_type,
            address,
            received_bytes: self.connection.stats().udp_rx.bytes,
        })
        .map_err(to_js_error)
    }

    /// Execute any non-streaming BackendRequest. JSON keeps the JS boundary
    /// stable and exactly matches the serde protocol used by the Rust server.
    pub async fn request(&self, request_json: String) -> Result<String, JsError> {
        let request: BackendRequest = serde_json::from_str(&request_json).map_err(to_js_error)?;
        if matches!(request, BackendRequest::OpenStream { .. }) {
            return Err(js_error("use openTrack() for audio streams"));
        }
        let response = self.rpc(request).await?;
        serde_json::to_string(&response).map_err(to_js_error)
    }

    /// Fetch artwork without expanding its byte payload across JSON/JS arrays.
    #[wasm_bindgen(js_name = fetchCover)]
    pub async fn fetch_cover(
        &self,
        cover_art_id: String,
        full_quality: bool,
    ) -> Result<MediaBytes, JsError> {
        let (abort_handle, abort_registration) = AbortHandle::new_pair();
        self.cover_requests.borrow_mut().push(abort_handle.clone());
        let response = Abortable::new(
            self.rpc(BackendRequest::GetCoverArt {
                cover_art_id: CoverArtId(cover_art_id),
                full_quality,
            }),
            abort_registration,
        )
        .await;
        abort_handle.abort();
        self.cover_requests
            .borrow_mut()
            .retain(|handle| !handle.is_aborted());
        match response.map_err(|_| js_error("cover request preempted by audio playback"))?? {
            BackendResponse::CoverArt(cover) => Ok(MediaBytes {
                content_type: cover.content_type,
                bytes: cover.bytes,
            }),
            response => Err(unexpected_response("cover art", &response)),
        }
    }

    /// Cancel in-flight artwork streams so an explicitly selected track can
    /// open immediately on constrained relay connections.
    #[wasm_bindgen(js_name = prioritizeAudio)]
    pub fn prioritize_audio(&self) {
        for request in self.cover_requests.borrow_mut().drain(..) {
            request.abort();
        }
    }

    /// Open an audio stream and expose its media bytes as a browser-native
    /// ReadableStream. JavaScript can progressively feed supported codecs to a
    /// MediaSource without buffering the complete track in WASM memory.
    #[wasm_bindgen(js_name = openTrack)]
    pub async fn open_track(&self, track_id: String) -> Result<MediaStream, JsError> {
        let (mut send, mut recv) = self.connection.open_bi().await.map_err(to_js_error)?;
        write_json(
            &mut send,
            &BackendRequest::OpenStream {
                track_id: TrackId(track_id),
            },
        )
        .await?;
        send.finish().map_err(to_js_error)?;

        let descriptor = match read_response(&mut recv).await? {
            BackendResponse::Stream(descriptor) => descriptor,
            response => return Err(unexpected_response("audio stream", &response)),
        };
        let stream = ReaderStream::with_capacity(recv, 256 * 1024).map(|chunk| match chunk {
            Ok(bytes) => Ok(Uint8Array::from(bytes.as_ref()).into()),
            Err(error) => Err(js_error(error.to_string()).into()),
        });
        Ok(MediaStream {
            content_type: descriptor.content_type,
            file_size: descriptor.file_size,
            stream: Some(ReadableStream::from_stream(stream).into_raw()),
        })
    }

    pub async fn close(&self) {
        self.connection.close(0u8.into(), b"web client closed");
        self.endpoint.close().await;
    }
}

/// A persistent browser identity generated locally. The secret never needs to
/// leave the browser; its endpoint ID is safe to use in server allowlists.
#[wasm_bindgen]
pub struct ClientIdentity {
    secret: String,
    endpoint_id: String,
}

#[derive(serde::Serialize)]
struct ConnectionInfo {
    path_type: &'static str,
    address: String,
    received_bytes: u64,
}

#[wasm_bindgen]
impl ClientIdentity {
    #[wasm_bindgen(getter)]
    pub fn secret(&self) -> String {
        self.secret.clone()
    }

    #[wasm_bindgen(getter, js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint_id.clone()
    }
}

#[wasm_bindgen(js_name = generateIdentity)]
pub fn generate_identity() -> Result<ClientIdentity, JsError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| js_error(format!("could not generate a browser identity: {error}")))?;
    let secret = SecretKey::from_bytes(&bytes);
    let mut encoded_secret = String::with_capacity(64);
    for byte in bytes {
        write!(encoded_secret, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(ClientIdentity {
        endpoint_id: secret.public().to_string(),
        secret: encoded_secret,
    })
}

#[wasm_bindgen(js_name = endpointIdForSecret)]
pub fn endpoint_id_for_secret(secret: String) -> Result<String, JsError> {
    SecretKey::from_str(secret.trim())
        .map(|secret| secret.public().to_string())
        .map_err(|error| js_error(format!("invalid client secret: {error}")))
}

/// Decode the address fields from a ticket without opening a connection.
#[wasm_bindgen(js_name = parseEndpointTicket)]
pub fn parse_endpoint_ticket(ticket: String) -> Result<String, JsError> {
    let ticket = EndpointTicket::from_str(ticket.trim())
        .map_err(|error| js_error(format!("invalid endpoint ticket: {error}")))?;
    serde_json::to_string(&ticket_address(&ticket)).map_err(to_js_error)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketAddress {
    endpoint_id: String,
    relays: Vec<String>,
}

fn ticket_address(ticket: &EndpointTicket) -> TicketAddress {
    let address = ticket.endpoint_addr();
    TicketAddress {
        endpoint_id: address.id.to_string(),
        relays: address.relay_urls().map(ToString::to_string).collect(),
    }
}

#[wasm_bindgen]
pub struct MediaStream {
    content_type: String,
    file_size: u64,
    stream: Option<JsReadableStream>,
}

#[wasm_bindgen]
impl MediaStream {
    #[wasm_bindgen(getter, js_name = contentType)]
    pub fn content_type(&self) -> String {
        self.content_type.clone()
    }

    #[wasm_bindgen(getter, js_name = fileSize)]
    pub fn file_size(&self) -> f64 {
        self.file_size as f64
    }

    /// Transfer ownership of the receive stream to JavaScript.
    #[wasm_bindgen(js_name = takeStream)]
    pub fn take_stream(&mut self) -> Result<JsReadableStream, JsError> {
        self.stream
            .take()
            .ok_or_else(|| js_error("audio stream was already taken"))
    }
}

#[wasm_bindgen]
pub struct MediaBytes {
    content_type: String,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl MediaBytes {
    #[wasm_bindgen(getter, js_name = contentType)]
    pub fn content_type(&self) -> String {
        self.content_type.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

impl IrohFmClient {
    async fn connect_addr(
        address: EndpointAddr,
        secret: Option<String>,
    ) -> Result<IrohFmClient, JsError> {
        let remote_id = address.id.to_string();
        let mut builder = Endpoint::builder(presets::N0);
        if let Some(secret) = secret.filter(|secret| !secret.trim().is_empty()) {
            let secret = SecretKey::from_str(secret.trim())
                .map_err(|error| js_error(format!("invalid client secret: {error}")))?;
            builder = builder.secret_key(secret);
        }
        let endpoint = builder.bind().await.map_err(to_js_error)?;
        let connection = endpoint
            .connect(address, IROH_ALPN)
            .await
            .map_err(to_js_error)?;
        Ok(Self {
            endpoint,
            connection,
            remote_id,
            cover_requests: Rc::new(RefCell::new(Vec::new())),
        })
    }

    async fn rpc(&self, request: BackendRequest) -> Result<BackendResponse, JsError> {
        let (mut send, mut recv) = self.connection.open_bi().await.map_err(to_js_error)?;
        write_json(&mut send, &request).await?;
        send.finish().map_err(to_js_error)?;
        read_response(&mut recv).await
    }
}

async fn write_json<T: serde::Serialize>(
    send: &mut iroh::endpoint::SendStream,
    value: &T,
) -> Result<(), JsError> {
    let bytes = serde_json::to_vec(value).map_err(to_js_error)?;
    let len = u32::try_from(bytes.len()).map_err(|_| js_error("request is too large"))?;
    send.write_u32(len).await.map_err(to_js_error)?;
    send.write_all(&bytes).await.map_err(to_js_error)?;
    Ok(())
}

async fn read_json<T: serde::de::DeserializeOwned>(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<T, JsError> {
    let len = recv.read_u32().await.map_err(to_js_error)?;
    if len > MAX_MESSAGE_SIZE {
        return Err(js_error("backend response is too large"));
    }
    let mut bytes = vec![0; len as usize];
    recv.read_exact(&mut bytes).await.map_err(to_js_error)?;
    serde_json::from_slice(&bytes).map_err(to_js_error)
}

async fn read_response(recv: &mut iroh::endpoint::RecvStream) -> Result<BackendResponse, JsError> {
    match read_json(recv).await? {
        BackendResponse::Error { message } => Err(js_error(message)),
        response => Ok(response),
    }
}

fn unexpected_response(expected: &str, response: &BackendResponse) -> JsError {
    js_error(format!(
        "backend returned an unexpected response for {expected}: {response:?}"
    ))
}

fn js_error(message: impl AsRef<str>) -> JsError {
    JsError::new(message.as_ref())
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    js_error(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_address_preserves_all_relays() {
        let endpoint_id = SecretKey::from_bytes(&[7; 32]).public();
        let address = EndpointAddr::new(endpoint_id)
            .with_relay_url("https://one.example".parse().unwrap())
            .with_relay_url("https://two.example".parse().unwrap());
        let details = ticket_address(&EndpointTicket::from(address));

        assert_eq!(details.endpoint_id, endpoint_id.to_string());
        assert_eq!(details.relays.len(), 2);
        assert!(details.relays.iter().any(|url| url.contains("one.example")));
        assert!(details.relays.iter().any(|url| url.contains("two.example")));
    }
}
