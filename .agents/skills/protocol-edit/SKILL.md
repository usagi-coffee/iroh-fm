---
name: protocol-edit
description: "Use only when changing the shared wire contract in crates/protocol or coordinated request/response consumers."
---

# Protocol Edit

`crates/protocol` is the shared vocabulary between server and clients: requests, responses, identifiers, serialization, and wire semantics. A contract change normally requires corresponding handling in `crates/server`, `crates/client`, and browser/native transports.

The current protocol messages are:

- `GetLibrarySummary` → `LibrarySummary`: collection counts.
- `ListArtists` → `Artists`, `ListAlbums` → `Albums`, `ListTracks` → `Tracks`: top-level library lists.
- `GetArtist` → `Artist`: one artist by `ArtistId`.
- `GetAlbum` → `Album`: one album by `AlbumId`.
- `GetAlbumTracks` → `Tracks`: tracks belonging to an album.
- `GetTrack` → `Track`: one track by `TrackId`.
- `GetStarred` / `GetStarredWithKey` → `Starred`: starred artists, albums, and tracks; the keyed form supplies the client key.
- `SetStarred` / `SetStarredWithKey` → `Empty`: update an item’s starred state; the keyed form supplies the client key.
- `GetCoverArt` → `CoverArt`: cover-art bytes, optionally at full quality.
- `ResolveId` → `ResolvedId`: resolve a string to an artist, album, or track.
- `Search` → `SearchResults`: matching artists, albums, and tracks for a `SearchQuery`.
- `OpenStream` → `Stream`: audio stream metadata for a track.
- Any request may return `Error` with a message.

## Verify

```sh
cargo test -p protocol -p server -p client
cargo build -p iroh-fm-web-wasm --target wasm32-unknown-unknown --profile wasm-release
```

## Commit Strategy

Use `protocol:` for the contract change and required consumer updates. It updates Web only; it does not trigger Android/Desktop or advance their epochs. If native users need the change, make explicit `android:` and/or `desktop:` release commits.
