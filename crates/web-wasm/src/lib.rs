use std::str::FromStr;

use futures_util::StreamExt;
use iroh::{Endpoint, endpoint::Connection, endpoint::presets};
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
}

#[wasm_bindgen]
impl IrohFmClient {
    /// Create a browser endpoint and connect using an iroh endpoint ticket.
    #[wasm_bindgen(js_name = connect)]
    pub async fn connect(ticket: String) -> Result<IrohFmClient, JsError> {
        let ticket = EndpointTicket::from_str(ticket.trim())
            .map_err(|error| js_error(format!("invalid endpoint ticket: {error}")))?;
        let remote_id = ticket.endpoint_addr().id.to_string();
        let endpoint = Endpoint::builder(presets::N0)
            .bind()
            .await
            .map_err(to_js_error)?;
        let connection = endpoint
            .connect(ticket.endpoint_addr().clone(), IROH_ALPN)
            .await
            .map_err(to_js_error)?;
        Ok(Self {
            endpoint,
            connection,
            remote_id,
        })
    }

    #[wasm_bindgen(getter, js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    #[wasm_bindgen(getter, js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.remote_id.clone()
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
    pub async fn fetch_cover(&self, cover_art_id: String) -> Result<MediaBytes, JsError> {
        match self
            .rpc(BackendRequest::GetCoverArt {
                cover_art_id: CoverArtId(cover_art_id),
            })
            .await?
        {
            BackendResponse::CoverArt(cover) => Ok(MediaBytes {
                content_type: cover.content_type,
                bytes: cover.bytes,
            }),
            response => Err(unexpected_response("cover art", &response)),
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
            stream: Some(ReadableStream::from_stream(stream).into_raw()),
        })
    }

    pub async fn close(&self) {
        self.connection.close(0u8.into(), b"web client closed");
        self.endpoint.close().await;
    }
}

#[wasm_bindgen]
pub struct MediaStream {
    content_type: String,
    stream: Option<JsReadableStream>,
}

#[wasm_bindgen]
impl MediaStream {
    #[wasm_bindgen(getter, js_name = contentType)]
    pub fn content_type(&self) -> String {
        self.content_type.clone()
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
