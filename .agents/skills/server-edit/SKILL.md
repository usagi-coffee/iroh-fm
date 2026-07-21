---
name: server-edit
description: "Use only when editing crates/server or its library scanning, indexing, metadata, authorization, or streaming behavior."
---

# Server Edit

`crates/server` owns the music library: scanning files, normalizing metadata, authorizing peers, and serving artwork and audio. Keep client-protocol adapters such as Subsonic outside this crate.

## Verify

```sh
cargo check -p server
cargo test -p server
```

## Commit Strategy

Use `server:` for server implementation changes that preserve the existing protocol contract. Use `protocol:` when clients and server must interpret a request, response, or semantic differently.
