---
name: svelte
description: Create or edit Svelte/SvelteKit files (`*.svelte`, `*.svelte.js`, `+page.svelte`, `+page.js`, `+layout.js`)
---

# Svelte Edit

Apply these rules when creating or modifying Svelte files. Preserve existing project conventions when they are stricter, but do not introduce legacy Svelte patterns.

## Svelte

- Use Svelte 5 runes. Do not use legacy component APIs such as `export let`.
- Use `$state`, `$derived`, `$derived.by(` insetead of legacy `$:` declarations.
- Use `{const ...}`, `{const ... = $derived(...)}`, and `{let ... = $state(...)}` in markup. Do not use legacy `{@const ...}`.
- Use `{@attach ...}` over `bind:this`, `onMount`, `onDestroy`, keep in mind reads inside the attachment force re-attachments.
- Destructure component props from `$props()`.
- Use `<svelte:boundary>` instead of legacy `{#await` blocks.
- You can use top-level await e.g `const value = $derived(await fetch())` in the `<script>` block and the markup.

## SvelteKit

- Use `$app/state`, not `$app/stores`.
- Use `$lib` for imports from `src/lib`.
- Use `goto` from `$app/navigation` for application navigation instead of assigning `window.location.href`.

## State and reactivity

- Model mutable local state with `$state` and derived values with `$derived` or `$derived.by`, keep in mind `$derived` when defined with `let` can be mutated.
- Use many `$derived`'s, split state into small, focused values rather than one large computation, this improves the performance and helps localize performance issues.
- Prefer reactive class fields such as `value = $derived(...)` over getters when both express the same logic clearly.
- Use a getter only when `$derived` or `$derived.by` would be insufficient.
- Prefer mutating array methods when updating an existing reactive array instead of replacing the full array solely to trigger reactivity.
- Do not use `$effect` as a default synchronization mechanism, in most cases `$effect` usage can be replaced with a mutating `$derived`, function bindings or just updating at call-site.
- Keep related state consistent at the mutation site: event handlers, function bindings, API callbacks, or entity methods.

## Patterns

- Prefer function bindings when input updates require validation, normalization, or coordinated side effects:

```svelte
<input bind:value={() => value, (next) => (value = next)} />
```
