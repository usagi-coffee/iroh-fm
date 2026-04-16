## High-Level Architecture

### Iroh Music Server

Responsibilities:

- Scan a configured root music directory.
- Build a normalized in-memory or persisted index of artists, albums, tracks, cover art, and file metadata.
- Expose protocol-agnostic backend operations over `iroh` for:
  - library summary
  - artist listing
  - album listing
  - track lookup
  - cover art fetch
  - stream open by track id
- Serve file bytes efficiently for audio streams and artwork.

Non-responsibilities:

- No Subsonic route handling
- No Subsonic auth semantics
- No Subsonic response serialization

Primary crate involved:

- `server`

### Subsonic Compatibility Service

Responsibilities:

- Expose HTTP endpoints compatible with selected Subsonic API routes.
- Validate Subsonic auth parameters enough for clients to proceed.
- Translate incoming Subsonic requests into backend calls against `server`.
- Shape responses to Subsonic schemas.
- Proxy or bridge audio streams from `iroh` to HTTP clients.

Design rule:

- `subsonic` is an adapter layer, not the source of truth for library semantics.
- Any future protocol such as another media API should be added as a sibling facade crate, not by extending `server` with client-protocol logic.

Primary crates involved:

- `subsonic`
- `server` as the backend contract owner, or a later `protocol` crate if that contract needs isolation

