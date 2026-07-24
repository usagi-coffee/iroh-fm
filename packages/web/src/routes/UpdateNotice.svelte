<script>
  import { Updater } from "$lib/runes/Updater.svelte.js";

  import CloseIcon from "virtual:icons/ri/close-line";
  import RefreshIcon from "virtual:icons/ri/refresh-line";

  /** @type {{ overlay: boolean }} */
  const { overlay } = $props();
</script>

{#if Updater.androidRestartRequired}
  <div
    class:fixed={overlay}
    class:top-0={overlay}
    class:left-0={overlay}
    class:z-50={overlay}
    class="border-yellow/40 bg-crust text-yellow flex min-h-9 w-full items-center justify-center gap-3 border-b px-3 py-2 text-center"
    role="status"
  >
    <RefreshIcon class="text-sm" />
    <span class="text-3xs font-mono font-bold tracking-[.08em] uppercase"
      >UPDATE INSTALLED — RESTART THE APP</span
    >
  </div>
{:else if Updater.nativeUpgrade}
  <div
    class:fixed={overlay}
    class:top-0={overlay}
    class:left-0={overlay}
    class:z-50={overlay}
    class="border-yellow/40 bg-crust text-yellow flex min-h-9 w-full items-center justify-center gap-3 border-b px-3 py-2 text-center"
    role="status"
  >
    <span class="text-3xs font-mono font-bold tracking-[.06em] uppercase">
      Upgrade {Updater.nativeUpgrade.platform} app to use the newest web version
    </span>
    {#if Updater.nativeUpgrade.platform === "Android"}
      <div class="flex shrink-0 flex-col gap-1">
        <a
          href={Updater.nativeUpgrade.downloadUrl}
          target="_blank"
          rel="noreferrer"
          class="bg-yellow text-crust text-3xs px-2 py-1 font-mono font-bold">DOWNLOAD</a
        >
        <a
          href={Updater.nativeUpgrade.releaseUrl}
          target="_blank"
          rel="noreferrer"
          class="border-yellow/50 hover:bg-yellow/10 text-3xs border px-2 py-1 font-mono font-bold"
          >RELEASES</a
        >
      </div>
    {:else}
      <a
        href={Updater.nativeUpgrade.releaseUrl}
        target="_blank"
        rel="noreferrer"
        class="border-yellow/50 hover:bg-yellow/10 text-3xs shrink-0 border px-2 py-1 font-mono font-bold"
        >RELEASES</a
      >
    {/if}
  </div>
{:else if Updater.ready && !Updater.dismissed}
  <div
    class:fixed={overlay}
    class:top-0={overlay}
    class:left-0={overlay}
    class:z-50={overlay}
    class="border-mauve/30 bg-mauve/10 text-mauve flex h-9 w-full border-b"
  >
    <button
      type="button"
      onclick={Updater.apply}
      class="text-3xs hover:bg-mauve/15 flex min-w-0 flex-1 items-center justify-center gap-2 font-mono font-bold tracking-[.08em]"
      title="Install application update"><RefreshIcon class="text-sm" />WEB UPDATE AVAILABLE</button
    >
    <button
      type="button"
      onclick={() => (Updater.dismissed = true)}
      class="border-mauve/20 text-mauve/80 hover:bg-mauve/15 hover:text-mauve grid w-10 shrink-0 place-items-center border-l"
      title="Dismiss update notice"
      aria-label="Dismiss update notice"><CloseIcon class="text-base" /></button
    >
  </div>
{/if}

{#if Updater.applying}
  <div
    class="bg-crust text-text fixed inset-0 z-[100] grid place-items-center p-6"
    role="dialog"
    aria-modal="true"
    aria-busy="true"
    aria-label="Applying web update"
  >
    <div class="flex w-full max-w-xs flex-col items-center gap-4 text-center">
      <RefreshIcon class="text-mauve animate-spin text-3xl" />
      <div>
        <p class="text-sm font-semibold">Applying web update</p>
        <p class="text-2xs text-overlay1 mt-1">Please wait while the new version is installed…</p>
      </div>
    </div>
  </div>
{/if}
