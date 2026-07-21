---
name: contributing
description: "Use only when preparing or advising on a commit subject in this repository, especially when choosing web:, server:, client:, protocol:, android:, desktop:, or ci:."
---

# Contributing

Start the subject with one exact lowercase prefix. Choose it by impact, not only by changed directory. Read the relevant `*-edit` skill for component-specific strategy.

## Every Push Updates Web

Every push to `master` runs Web CI regardless of prefix. It rebuilds WASM, checks the app, creates a freshly versioned static site, and deploys it to GitHub Pages.

A successful push therefore makes a new Web update available to users even when the commit is `server:` or `ci:`. Browser and hosted Android TWA users can receive it through the Web/service-worker update flow. Installed Desktop binaries change only through an explicit Desktop release.

## `web:` prefix

Use for the Svelte UI, browser transport, service worker, Web cache, or Web pipeline. It adds no native build, release, or epoch effect beyond the Web deployment that always happens.

Typical paths: `packages/web/src/**`, `packages/client/src/core.js`, `packages/client/src/index.js`, `crates/web-wasm/**`, and `packages/web/src/service-worker.js`.

## `server:` prefix

Use for contract-preserving server behavior such as scanning, indexing, authorization, or streaming. It does not build or release native clients and does not advance an epoch. Web is still rebuilt and deployed because every push updates Web.

Typical paths: `crates/server/**` and server-only configuration or tests.

## `client:` prefix

Use for contract-preserving client implementation. It has no special native build, release, or epoch effect. Any included Web client changes are delivered by the normal Web deployment.

Typical paths: shared code in `crates/client/**` or `packages/client/src/**` when it does not change the wire contract or belong to one native platform.

## `protocol:` prefix

Use when server and clients must share a changed wire contract or interpretation. It updates Web only; it does not trigger Android or Desktop and does not advance a native epoch. If native users need a version bump, recommend explicit empty `android:` and/or `desktop:` release commits, pushed separately.

Typical paths: `crates/protocol/**`, or coordinated changes to protocol consumers such as `crates/server/src/iroh_rpc.rs`, `crates/client/**`, and `crates/web-wasm/**`.

## `android:` prefix

Use only as an explicit Android release commit. Web deploys first, then Android builds and publishes the signed APK. This advances the Android epoch.

Typical Android-owned paths: `android/**`, `crates/android-native/**`, Android-specific code in `packages/client/src/native.js`, and `packages/web/e2e/android/**`. Use `android:` only when that commit is intentionally publishing Android; otherwise use the appropriate implementation prefix.

## `desktop:` prefix

Use for any commit that changes Desktop-native code and is intended to reach installed Desktop clients. In particular, any change under `packages/web/src-tauri/**` must use the `desktop:` prefix, even when the same commit also changes shared Svelte UI. Web also prepares the Desktop asset bundle, then Desktop builds and publishes its installers. This advances the Desktop epoch.

Typical Desktop-owned paths: `packages/web/src-tauri/**`, Desktop-specific code in `packages/client/src/desktop.js`, and `packages/web/e2e/desktop/**`.

## `agent:` prefix

Use for changes to Codex agent instructions, skills, or other agent configuration. Keep these changes in a separate `agent:` commit from product code so a product release prefix remains the head commit when native release workflows depend on it.

Typical agent-owned paths: `.agents/**`, `.codex/**`, `AGENTS.md`, and agent skill or plugin instruction files.

## `ci:` prefix

Use for CI-only changes. It updates Web but does not trigger Android or Desktop, publish native releases, or advance epochs.

Typical paths: `.github/workflows/**`, release scripts, or other CI-only changes.

## Head Commit Rule

Native workflows inspect only the head commit of a push. Only explicit `android:` and `desktop:` head commits trigger native releases; push them separately. Workflow runs queue and are not cancelled by later pushes.
