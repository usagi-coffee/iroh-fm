# @iroh-fm/client

Browser client for the `irohifi/1` protocol. It owns the generated WebAssembly bindings and provides a small JavaScript API for ticket connections, JSON RPC, artwork Blob URLs, and browser-native audio streams. MP3 is fed progressively through `MediaSource` when supported; other media types fall back to a Blob URL.

`MusicClient.connect({ ticket, secret })` connects from a ticket. Advanced callers can instead provide `{ endpoint, relays, secret }`; browser connections always travel through a relay. `MusicClient.parseTicket(ticket)` exposes the endpoint ID and relay list for address editors. `MusicClient.generateIdentity()` creates a local secret and endpoint ID, while `MusicClient.endpointIdForSecret(secret)` derives the public ID for an existing secret.

The Rust side lives in `crates/web-wasm`; generated files under `src/wasm` are build artifacts and are not committed.
