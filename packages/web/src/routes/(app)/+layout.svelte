<script>
  import { App } from "$lib/runes/App.svelte.js";
  import { Updates } from "$lib/runes/Updater.svelte.js";

  import CloseIcon from "virtual:icons/ri/close-line";

  import PlayerBar from "../PlayerBar.svelte";
  import TopBar from "../TopBar.svelte";
  import UpdateNotice from "../UpdateNotice.svelte";

  /** @typedef {import('./$types').LayoutProps} Props */
  /** @type {Props} */
  const { children } = $props();
</script>

<div class="bg-base text-text flex h-dvh flex-col overflow-hidden">
  <div class="shrink-0">
    <TopBar updateReady={Updates.ready && !Updates.nativeUpgrade} onupdate={Updates.apply} />
    <UpdateNotice overlay={false} />
  </div>
  <main class="min-h-0 flex-1 overflow-hidden">{@render children()}</main>
  <PlayerBar />
</div>

{#if App.connection.error}
  <div
    class="border-red/40 bg-crust text-red shadow-float fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 border px-4 py-3 text-xs"
    role="status"
  >
    <span>{App.connection.error}</span>
    <button type="button" onclick={() => (App.connection.error = "")} aria-label="Dismiss error"
      ><CloseIcon class="text-sm" /></button
    >
  </div>
{/if}
