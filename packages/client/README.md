# @iroh-fm/client

Browser client for the `irohifi/1` protocol. It owns the generated WebAssembly bindings and provides a small JavaScript API for ticket connections, JSON RPC, artwork Blob URLs, and browser-native audio streams. MP3 is fed progressively through `MediaSource` when supported; other media types fall back to a Blob URL.

The Rust side lives in `crates/web-wasm`; generated files under `src/wasm` are build artifacts and are not committed.
