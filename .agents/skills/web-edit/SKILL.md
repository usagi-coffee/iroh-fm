---
name: web-edit
description: "Use only when editing browser-facing code in packages/web, packages/client, or crates/web-wasm."
---

# Web Edit

`packages/web` is the shared Svelte UI; `packages/client` is its JavaScript client API; `crates/web-wasm` supplies browser iroh transport. Keep UI state in the existing app/library/player layers and treat `packages/client/src/wasm` as generated output. Desktop and Android reuse this UI through alternate client implementations.

## Verify

```sh
bun run --cwd packages/web check
bun run --cwd packages/web test:e2e --project=web
bun run --cwd packages/web build
```

## Commit Strategy

Use `web:` for browser UI, browser transport, service-worker, cache, and Web test changes. It updates the hosted Web app but does not publish Android or Desktop.
