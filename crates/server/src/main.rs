use std::env;
use std::process::ExitCode;
use std::str::FromStr;

use iroh::{EndpointAddr, EndpointId, RelayUrl, Watcher};
use iroh_tickets::endpoint::EndpointTicket;
use server::{BackendRequest, IrohConfig, MusicServer, ServerConfig, spawn_iroh_server_with_port};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> server::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        return Ok(());
    }

    let (music_dir, iroh, port) = parse_config(args.into_iter())?;
    if let Some(secret) = &iroh.secret {
        let _ = iroh::SecretKey::from_str(secret)
            .map_err(|error| server::Error::InvalidRequest(format!("invalid --secret: {error}")))?;
    }
    let relay = iroh
        .relay
        .as_deref()
        .map(RelayUrl::from_str)
        .transpose()
        .map_err(|error| server::Error::InvalidRequest(format!("invalid --relay: {error}")))?;
    for peer in &iroh.peers {
        let _ = peer;
    }

    let config = ServerConfig::new(music_dir);
    let server = MusicServer::load(config)?;
    let summary = server.handle(BackendRequest::GetLibrarySummary)?;
    let handle = spawn_iroh_server_with_port(server, &iroh, port).await?;
    // Binding is sufficient for LAN service. `online()` waits for a relay and
    // can block forever without WAN access, even while the listener is usable.
    let mut addresses = handle.endpoint.watch_addr();
    let endpoint = handle.endpoint.id();
    let mut ticket = endpoint_ticket(addresses.get(), relay.as_ref());
    println!("server backend ready: {summary:?}");
    println!("endpoint={endpoint}");
    if let Some(port) = port {
        println!("udp_port={port}");
    }
    println!("ticket={ticket}");
    if iroh.peers.is_empty() {
        println!("peers=open");
    } else {
        println!(
            "peers={}",
            iroh.peers
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    if let Some(relay) = iroh.relay.as_deref() {
        println!("relay={relay}");
    }
    eprintln!(
        "LAN connections do not require a relay. Browser connections require a reachable relay; \
         updated tickets will be printed as addresses change."
    );
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    let shutdown_result = loop {
        tokio::select! {
            result = &mut shutdown => break result,
            address = addresses.updated() => {
                let Ok(address) = address else {
                    break Ok(());
                };
                let updated = endpoint_ticket(address, relay.as_ref());
                if updated != ticket {
                    ticket = updated;
                    println!("ticket={ticket}");
                }
            }
        }
    };
    handle.endpoint.close().await;
    handle.task.abort();
    shutdown_result?;

    Ok(())
}

fn endpoint_ticket(mut address: EndpointAddr, relay: Option<&RelayUrl>) -> EndpointTicket {
    if let Some(relay) = relay {
        address = address.with_relay_url(relay.clone());
    }
    EndpointTicket::from(address)
}

fn parse_config(
    args: impl Iterator<Item = String>,
) -> server::Result<(std::path::PathBuf, IrohConfig, Option<u16>)> {
    let mut music_dir = None;
    let mut iroh = IrohConfig::default();
    let mut port = None;
    let mut args = args.peekable();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--music-dir" => music_dir = args.next().map(Into::into),
            "--secret" => iroh.secret = Some(args.next().ok_or_else(missing_value)?),
            "--relay" => iroh.relay = Some(args.next().ok_or_else(missing_value)?),
            "--port" => {
                let value = args.next().ok_or_else(missing_value)?;
                port = Some(parse_udp_port(&value)?);
            }
            "--peer" => {
                let peer = EndpointId::from_str(&args.next().ok_or_else(missing_value)?).map_err(
                    |error| server::Error::InvalidRequest(format!("invalid --peer: {error}")),
                )?;
                iroh.peers.insert(peer);
            }
            other => {
                return Err(server::Error::InvalidRequest(format!(
                    "unknown argument: {other}"
                )));
            }
        }
    }

    let music_dir = music_dir.ok_or_else(|| {
        server::Error::InvalidRequest("expected --music-dir /path/to/music".to_string())
    })?;
    Ok((music_dir, iroh, port))
}

fn parse_udp_port(value: &str) -> server::Result<u16> {
    match value.parse::<u16>() {
        Ok(0) | Err(_) => Err(server::Error::InvalidRequest(format!(
            "invalid --port: expected an integer from 1 to 65535, got {value}"
        ))),
        Ok(port) => Ok(port),
    }
}

fn missing_value() -> server::Error {
    server::Error::InvalidRequest("missing value for flag".to_string())
}

fn print_usage() {
    println!("usage:");
    println!(
        "  server --music-dir /path/to/music [--secret <secret-key>] [--relay <relay-url>] [--port <udp-port>] [--peer <endpoint-id> ...]"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_preserve_lan_addresses_before_and_after_relay_discovery() {
        let id = iroh::SecretKey::from_bytes(&[7; 32]).public();
        let lan = "192.168.1.10:50608".parse().unwrap();
        let address = EndpointAddr::new(id).with_ip_addr(lan);
        let initial = endpoint_ticket(address.clone(), None);
        assert_eq!(initial.endpoint_addr(), &address);
        assert_eq!(initial.endpoint_addr().relay_urls().count(), 0);

        let relay: RelayUrl = "https://relay.example.com".parse().unwrap();
        let discovered = endpoint_ticket(address.clone().with_relay_url(relay.clone()), None);
        let configured = endpoint_ticket(address, Some(&relay));
        assert_eq!(configured, discovered);
        assert_eq!(
            discovered
                .endpoint_addr()
                .ip_addrs()
                .copied()
                .collect::<Vec<_>>(),
            vec![lan]
        );
        assert_eq!(discovered.endpoint_addr().relay_urls().next(), Some(&relay));
        assert_ne!(initial, discovered);
    }

    #[test]
    fn parses_optional_udp_port() {
        let (_, _, port) = parse_config(
            ["--music-dir", "/music", "--port", "50608"]
                .into_iter()
                .map(str::to_string),
        )
        .expect("parse config");

        assert_eq!(port, Some(50608));
    }

    #[test]
    fn rejects_ephemeral_udp_port() {
        let error = parse_config(
            ["--music-dir", "/music", "--port", "0"]
                .into_iter()
                .map(str::to_string),
        )
        .expect_err("port zero must be rejected");

        assert!(error.to_string().contains("1 to 65535"));
    }
}
