<p align="center">
  <img src="extra/iroh-fm.png" width="180" height="180" alt="iroh-fm project icon" />
</p>

<h1 align="center">iroh-fm</h1>

**Ever wanted to share your music library with your friends?** With `iroh-fm`, it is as easy as sending them a ticket. They open the website, paste the ticket, and your library is ready to play—no account, native app, public IP address, or port forwarding required.

Host it on practically any device and listen from anywhere on any modern browser. It is your unstoppable personal music server: your files stay on your hardware while iroh provides the private, end-to-end encrypted connection.

**The website is fully static.** It is only HTML, CSS, JavaScript, and WebAssembly hosted on GitHub Pages. There is no application backend, no SSR, and no server-side code behind the website. The browser connects directly to the `iroh-fm` server running on your—or your friend's—device.

## [Open the web player](https://usagi-coffee.github.io/iroh-fm/)

Start the server, copy its [iroh](https://iroh.computer/) endpoint ticket, and share it with the people you trust. The same ticket works from a phone, tablet, laptop, or desktop wherever they can open the web player.

GitHub only serves the static player files. It does not run an `iroh-fm` service and does not proxy, process, or store your library, credentials, artwork, or audio.

## Why “unstoppable”?

- **Host it anywhere:** a desktop, laptop, NAS, android smartphone, home server, VPS, or any other device that can run the `iroh-fm` binary and read your music directory.
- **Listen from anywhere:** the endpoint ticket carries the information needed to reach the server without port forwarding or a public HTTP endpoint.
- **Use any modern device:** open the static web player on a phone, tablet, laptop, or desktop - there is no native client to install.
- **No application middleman:** the browser talks to your iroh endpoint, not to a hosted iroh-fm API service.
- **End-to-end encrypted:** browser connections travel through an iroh relay because browsers cannot open UDP sockets, but the relay cannot decrypt the connection.
- **Portable client:** the web player is just static files and can be hosted on GitHub Pages, another static host, or locally.
- **Stable identity and access control:** optionally give clients a persistent secret and allowlist their endpoint IDs on the server.

## Quick start

Install the server:

```sh
cargo install --git https://github.com/usagi-coffee/iroh-fm server
```

Point it at your music library:

```sh
iroh-fm --music-dir /path/to/music
```

The server scans and indexes the library, watches it for changes, and prints an iroh endpoint ticket. Open the [iroh-fm web player](https://usagi-coffee.github.io/iroh-fm/), paste the ticket, and connect.

For a stable server identity, a custom relay, or a client allowlist:

```sh
iroh-fm \
  --music-dir /path/to/music \
  --secret your-server-secret \
  --relay https://relay.example.com \
  --peer allowed-client-endpoint-id
```

`--peer` is repeatable. Leave it out to accept any client that has the server ticket. The web player can generate and retain its own client secret; its endpoint ID is available in Settings for allowlisting.

## Web player

The first-party player is a client-rendered Svelte SPA with no SSR and no HTTP application backend. It includes:

- a virtualized song list and album browser
- progressive playback with next-track prefetching
- persistent Cache Storage for songs and covers
- an offline-only media mode
- per-identity or custom-key starred collections
- shareable ticket links that keep credentials in the URL fragment
- installable PWA support
- responsive desktop and mobile layouts

Browser iroh connections are currently relay-only. The server ticket must contain a reachable relay, or you can configure relay addresses in the advanced connection editor.

To run the web player locally:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.125 --locked
bun install
bun run dev
```

See [`packages/web/README.md`](packages/web/README.md) for static builds and GitHub Pages deployment.

## Existing players through Subsonic

The first-party iroh web client is the main way to use `iroh-fm`. Subsonic compatibility is available as a secondary adapter for existing players such as **Tauon**, **Strawberry**, and other Subsonic-compatible clients.

Install and run the adapter:

```sh
cargo install --git https://github.com/usagi-coffee/iroh-fm subsonic

iroh-fm-subsonic \
  --ticket your-iroh-fm-server-ticket \
  --bind 127.0.0.1:4040 \
  --username admin \
  --password admin
```

Then add `http://127.0.0.1:4040` as a Subsonic server in your player with the configured username and password. The adapter translates Subsonic HTTP requests into calls to the remote iroh music server and bridges audio back to the player.

The Subsonic service is only a compatibility facade. It does not own the library index or its semantics, and the core server contains no Subsonic route or authentication logic.

Additional adapter options:

```text
--endpoint <ID>       connect using an endpoint ID instead of a ticket
--relay <URL>         provide or override the backend relay
--secret <SECRET>     use a stable identity for the adapter
--bind <ADDRESS>      HTTP listen address; defaults to 127.0.0.1:4040
```

Be careful when binding the Subsonic adapter beyond localhost: unlike the iroh transport, it exposes an HTTP service that you must secure appropriately.

## What the server does

- scans a local music directory and extracts tags
- builds a normalized artist, album, track, and artwork index
- persists metadata in SQLite for fast warm starts
- watches the library for real filesystem changes
- serves library operations, cover art, and audio over iroh
- keeps protocol-specific frontends outside the core server

## Workspace

```text
crates/
  client/       native iroh RPC client
  protocol/     shared backend request and response types
  server/       music scanner, index, and iroh server
  subsonic/     optional Subsonic compatibility facade
  web-wasm/     browser wasm-bindgen bridge
packages/
  client/       reusable JavaScript/WASM browser client
  web/          fully static Svelte/Tailwind player
```

The architecture deliberately keeps the music library and iroh operations protocol-agnostic. Subsonic and any future compatibility service remain sibling adapters rather than becoming the source of truth.

## Credits

- The interface uses the **[Catppuccin](https://catppuccin.com/) Mocha** palette.
- The library layout and player experience are inspired by **[Tauon Music Box](https://tauonmusicbox.rocks/)**.

