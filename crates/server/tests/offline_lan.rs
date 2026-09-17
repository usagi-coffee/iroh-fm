use std::net::{Ipv4Addr, TcpListener, UdpSocket};
use std::path::PathBuf;
use std::process::Stdio;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iroh::{Endpoint, EndpointAddr, RelayMode, endpoint::presets};
use iroh_tickets::endpoint::EndpointTicket;
use server::{BackendRequest, BackendResponse, IROH_ALPN};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;

struct MusicDir(PathBuf);

impl MusicDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "iroh-fm-offline-lan-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for MusicDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn start_server(music: &MusicDir, port: u16, relay: &str) -> (Child, EndpointTicket) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_iroh-fm"))
        .arg("--music-dir")
        .arg(&music.0)
        // A fixed test identity lets the original ticket survive a restart.
        .args(["--secret", &"07".repeat(32)])
        .args(["--port", &port.to_string(), "--relay", relay])
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start server");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let ticket = timeout(Duration::from_secs(10), async {
        let mut ready = false;
        while let Some(line) = lines.next_line().await.expect("read server output") {
            ready |= line.starts_with("server backend ready:");
            if let Some(ticket) = line.strip_prefix("ticket=") {
                assert!(ready, "server must report ready before printing its ticket");
                return EndpointTicket::from_str(ticket).expect("parse server ticket");
            }
        }
        panic!("server exited without printing a ticket");
    })
    .await
    .expect("server must print a LAN ticket without waiting for its relay");
    // Keep stdout open: later address updates must not encounter a broken pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (child, ticket)
}

async fn check_direct_rpc(client: &Endpoint, address: EndpointAddr) {
    timeout(Duration::from_secs(10), async {
        let connection = client
            .connect(address, IROH_ALPN)
            .await
            .expect("connect directly without relay or discovery");
        let (mut send, mut recv) = connection.open_bi().await.unwrap();
        let request = serde_json::to_vec(&BackendRequest::GetLibrarySummary).unwrap();
        send.write_u32(request.len().try_into().unwrap())
            .await
            .unwrap();
        send.write_all(&request).await.unwrap();
        send.finish().unwrap();
        let length = recv.read_u32().await.unwrap();
        let mut bytes = vec![0; length as usize];
        recv.read_exact(&mut bytes).await.unwrap();
        let response: BackendResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(matches!(response, BackendResponse::LibrarySummary(_)));
        assert!(
            connection
                .paths()
                .iter()
                .any(|path| path.is_selected() && path.is_ip()),
            "RPC must use a direct IP path"
        );
        connection.close(0u32.into(), b"test complete");
    })
    .await
    .expect("direct LAN RPC must not wait for a relay");
}

#[tokio::test]
async fn offline_startup_ticket_supports_direct_rpc_and_server_restart() {
    let music = MusicDir::new();
    // Reserve a TCP listener that never answers the relay handshake. This keeps
    // the relay unavailable without relying on public DNS or changing networking.
    let relay = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let relay_url = format!("https://{}", relay.local_addr().unwrap());
    let reservation = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);

    let (mut server, ticket) = start_server(&music, port, &relay_url).await;
    let address = ticket.endpoint_addr();
    assert!(
        address.ip_addrs().next().is_some(),
        "ticket needs IP addresses"
    );
    assert!(address.ip_addrs().all(|addr| addr.port() == port));

    // No relay and no address lookup on the client: only the ticket's IP
    // addresses can make this work, just as Android needs without mDNS.
    let client = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let direct_address = address
        .ip_addrs()
        .fold(EndpointAddr::new(address.id), |addr, ip| {
            addr.with_ip_addr(*ip)
        });
    check_direct_rpc(&client, direct_address.clone()).await;
    server.kill().await.unwrap();
    server.wait().await.unwrap();

    let (mut restarted, new_ticket) = start_server(&music, port, &relay_url).await;
    assert_eq!(new_ticket.endpoint_addr().id, address.id);
    check_direct_rpc(&client, direct_address).await;
    client.close().await;

    // Also dial the unmodified, saved ticket with an unavailable relay
    // configured on the client. A bad relay must not prevent a good IP path.
    let client = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::custom([relay_url.parse().unwrap()]))
        .bind()
        .await
        .unwrap();
    check_direct_rpc(&client, address.clone()).await;
    client.close().await;

    #[cfg(unix)]
    {
        assert!(
            Command::new("kill")
                .args(["-s", "INT", &restarted.id().unwrap().to_string()])
                .status()
                .await
                .unwrap()
                .success()
        );
        assert!(
            timeout(Duration::from_secs(10), restarted.wait())
                .await
                .expect("Ctrl-C must not wait for a relay")
                .unwrap()
                .success(),
            "server must handle Ctrl-C and shut down cleanly while offline"
        );
    }
    #[cfg(not(unix))]
    {
        restarted.kill().await.unwrap();
        restarted.wait().await.unwrap();
    }
}
