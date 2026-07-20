<script>
  import { goto } from "$app/navigation";
  import { asset } from "$app/paths";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";
  import {
    activateServiceWorkerUpdate,
    currentNativeRequirement,
    ensure_service_worker,
    subscribeToNativeUpgrade,
    subscribeToServiceWorkerUpdates,
  } from "$lib/service-worker.js";
  import { connectionAddressLabel, formatBytes } from "$lib/utils.js";

  import CloseIcon from "virtual:icons/ri/close-line";
  import DatabaseIcon from "virtual:icons/ri/database-2-line";
  import RefreshIcon from "virtual:icons/ri/refresh-line";

  import PlayerBar from "./PlayerBar.svelte";
  import TopBar from "./TopBar.svelte";

  import { ClientCore } from "@iroh-fm/client/core";
  import "../app.css";

  /** @typedef {import('./$types').LayoutProps} Props */
  /** @type {Props} */
  let { children } = $props();
  let updateReady = $state(false);
  let updateBannerDismissed = $state(false);
  /** @type {ReturnType<typeof currentNativeRequirement>} */
  let nativeUpgrade = $state(null);
  /** @type {ReturnType<typeof currentNativeRequirement>} */
  let initialNativeRequirement = $state(null);
  let connectPath = $derived(resolve("/connect").replace(/\/$/, ""));
  let onConnectPage = $derived(page.url.pathname.replace(/\/$/, "") === connectPath);
  const nativeBuild = ClientCore.buildInfo();
  const nativeCompatibility = nativeBuild.then((buildInfo) => {
    initialNativeRequirement = currentNativeRequirement(buildInfo);
    return initialNativeRequirement;
  });
  const registeredWorker = nativeBuild.then((buildInfo) => ensure_service_worker(buildInfo));
  const sw = Promise.all([registeredWorker, nativeCompatibility]).then(([, requirement]) => {
    if (requirement) throw new Error("The native application is out of date.");
  });
  const wasm = sw.then(() => ClientCore.prepare());
  const cache = wasm.then(() => ClientCore.prepareCaches());
  const identity = cache.then(() => App.prepareIdentity());
  const connected = Promise.withResolvers();
  const ready = identity.then(() => App.initialize(() => connected.resolve(undefined)));

  /** @param {'/connect' | '/tracks'} path */
  function navigate(path) {
    return () => {
      void goto(resolve(path), { replaceState: true });
    };
  }

  function watchUpdates() {
    const unsubscribeUpdates = subscribeToServiceWorkerUpdates((ready) => {
      updateReady = ready;
      if (!ready) updateBannerDismissed = false;
    });
    const unsubscribeNative = subscribeToNativeUpgrade((upgrade) => (nativeUpgrade = upgrade));
    return () => {
      unsubscribeUpdates();
      unsubscribeNative();
    };
  }

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

  function globalKeybinds() {
    /** @param {KeyboardEvent} event */
    const keydown = (event) => {
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
        void App.library.focusTrackFilter(event.key);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }
</script>

<svelte:head>
  <title>iroh.fm</title>
  <meta name="description" content="A private iroh music player." />
</svelte:head>

<div
  id="content"
  {@attach watchUpdates}
  {@attach globalKeybinds}
  {@attach App.connection.attachHashChanges}
>
  {#snippet errorToast()}
    {#if App.connection.client && App.connection.error}
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
  {/snippet}

  {#snippet updateNotice(/** @type {boolean} */ overlay)}
    {#if nativeUpgrade}
      <div
        class:fixed={overlay}
        class:top-0={overlay}
        class:left-0={overlay}
        class:z-50={overlay}
        class="border-yellow/40 bg-crust text-yellow flex min-h-9 w-full items-center justify-center gap-3 border-b px-3 py-2 text-center"
        role="status"
      >
        <span class="text-3xs font-mono font-bold tracking-[.06em] uppercase">
          Your {nativeUpgrade.platform} application is out of date. Upgrade your {nativeUpgrade.platform}
          application to use the new web version.
        </span>
        <a
          href={nativeUpgrade.releaseUrl}
          target="_blank"
          rel="noreferrer"
          class="border-yellow/50 hover:bg-yellow/10 text-3xs shrink-0 border px-2 py-1 font-mono font-bold"
          >DOWNLOAD {nativeUpgrade.platform.toUpperCase()}</a
        >
      </div>
    {:else if updateReady && !updateBannerDismissed}
      <div
        class:fixed={overlay}
        class:top-0={overlay}
        class:left-0={overlay}
        class:z-50={overlay}
        class="border-mauve/30 bg-mauve/10 text-mauve flex h-9 w-full border-b"
      >
        <button
          type="button"
          onclick={activateServiceWorkerUpdate}
          class="text-3xs hover:bg-mauve/15 flex min-w-0 flex-1 items-center justify-center gap-2 font-mono font-bold tracking-[.08em]"
          title="Install application update"><RefreshIcon class="text-sm" />WEB UPDATE AVAILABLE</button
        >
        <button
          type="button"
          onclick={() => (updateBannerDismissed = true)}
          class="border-mauve/20 text-mauve/80 hover:bg-mauve/15 hover:text-mauve grid w-10 shrink-0 place-items-center border-l"
          title="Dismiss update notice"
          aria-label="Dismiss update notice"><CloseIcon class="text-base" /></button
        >
      </div>
    {/if}
  {/snippet}

  {#snippet nativeBlocked(
    /** @type {NonNullable<ReturnType<typeof currentNativeRequirement>>} */ requirement,
  )}
    <div class="bg-base text-text grid h-dvh place-items-center p-6">
      <div class="border-yellow/40 bg-crust w-full max-w-md border p-5 text-center">
        <h1 class="text-yellow text-sm font-semibold">
          Your {requirement.platform} application is out of date
        </h1>
        <p class="text-overlay1 mt-2 text-xs leading-5">
          This web version requires a newer {requirement.platform} application before it can start.
        </p>
        <a
          href={requirement.releaseUrl}
          target="_blank"
          rel="noreferrer"
          class="bg-yellow text-3xs text-crust mt-4 inline-block px-4 py-2 font-mono font-bold"
          >GET {requirement.platform.toUpperCase()}</a
        >
      </div>
    </div>
  {/snippet}

  {#snippet loading(/** @type {{ text: string, step: number }} */ { text, step })}
    <div
      {@attach App.connection.monitor(App.connection.loadingClient)}
      class="bg-base text-text grid h-dvh place-items-center p-6"
    >
      <div class="flex w-full max-w-56 flex-col items-center gap-4 text-center">
        <img src={asset("/pwa-icon-192.png")} alt="" class="size-12 rounded-xl" />
        <div>
          <p class="text-sm font-semibold">Preparing the player</p>
          <p class="text-2xs text-overlay1 mt-1">{text}</p>
        </div>
        <div
          class="bg-surface0 h-1 w-full overflow-hidden"
          role="progressbar"
          aria-label={text}
          aria-valuemin="0"
          aria-valuemax="6"
          aria-valuenow={step}
        >
          <div
            class="bg-mauve h-full transition-[width] duration-300"
            style={`width:${(step / 6) * 100}%`}
          ></div>
        </div>
        {#if App.connection.loadingClient}
          <div
            class="border-surface0 bg-mantle text-4xs text-overlay1 flex w-fit max-w-full items-center justify-center gap-1.5 border px-2 py-1 font-mono"
            title={`${App.connection.info.path_type}: ${App.connection.info.address || "selecting path"}`}
          >
            <span class="flex min-w-0 flex-col text-left leading-tight"
              ><span class="text-subtext0 text-5xs flex w-full items-center justify-center gap-1">
                <span class="truncate"
                  >{App.connection.info.address
                    ? connectionAddressLabel(App.connection.info)
                    : "CONNECTING"}</span
                ><span
                  class="size-1.5 shrink-0 rounded-full {App.connection.info.address
                    ? 'bg-green'
                    : 'bg-yellow animate-pulse'}"
                ></span>
              </span>
              <span class="text-overlay0 text-5xs flex items-center gap-2 whitespace-nowrap"
                ><span class="flex items-center gap-1"
                  ><DatabaseIcon class="text-4xs" />{formatBytes(
                    App.connection.info.received_bytes,
                  )}</span
                ><span>↓ {formatBytes(App.connection.receivedBytesPerSecond)}/s</span></span
              ></span
            >
          </div>
        {/if}
        <p class="text-4xs text-overlay0 font-mono tracking-[.08em]">
          BUILD {__BUILD_COMMIT__}
        </p>
      </div>
    </div>
  {/snippet}

  {#snippet startupFailed(/** @type {unknown} */ error)}
    <div class="bg-base text-text grid h-dvh place-items-center p-6">
      <div class="border-red/40 bg-crust w-full max-w-sm border p-5 text-center">
        <h1 class="text-red text-sm font-semibold">The application encountered an error</h1>
        <p class="text-overlay1 mt-2 text-xs leading-5 break-words">{String(error)}</p>
        <button
          type="button"
          onclick={() => location.reload()}
          class="bg-mauve text-3xs text-crust mt-4 px-4 py-2 font-mono font-bold">RETRY</button
        >
      </div>
    </div>
  {/snippet}

  <svelte:boundary>
    {await sw}
    <svelte:boundary>
      {await wasm}
      <svelte:boundary>
        {await cache}
        <svelte:boundary>
          {await identity}
          <svelte:boundary>
            {await connected.promise}
            <svelte:boundary>
              {await ready}
              {#if App.connection.client}
                {#if onConnectPage}
                  <div
                    {@attach navigate("/tracks")}
                    class="bg-base text-text grid h-dvh place-items-center p-6"
                  >
                    <p class="text-3xs text-overlay1 font-mono">OPENING LIBRARY…</p>
                  </div>
                {:else}
                  <div
                    {@attach App.connection.monitor(App.connection.client)}
                    class="bg-base text-text flex h-dvh flex-col overflow-hidden"
                  >
                    <div class="shrink-0">
                      <TopBar
                        updateReady={updateReady && !nativeUpgrade}
                        onupdate={activateServiceWorkerUpdate}
                      />
                      {@render updateNotice(false)}
                    </div>
                    <main class="min-h-0 flex-1 overflow-hidden">{@render children()}</main>
                    <PlayerBar />
                  </div>
                {/if}
              {:else if onConnectPage}
                {@render children()}
                {@render updateNotice(true)}
              {:else}
                <div
                  {@attach navigate("/connect")}
                  class="bg-base text-text grid h-dvh place-items-center p-6"
                >
                  <p class="text-3xs text-overlay1 font-mono">OPENING CONNECTION SETUP…</p>
                </div>
              {/if}
              {@render errorToast()}

              {#snippet pending()}
                {@render loading({ text: App.connection.connectionStep, step: 6 })}
              {/snippet}
            </svelte:boundary>
            {#snippet pending()}
              {@render loading({ text: "Connecting to the iroh server…", step: 5 })}
            {/snippet}
          </svelte:boundary>
          {#snippet pending()}
            {@render loading({ text: "Preparing the client identity…", step: 4 })}
          {/snippet}
        </svelte:boundary>
        {#snippet pending()}
          {@render loading({ text: "Opening the offline media cache…", step: 3 })}
        {/snippet}
      </svelte:boundary>
      {#snippet pending()}
        {@render loading({ text: "Loading the iroh WebAssembly client…", step: 2 })}
      {/snippet}
    </svelte:boundary>
    {#snippet pending()}
      {@render loading({ text: "Starting the service worker…", step: 1 })}
    {/snippet}
    {#snippet failed(error)}
      {#if initialNativeRequirement}
        {@render nativeBlocked(initialNativeRequirement)}
      {:else}
        {@render startupFailed(error)}
      {/if}
    {/snippet}
  </svelte:boundary>
</div>
