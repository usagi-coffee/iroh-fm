# iroh.fm web player

The web player is a fully static, client-rendered Svelte SPA. It has no HTTP API or server-side runtime. The browser loads an application-specific iroh WebAssembly client from the sibling `@iroh-fm/client` workspace and connects to an iroh-fm server using its endpoint ticket.

Browser iroh connections are end-to-end encrypted but relay-only. Start `iroh-fm` with a reachable relay and use the ticket it prints.

The connection screen also accepts an optional client secret. This keeps the browser endpoint ID stable between sessions, allowing the ID shown in the player to be passed to `iroh-fm --peer`. The ticket and secret are stored in localStorage and can be changed later from the in-app connection settings.

## Prerequisites

- Bun
- Rust with the `wasm32-unknown-unknown` target
- `wasm-bindgen-cli` 0.2.125
- `wasm-opt` from Binaryen

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.125 --locked
```

## Development

From the repository root:

```sh
bun install
bun run dev
```

`dev` first builds `crates/web-wasm`, generates bindings in `packages/client/src/wasm`, and starts Vite.

## Static build

```sh
bun run build
```

The deployable site is written to `packages/web/build`. For a GitHub project page, provide the repository base path:

```sh
BASE_PATH=/iroh-fm bun run build
```
