---
name: desktop-edit
description: "Use only when editing Desktop-specific code in packages/web/src-tauri, packages/client/src/desktop.js, or Desktop packaging and tests."
---

# Desktop Edit

`packages/web/src-tauri` provides the Tauri bridge and Rodio playback behind the shared Web UI. `packages/client/src/desktop.js` is the JavaScript IPC side; keep command names, payloads, and permissions aligned with the Rust bridge.

## Verify

```sh
cargo test -p iroh-fm-desktop
bun run --cwd packages/web check:prepared
bun run --cwd packages/web test:e2e --project=desktop
```

## Commit Strategy

Be especially careful before choosing `desktop:`: use it only for an explicit Desktop release when Desktop-native code or configuration really changes. A Web fix that affects Desktop through the shared UI does not need the `desktop:` prefix if it does not change native Desktop code. `desktop:` publishes installers and advances the Desktop epoch. An empty `desktop:` commit is valid when native work is already merged and only a release is needed.
