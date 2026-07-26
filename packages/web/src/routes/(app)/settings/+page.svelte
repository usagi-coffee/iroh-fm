<script>
  import { resolve } from "$app/paths";

  import { App } from "$lib/runes/App.svelte.js";
  import ConfirmModal from "$lib/modals/ConfirmModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import {
    MAX_MEMORY_CACHE_MIB,
    MIN_MEMORY_CACHE_MIB,
    Settings,
  } from "$lib/runes/Settings.svelte.js";
  import { forceServiceWorkerUpdate, subscribeToServiceWorkerStatus } from "$lib/service-worker.js";
  import { formatBytes, friendlyError } from "$lib/utils.js";

  import CloseIcon from "virtual:icons/ri/close-line";
  import CopyIcon from "virtual:icons/ri/file-copy-line";
  import DeleteIcon from "virtual:icons/ri/delete-bin-line";

  import { ClientCore } from "@iroh-fm/client/core";

  const settings = new Settings();
  let showSecret = $state(false);
  let endpointCopied = $state(false);
  let forcingUpdate = $state(false);
  let serviceWorkerStatus = $state({
    kind: "checking",
    label: "SW CHECKING",
    detail: "Reading service worker status.",
    hash: "—",
  });
  const nativeBuildInfo = ClientCore.buildInfo().catch((error) => {
    console.warn("[build] could not read native build information", error);
    return null;
  });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let copiedTimer;

  function initialize() {
    const cleanupSettings = settings.initialize();
    const unsubscribe = subscribeToServiceWorkerStatus((status) => {
      serviceWorkerStatus = status;
    });
    return () => {
      cleanupSettings();
      unsubscribe();
      if (copiedTimer) clearTimeout(copiedTimer);
    };
  }

  async function copyDraftEndpoint() {
    try {
      const endpointId = await settings.draftEndpointId;
      if (!endpointId) return;
      await navigator.clipboard.writeText(endpointId);
      endpointCopied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (endpointCopied = false), 1600);
    } catch (error) {
      App.connection.error = friendlyError(error, "Could not copy the client endpoint ID.");
    }
  }

  async function forceUpdate() {
    forcingUpdate = true;
    try {
      await forceServiceWorkerUpdate();
    } catch (error) {
      forcingUpdate = false;
      App.connection.error = friendlyError(error, "Could not reset the application update cache.");
    }
  }

  /** @param {'tracks' | 'covers'} kind */
  async function clearOfflineCache(kind) {
    const tracks = kind === "tracks";
    const count = tracks ? settings.storage.tracks : settings.storage.covers;
    const size = tracks ? settings.storage.trackSize : settings.storage.coverSize;
    const confirmed = await modal(ConfirmModal, {
      title: `Clear offline ${kind}?`,
      message: `Remove ${count} cached ${kind} (${formatBytes(size)}) for this server? They can be downloaded again later.`,
      confirmLabel: "CLEAR",
      cancelLabel: "CANCEL",
      eyebrow: "Offline cache",
      danger: true,
    });
    if (confirmed) await settings.clearOfflineCache(kind);
  }
</script>

