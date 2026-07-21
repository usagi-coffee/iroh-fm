# iroh-fm

iroh-fm is a music server and a set of clients. The server keeps a music library, and clients connect to it over [iroh](https://iroh.computer/) to browse the library and play tracks. The same library operations are used by the browser, Desktop, Android, and Subsonic-compatible clients.

## How the pieces fit together

`crates/server` is the part that knows the music collection. It scans the configured music directory, identifies artists, albums, and tracks, stores their metadata, checks access, and reads cover art or audio bytes when a client asks for them.

`crates/protocol` describes the conversation between a client and the server. It contains the request and response types, IDs, and serialized library data. It does not scan files or display anything; it is the shared vocabulary that both sides compile against.

`crates/client` is the native Rust implementation of that conversation. It connects to a server, sends protocol requests, and exposes the results to native applications. Desktop, Android, and the Subsonic service use this client.

The browser cannot use the native client directly. `crates/web-wasm` is a browser/WASM implementation of the iroh connection and protocol calls, compiled for use from JavaScript. It handles browser-specific transport details such as connecting with a shared ticket and opening browser audio streams.

`packages/client` is the JavaScript-facing client library. Its `ClientCore` presents one API to the UI and chooses the implementation for the current host: browser WASM, Desktop, or Android. The generated files under `packages/client/src/wasm` come from `crates/web-wasm`.

`packages/web` is the Svelte music player that is shared between Web, Desktop and Android application. It contains the screens, library browsing, connection state, queue, and player controls. It talks to `packages/client` rather than directly to iroh. The web build is a pure client-side rendered static site hosted on Github Pages, so the browser downloads the app and then connects to the user’s server.

`packages/web/src-tauri` is the desktop wrapper of the web application inside a Tauri application. It supplies the native bridge, filesystem/application integration, and Rodio audio playback; its Rust side uses `crates/client` instead of the browser WASM transport.

`android` is the android wrapper of the web application inside a Trusted Web Activity. It contains the Gradle/Kotlin application and its Media3 playback service. `crates/android-native` contains the Rust/JNI bridge to the native client, while the Android implementation in `packages/client` passes messages between the web UI and that bridge.

`crates/subsonic` is an adapter for existing Subsonic music apps. This crate translates subsonic requests into calls through `crates/client` and converts the results back into Subsonic-shaped HTTP responses. It is an adapter for that external API, not another music-library implementation.

## Typical request flow

A browser click usually follows this path:

`packages/web` UI → `packages/client` → `crates/web-wasm` → iroh → `crates/server`

The Desktop and Android paths replace the browser transport with their native bridges and `crates/client`:

`packages/web` UI → `packages/client` → native bridge → `crates/client` → iroh → `crates/server`

The Subsonic path starts with an external HTTP client instead of the Svelte UI:

Subsonic app → `crates/subsonic` → `crates/client` → iroh → `crates/server`
