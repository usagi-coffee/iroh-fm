mod error;

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::Arc;

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, RecvStream, presets},
};
#[cfg(not(target_os = "android"))]
use iroh_mdns_address_lookup::MdnsAddressLookup;
use protocol::IROH_ALPN;
pub use protocol::{
    Album, AlbumId, Artist, ArtistId, BackendRequest, BackendResponse, CoverArtBytes, CoverArtId,
    Playlist, PlaylistId, ResolvedId, SearchQuery, StarredSet, StreamDescriptor, Track, TrackId,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::{Duration, timeout};
use ts_rs::TS;

pub use crate::error::{Error, Result};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const ENDPOINT_BIND_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(target_os = "android")]
#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(
        priority: std::ffi::c_int,
        tag: *const std::ffi::c_char,
        text: *const std::ffi::c_char,
    ) -> std::ffi::c_int;
}

fn rpc_log(arguments: std::fmt::Arguments<'_>) {
    #[cfg(target_os = "android")]
    {
        const ANDROID_LOG_DEBUG: std::ffi::c_int = 3;
        if let Ok(message) = std::ffi::CString::new(arguments.to_string()) {
            unsafe {
                __android_log_write(
                    ANDROID_LOG_DEBUG,
                    c"iroh.fm.rust".as_ptr(),
                    message.as_ptr(),
                );
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    eprintln!("{arguments}");
}

macro_rules! rpc_log {
    ($($argument:tt)*) => {
        rpc_log(format_args!($($argument)*))
    };
}

#[derive(Debug, Clone, Default)]
pub struct IrohConfig {
    pub secret: Option<String>,
    pub relay: Option<String>,
    pub peers: BTreeSet<EndpointId>,
}

#[derive(Debug, Clone)]
pub struct Client {
    endpoint: Endpoint,
    addr: EndpointAddr,
    conn: Arc<Mutex<Option<Connection>>>,
    last_path: Arc<Mutex<Option<String>>>,
}

impl Client {
    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    pub fn remote_id(&self) -> EndpointId {
        self.addr.id
    }

    pub async fn connection_info(&self) -> Result<ConnectionInfo> {
        let connection = self.connection().await?;
        let paths = connection.paths();
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
        Ok(ConnectionInfo {
            path_type: path_type.to_string(),
            address,
            received_bytes: connection.stats().udp_rx.bytes,
        })
    }

    pub async fn connect(endpoint_id: EndpointId, relay: Option<RelayUrl>) -> Result<Self> {
        rpc_log!(
            "[client-rpc] local endpoint startup remote_endpoint={} relay={}",
            endpoint_id,
            relay
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "<none>".to_string())
        );
        let addr = match relay {
            Some(relay_url) => EndpointAddr::new(endpoint_id).with_relay_url(relay_url),
            None => EndpointAddr::new(endpoint_id),
        };
        Self::connect_addr(addr).await
    }

    pub async fn connect_addr(addr: EndpointAddr) -> Result<Self> {
        Self::connect_addr_with_config(addr, IrohConfig::default()).await
    }

    pub async fn connect_addr_with_config(addr: EndpointAddr, config: IrohConfig) -> Result<Self> {
        rpc_log!("[client-rpc] local endpoint startup remote_addr={addr:?}");
        let builder = endpoint_builder(&config);
        rpc_log!(
            "[client-rpc] local endpoint bind task spawned mdns={}",
            if cfg!(target_os = "android") {
                "disabled"
            } else {
                "enabled"
            }
        );
        let mut bind_task = tokio::spawn(async move { builder.bind().await });
        let endpoint = match timeout(ENDPOINT_BIND_TIMEOUT, &mut bind_task).await {
            Ok(result) => result.map_err(|error| {
                Error::InvalidRequest(format!("local endpoint startup task failed: {error}"))
            })??,
            Err(_) => {
                bind_task.abort();
                rpc_log!(
                    "[client-rpc] local endpoint startup timed out after {}s",
                    ENDPOINT_BIND_TIMEOUT.as_secs()
                );
                return Err(Error::Timeout("local endpoint startup".to_string()));
            }
        };
        rpc_log!(
            "[client-rpc] local endpoint ready local_endpoint={}",
            endpoint.id()
        );
        let client = Self {
            endpoint,
            addr,
            conn: Arc::new(Mutex::new(None)),
            last_path: Arc::new(Mutex::new(None)),
        };
        let _ = client.connection().await?;
        Ok(client)
    }

    pub async fn request(&self, request: BackendRequest) -> Result<BackendResponse> {
        rpc_log!("[client-rpc] request start kind={}", request_name(&request));
        let conn = self.connection().await?;
        match self
            .request_on_connection_with_timeout(&conn, &request)
            .await
        {
            Ok(response) => {
                rpc_log!("[client-rpc] request ok kind={}", request_name(&request));
                self.log_connection_path_if_changed(&conn, "request").await;
                Ok(response)
            }
            Err(error) => {
                rpc_log!(
                    "[client-rpc] request failed kind={} error={error}; reconnecting once",
                    request_name(&request)
                );
                self.clear_connection().await;
                let conn = self.connection().await?;
                let response = self
                    .request_on_connection_with_timeout(&conn, &request)
                    .await?;
                rpc_log!("[client-rpc] request ok kind={}", request_name(&request));
                self.log_connection_path_if_changed(&conn, "request").await;
                Ok(response)
            }
        }
    }

    pub async fn stream_open(&self, track_id: TrackId) -> Result<(StreamDescriptor, RecvStream)> {
        rpc_log!("[client-rpc] stream start track_id={}", track_id.0);
        let conn = self.connection().await?;
        match self.stream_on_connection(&conn, track_id.clone()).await {
            Ok(stream) => {
                self.log_connection_path_if_changed(&conn, "stream").await;
                Ok(stream)
            }
            Err(error) => {
                rpc_log!(
                    "[client-rpc] stream failed track_id={} error={error}; reconnecting once",
                    track_id.0
                );
                self.clear_connection().await;
                let conn = self.connection().await?;
                self.stream_on_connection(&conn, track_id).await
            }
        }
    }

    async fn request_on_connection(
        &self,
        conn: &Connection,
        request: &BackendRequest,
    ) -> Result<BackendResponse> {
        let (mut send, mut recv) = conn.open_bi().await?;
        write_json(&mut send, request).await?;
        send.finish()?;
        read_response(&mut recv).await
    }

    async fn request_on_connection_with_timeout(
        &self,
        conn: &Connection,
        request: &BackendRequest,
    ) -> Result<BackendResponse> {
        timeout(RPC_TIMEOUT, self.request_on_connection(conn, request))
            .await
            .map_err(|_| Error::Timeout(format!("rpc {}", request_name(request))))?
    }

    async fn stream_on_connection(
        &self,
        conn: &Connection,
        track_id: TrackId,
    ) -> Result<(StreamDescriptor, RecvStream)> {
        let (descriptor, recv) = timeout(
            STREAM_OPEN_TIMEOUT,
            self.stream_open_on_connection(conn, track_id.clone()),
        )
        .await
        .map_err(|_| Error::Timeout(format!("stream open {}", track_id.0)))??;
        rpc_log!(
            "[client-rpc] stream descriptor track_id={} file_size={} content_type={} transfer_timeout=disabled",
            descriptor.track_id.0,
            descriptor.file_size,
            descriptor.content_type
        );
        Ok((descriptor, recv))
    }

    async fn stream_open_on_connection(
        &self,
        conn: &Connection,
        track_id: TrackId,
    ) -> Result<(StreamDescriptor, RecvStream)> {
        let (mut send, mut recv) = conn.open_bi().await?;
        write_json(&mut send, &BackendRequest::OpenStream { track_id }).await?;
        send.finish()?;
        let descriptor = match read_response(&mut recv).await? {
            BackendResponse::Stream(stream) => stream,
            _ => {
                return Err(Error::InvalidRequest(
                    "backend returned unexpected response for stream".to_string(),
                ));
            }
        };
        Ok((descriptor, recv))
    }

    async fn connection(&self) -> Result<Connection> {
        let mut guard = self.conn.lock().await;
        if let Some(conn) = guard.as_ref() {
            return Ok(conn.clone());
        }

        rpc_log!("[client-rpc] connecting backend transport");
        let conn = timeout(
            CONNECT_TIMEOUT,
            self.endpoint.connect(self.addr.clone(), IROH_ALPN),
        )
        .await
        .map_err(|_| Error::Timeout("connect backend transport".to_string()))??;
        rpc_log!(
            "[client-rpc] backend transport connected remote_endpoint={}",
            conn.remote_id()
        );
        log_connection_path("client-rpc", "connected", &conn);
        *self.last_path.lock().await = Some(connection_path_label(&conn));
        *guard = Some(conn.clone());
        Ok(conn)
    }

    async fn clear_connection(&self) {
        let mut guard = self.conn.lock().await;
        if let Some(conn) = guard.take() {
            conn.close(1u32.into(), b"reconnect");
        }
        *self.last_path.lock().await = None;
    }

    async fn log_connection_path_if_changed(&self, conn: &Connection, event: &str) {
        let label = connection_path_label(conn);
        let mut guard = self.last_path.lock().await;
        if guard.as_deref() != Some(label.as_str()) {
            rpc_log!("[client-rpc] path changed event={event} {label}");
            *guard = Some(label);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct ConnectionInfo {
    pub path_type: String,
    pub address: String,
    pub received_bytes: u64,
}

fn endpoint_builder(config: &IrohConfig) -> iroh::endpoint::Builder {
    let mut builder = Endpoint::builder(presets::N0);
    #[cfg(not(target_os = "android"))]
    {
        builder = builder.address_lookup(MdnsAddressLookup::builder());
    }
    if let Some(secret) = &config.secret {
        let secret = SecretKey::from_str(secret)
            .map_err(|error| Error::InvalidRequest(format!("invalid --secret: {error}")))
            .expect("validated secret");
        builder = builder.secret_key(secret);
    }
    if let Some(relay) = &config.relay {
        let relay: RelayUrl = relay
            .parse()
            .map_err(|error| Error::InvalidRequest(format!("invalid --relay: {error}")))
            .expect("validated relay");
        builder = builder.relay_mode(RelayMode::custom([relay]));
    }
    builder
}

async fn write_json<T: serde::Serialize>(
    send: &mut iroh::endpoint::SendStream,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let len = u32::try_from(bytes.len())
        .map_err(|_| Error::InvalidRequest("message too large".to_string()))?;
    send.write_u32(len).await?;
    send.write_all(&bytes).await?;
    Ok(())
}

async fn read_json<T: serde::de::DeserializeOwned>(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<T> {
    let len = recv.read_u32().await?;
    let mut bytes = vec![0_u8; len as usize];
    recv.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn read_response(recv: &mut iroh::endpoint::RecvStream) -> Result<BackendResponse> {
    match read_json(recv).await? {
        BackendResponse::Error { message } => Err(Error::InvalidRequest(message)),
        response => Ok(response),
    }
}

fn request_name(request: &BackendRequest) -> &'static str {
    match request {
        BackendRequest::GetLibrarySummary => "GetLibrarySummary",
        BackendRequest::ListArtists => "ListArtists",
        BackendRequest::ListAlbums => "ListAlbums",
        BackendRequest::ListTracks => "ListTracks",
        BackendRequest::GetStarred => "GetStarred",
        BackendRequest::GetStarredWithKey { .. } => "GetStarredWithKey",
        BackendRequest::SetStarred { .. } => "SetStarred",
        BackendRequest::SetStarredWithKey { .. } => "SetStarredWithKey",
        BackendRequest::ListPlaylists => "ListPlaylists",
        BackendRequest::GetPlaylist { .. } => "GetPlaylist",
        BackendRequest::CreatePlaylist { .. } => "CreatePlaylist",
        BackendRequest::UpdatePlaylist { .. } => "UpdatePlaylist",
        BackendRequest::DeletePlaylist { .. } => "DeletePlaylist",
        BackendRequest::ReorderPlaylists { .. } => "ReorderPlaylists",
        BackendRequest::GetArtist { .. } => "GetArtist",
        BackendRequest::GetAlbum { .. } => "GetAlbum",
        BackendRequest::GetAlbumTracks { .. } => "GetAlbumTracks",
        BackendRequest::GetTrack { .. } => "GetTrack",
        BackendRequest::GetCoverArt { .. } => "GetCoverArt",
        BackendRequest::ResolveId { .. } => "ResolveId",
        BackendRequest::Search { .. } => "Search",
        BackendRequest::OpenStream { .. } => "OpenStream",
    }
}

fn log_connection_path(prefix: &str, event: &str, conn: &Connection) {
    rpc_log!(
        "[{prefix}] path event={event} {}",
        connection_path_label(conn)
    );
}

fn connection_path_label(conn: &Connection) -> String {
    let paths = conn.paths();
    let Some(path) = paths.iter().find(|path| path.is_selected()) else {
        return "type=unknown selected_path=<none>".to_string();
    };
    let kind = if path.is_relay() {
        "relay"
    } else if path.is_ip() {
        "direct"
    } else {
        "custom"
    };
    let rtt = format!(" rtt_ms={}", path.rtt().as_millis());
    format!(
        "type={} selected_path={:?} remote_addr={}{}",
        kind,
        path.id(),
        transport_addr_label(path.remote_addr()),
        rtt
    )
}

fn transport_addr_label(addr: &TransportAddr) -> String {
    match addr {
        TransportAddr::Relay(relay) => format!("relay:{relay}"),
        TransportAddr::Ip(addr) => format!("ip:{addr}"),
        TransportAddr::Custom(addr) => format!("custom:{addr}"),
        other => format!("unknown:{other:?}"),
    }
}