<section {@attach initialize} class="bg-base text-text h-full overflow-y-auto">
  <form
    onsubmit={(event) => {
      event.preventDefault();
      settings.save();
    }}
    class="mx-auto flex min-h-full w-full max-w-3xl flex-col"
  >
    <div
      class="border-surface0 bg-mantle flex shrink-0 items-center justify-between border-b px-5 py-4"
    >
      <div>
        <p class="text-3xs text-overlay0 font-mono tracking-[.16em] uppercase">Connection</p>
        <h1 class="mt-1 text-lg font-semibold">Client settings</h1>
      </div>
      <a
        href={resolve("/tracks")}
        class="text-overlay1 hover:bg-surface0 hover:text-text grid size-8 place-items-center"
        aria-label="Close settings"><CloseIcon class="text-base" /></a
      >
    </div>

    <div class="flex-1 space-y-5 p-5">
      <div>
        <label
          for="settings-ticket"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Server ticket</label
        ><textarea
          id="settings-ticket"
          bind:value={settings.ticket}
          rows="3"
          spellcheck="false"
          autocomplete="off"
          class="border-surface1 bg-mantle focus:border-mauve w-full resize-none border px-3 py-3 font-mono text-xs leading-5 outline-none"
        ></textarea>
      </div>
      <div class="text-4xs text-overlay0 flex items-center gap-3 tracking-wider uppercase">
        <span class="bg-surface0 h-px flex-1"></span>manual address override<span
          class="bg-surface0 h-px flex-1"
        ></span>
      </div>
      <div>
        <label
          for="settings-endpoint"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Server endpoint ID</label
        ><input
          id="settings-endpoint"
          bind:value={settings.endpoint}
          spellcheck="false"
          autocomplete="off"
          placeholder="Leave empty to use ticket"
          class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 font-mono text-xs outline-none"
        />
      </div>
      <div>
        <div class="mb-2 flex items-center justify-between">
          <label
            for="settings-relay-0"
            class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase">Relay URLs</label
          ><button
            type="button"
            onclick={settings.addRelay}
            class="text-3xs text-mauve hover:text-pink font-mono">+ ADD RELAY</button
          >
        </div>
        <div class="space-y-2">
          {#each settings.relays as relayUrl, index}<div class="relative">
              <input
                id={`settings-relay-${index}`}
                bind:value={settings.relays[index]}
                spellcheck="false"
                autocomplete="url"
                placeholder="https://relay.example"
                class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 pr-10 font-mono text-xs outline-none"
              />{#if settings.relays.length > 1}<button
                  type="button"
                  onclick={() => settings.removeRelay(index)}
                  class="text-overlay0 hover:text-red absolute inset-y-0 right-2 grid w-7 place-items-center"
                  aria-label={`Remove relay ${index + 1}`}><CloseIcon class="text-xs" /></button
                >{/if}
            </div>{/each}
        </div>
      </div>
      <div>
        <label
          for="settings-secret"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Client secret</label
        >
        <div class="relative">
          <input
            id="settings-secret"
            bind:value={settings.secret}
            type={showSecret ? "text" : "password"}
            spellcheck="false"
            autocomplete="new-password"
            class="border-surface1 bg-mantle focus:border-mauve h-11 w-full border px-3 pr-14 font-mono text-xs outline-none"
          /><button
            type="button"
            onclick={() => (showSecret = !showSecret)}
            class="text-3xs text-overlay1 hover:text-mauve absolute inset-y-0 right-3 font-mono"
            >{showSecret ? "HIDE" : "SHOW"}</button
          >
        </div>
        <div class="mt-3">
          <svelte:boundary>
            <div class="mb-2 flex items-center justify-between gap-3">
              <p class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase">
                Client endpoint ID
              </p>
              <button
                type="button"
                onclick={copyDraftEndpoint}
                disabled={!settings.secret.trim()}
                class="text-3xs text-mauve hover:text-pink disabled:text-overlay0 flex items-center gap-1.5 font-mono"
                ><CopyIcon class="text-xs" />{endpointCopied ? "COPIED" : "COPY"}</button
              >
            </div>
            <code class="text-2xs text-subtext0 block font-mono leading-5 break-all"
              >{settings.secret.trim()
                ? await settings.draftEndpointId
                : "Generated automatically when settings are saved"}</code
            >
            {#snippet pending()}<code class="text-2xs text-overlay0 block font-mono leading-5"
                >Calculating endpoint ID…</code
              >{/snippet}
            {#snippet failed()}<code class="text-2xs text-red block font-mono leading-5"
                >Invalid client secret</code
              >{/snippet}
          </svelte:boundary>
        </div>
      </div>
      <div>
        <label
          for="settings-starred-key"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Starred collection key</label
        ><input
          id="settings-starred-key"
          bind:value={settings.starredKey}
          spellcheck="false"
          autocomplete="off"
          placeholder="Default: this client identity"
          class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 font-mono text-xs outline-none"
        />
        <p class="text-3xs text-overlay0 mt-1.5 leading-4">
          Leave empty for a private collection tied to the Client Endpoint ID. Use the same custom
          key on multiple clients to share one collection.
        </p>
      </div>

      <section aria-labelledby="storage-title">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p
              id="storage-title"
              class="text-4xs text-overlay0 font-mono tracking-[.14em] uppercase"
            >
              Offline cache
            </p>
            <p class="text-3xs text-overlay1 mt-1">
              Downloaded albums are kept for offline playback; normal playback uses a memory cache.
            </p>
          </div>
          <button
            type="button"
            onclick={settings.refreshStorageInfo}
            disabled={settings.storage.loading}
            class="text-4xs text-mauve hover:text-pink shrink-0 font-mono disabled:opacity-40"
            >{settings.storage.loading ? "READING…" : "REFRESH"}</button
          >
        </div>
        <div class="divide-surface0 mt-3 grid grid-cols-2 divide-x">
          <div class="pr-3">
            <p class="text-4xs text-overlay0 font-mono uppercase">Tracks</p>
            <p class="text-text mt-1 text-xs">
              {settings.storage.tracks} · {formatBytes(settings.storage.trackSize)}
            </p>
            <button
              type="button"
              onclick={() => clearOfflineCache("tracks")}
              disabled={settings.storage.loading ||
                Boolean(settings.storage.clearing) ||
                settings.storage.tracks === 0}
              class="text-4xs text-red hover:text-maroon mt-2 inline-flex items-center gap-1.5 font-mono disabled:opacity-35"
              ><DeleteIcon class="text-xs" />{settings.storage.clearing === "tracks"
                ? "CLEARING…"
                : "CLEAR TRACKS"}</button
            >
          </div>
          <div class="pl-3">
            <p class="text-4xs text-overlay0 font-mono uppercase">Covers</p>
            <p class="text-text mt-1 text-xs">
              {settings.storage.covers} · {formatBytes(settings.storage.coverSize)}
            </p>
            <button
              type="button"
              onclick={() => clearOfflineCache("covers")}
              disabled={settings.storage.loading ||
                Boolean(settings.storage.clearing) ||
                settings.storage.covers === 0}
              class="text-4xs text-red hover:text-maroon mt-2 inline-flex items-center gap-1.5 font-mono disabled:opacity-35"
              ><DeleteIcon class="text-xs" />{settings.storage.clearing === "covers"
                ? "CLEARING…"
                : "CLEAR COVERS"}</button
            >
          </div>
        </div>
        {#if settings.storage.error}
          <p class="text-3xs text-red mt-2" role="alert">{settings.storage.error}</p>
        {/if}
        <div class="border-surface0 mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <div class="min-w-0">
            <p class="text-3xs text-subtext0">
              Browser storage: {formatBytes(settings.storage.usage)} / {formatBytes(
                settings.storage.quota,
              )}
            </p>
            <p class="text-4xs text-overlay0 mt-1">
              {settings.storage.persisted
                ? "Persistent storage granted; the browser should not evict this cache automatically."
                : "Storage may be evicted under pressure. Browser quota is managed automatically."}
            </p>
          </div>
          {#if settings.storage.supported && !settings.storage.persisted}<button
              type="button"
              onclick={settings.requestPersistentStorage}
              disabled={settings.storage.requesting}
              class="border-mauve text-4xs text-mauve hover:bg-mauve hover:text-crust shrink-0 border px-2 py-1.5 font-mono disabled:opacity-40"
              >{settings.storage.requesting ? "REQUESTING…" : "KEEP OFFLINE"}</button
            >{/if}
        </div>
        <div class="border-surface0 mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <div>
            <p class="text-3xs text-subtext0">Memory cache limit</p>
            <p class="text-4xs text-overlay0 mt-1">Tracks kept in RAM for quick replay.</p>
          </div>
          <label class="text-3xs text-subtext0 flex shrink-0 items-center gap-2">
            <input
              type="number"
              min={MIN_MEMORY_CACHE_MIB}
              max={MAX_MEMORY_CACHE_MIB}
              step="16"
              bind:value={settings.memoryCacheMiB}
              class="border-surface1 bg-mantle focus:border-mauve h-9 w-24 border px-2 text-right font-mono text-xs outline-none"
              aria-label="Memory cache size in MiB"
            />
            MiB
          </label>
        </div>
      </section>
      <section
        aria-labelledby="update-title"
        class="border-surface0 flex flex-col items-center gap-3 border-t pt-5 text-center"
      >
        <div>
          <p id="update-title" class="text-4xs text-overlay0 font-mono tracking-[.14em] uppercase">
            Application update
          </p>
        </div>
        <button
          type="button"
          onclick={forceUpdate}
          disabled={forcingUpdate}
          class="border-mauve text-4xs text-mauve hover:bg-mauve hover:text-crust shrink-0 border px-3 py-2 font-mono disabled:opacity-40"
          >{forcingUpdate ? "RESETTING…" : "FORCE UPDATE"}</button
        >
      </section>
      <div class="text-2xs text-overlay1 flex justify-center text-center leading-5">
        <div class="text-4xs text-overlay0 flex flex-col items-center gap-0.5 font-mono">
          <div class="flex items-center gap-2">
            <span title="Remote web build commit">WEB {__BUILD_COMMIT__}</span>
            <span aria-hidden="true" class="bg-surface1 h-3 w-px"></span>
            <span title="Running service worker build commit">
              SW {serviceWorkerStatus.hash}
            </span>
            <span aria-hidden="true" class="bg-surface1 h-3 w-px"></span>
            <span
              title={serviceWorkerStatus.detail}
              class:text-green={serviceWorkerStatus.kind === "active"}
              class:text-yellow={serviceWorkerStatus.kind === "installing" ||
                serviceWorkerStatus.kind === "update-ready"}
              class:text-red={serviceWorkerStatus.kind === "error"}
              class="inline-flex items-center gap-1"
            >
              <span
                aria-hidden="true"
                class:bg-green={serviceWorkerStatus.kind === "active"}
                class:bg-yellow={serviceWorkerStatus.kind === "installing" ||
                  serviceWorkerStatus.kind === "update-ready"}
                class:bg-red={serviceWorkerStatus.kind === "error"}
                class:bg-overlay0={serviceWorkerStatus.kind !== "active" &&
                  serviceWorkerStatus.kind !== "installing" &&
                  serviceWorkerStatus.kind !== "update-ready" &&
                  serviceWorkerStatus.kind !== "error"}
                class="size-1.5 rounded-full"
              ></span>
              {serviceWorkerStatus.label}
            </span>
          </div>
          <svelte:boundary>
            {const buildInfo = await nativeBuildInfo}
            {#if buildInfo}
              <span title={`${buildInfo.platform} application build commit`}>
                {buildInfo.platform.toUpperCase()}
                {buildInfo.commit.slice(0, 12)}
              </span>
            {/if}
          </svelte:boundary>
        </div>
      </div>
    </div>

    <div
      class="border-surface0 bg-mantle sticky bottom-0 flex shrink-0 justify-end gap-2 border-t px-5 py-3"
    >
      <a
        href={resolve("/tracks")}
        class="border-surface1 text-3xs text-subtext0 hover:bg-surface0 border px-4 py-2 font-mono"
        >CANCEL</a
      ><button
        type="submit"
        disabled={!settings.canSave}
        class="bg-mauve text-3xs text-crust hover:bg-pink px-4 py-2 font-mono font-bold disabled:opacity-40"
        >SAVE & RECONNECT</button
      >
    </div>
  </form>
</section>
