# iroh-fm

`iroh-fm` is a personal music server built around `iroh`.

The core idea is simple: the music library lives behind an `iroh` endpoint, and client protocols are added as thin frontends on top.

## Why

Most music servers make the client protocol the center of the system. `iroh-fm` does the opposite.

- the backend is protocol-agnostic
- the transport is `iroh`
- Subsonic is one of a multiple compatibility layers
- more frontends can be added without changing the server model

That means one music library, one backend, many possible client-facing APIs.

## What It Does

- scans a local music directory
- extracts tags and builds an indexed library
- caches metadata in SQLite for fast warm starts
- watches the library for real changes
- serves metadata, cover art, and audio over `iroh`
- exposes a Subsonic-compatible HTTP facade for existing players

## Workspace

```text
crates/
  protocol/
  server/
  subsonic/
```

- `protocol`: shared backend request and response types
- `server`: the actual music server
- `subsonic`: Subsonic facade over the backend

## Install

```sh
cargo install --path crates/server
cargo install --path crates/subsonic
```

This installs:

- `iroh-fm`
- `iroh-fm-subsonic`

## Run

### Backend

```sh
iroh-fm --music-dir /path/to/music
```

It prints an endpoint id and a ticket.

### Subsonic frontend

```sh
iroh-fm-subsonic --bind 127.0.0.1:4040 --ticket <ticket>
```

Default Subsonic credentials:

- username: `admin`
- password: `admin`

