<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";
  import { Updater } from "$lib/runes/Updater.svelte.js";

  import CloseIcon from "virtual:icons/ri/close-line";

  import PlayerBar from "../PlayerBar.svelte";
  import TopBar from "../TopBar.svelte";
  import UpdateNotice from "../UpdateNotice.svelte";

  /** @typedef {import('./$types').LayoutProps} Props */
  /** @type {Props} */
  const { children } = $props();

  /** @param {EventTarget | null} target */
  function isEditableTarget(target) {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']",
        ),
      )
    );
  }

  function hotkeys() {
    /** @param {KeyboardEvent} event */
    const keydown = (event) => {
      if (Updater.applying) {
        event.preventDefault();
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;

      const route =
        event.key === "F1"
          ? resolve("/tracks")
          : event.key === "F2"
            ? resolve("/albums")
            : event.key === "F3"
              ? resolve("/starred")
              : null;
      if (route) {
        event.preventDefault();
        if (!event.repeat) void goto(route);
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (event.code === "Space" || event.key === " " || event.key === "Spacebar") {
        if (!event.repeat && App.player.currentTrack) {
          event.preventDefault();
          void App.player.toggle();
        }
        return;
      }

      if (event.key.length === 1 && App.connection.client) {
        event.preventDefault();
        App.library.trackFilterFocusPending = true;
        const path = resolve("/tracks");
        const params = new SvelteURLSearchParams(
          page.url.pathname.replace(/\/$/, "") === path.replace(/\/$/, "") ? page.url.search : "",
        );
        params.set("query", `${params.get("query") ?? ""}${event.key}`);
        void goto(`${path}?${params}`);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }
</script>

<div class="bg-base text-text flex h-dvh flex-col overflow-hidden" {@attach hotkeys}>
  <div class="shrink-0">
    <TopBar updateReady={Updater.ready && !Updater.nativeUpgrade} onupdate={Updater.apply} />
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
