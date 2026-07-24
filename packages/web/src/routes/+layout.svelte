<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { goto, invalidate } from "$app/navigation";
  import { asset } from "$app/paths";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";
  import { Updates } from "$lib/runes/Updater.svelte.js";
  import { currentNativeRequirement, ensure_service_worker } from "$lib/service-worker.js";
  import { connectionAddressLabel, formatBytes } from "$lib/utils.js";

  import DatabaseIcon from "virtual:icons/ri/database-2-line";

  import { ClientCore } from "@iroh-fm/client/core";
  import "../app.css";

  /** @type {{ children: import("svelte").Snippet<[void]> }} */
  const { children } = $props();

  /** @type {ReturnType<typeof currentNativeRequirement>} */
  let initialNativeRequirement = $state(null);
  let initialWebUpdateRequired = $state(false);
  const startupStepCount = 9;
  const nativeBuild = Updates.nativeBuild;
  const monitoredClient = $derived(App.connection.loadingClient ?? App.connection.client);
  const connectionMonitor = $derived(
    App.connection.monitor(monitoredClient, App.connection.loadingClient ? 250 : 1000),
  );
  const nativeCompatibility = nativeBuild.then((buildInfo) => {
    initialNativeRequirement = currentNativeRequirement(buildInfo);
    return initialNativeRequirement;
  });
  const registeredWorker = nativeBuild.then((buildInfo) => ensure_service_worker(buildInfo));

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
      if (Updates.applying) {
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

<svelte:head>
  <title>iroh.fm</title>
  <meta name="description" content="A private iroh music player." />
</svelte:head>

<div
  id="content"
  {@attach Updates.watch}
  {@attach globalKeybinds}
  {@attach App.connection.attachHashChanges}
  {@attach connectionMonitor}
>
  <svelte:boundary>
    {const sw = Promise.all([registeredWorker, nativeCompatibility]).then(
      ([worker, requirement]) => {
        if (requirement) throw new Error("The native application is out of date.");
        if (worker.updateReady && worker.nativeNewerThanWeb && !worker.nativeUpgrade) {
          initialWebUpdateRequired = true;
          throw new Error("The cached web application is out of date.");
        }
      },
    )}
    {await sw}
    <svelte:boundary>
      {const wasm = sw.then(() => ClientCore.prepare())}
      {await wasm}
      <svelte:boundary>
        {const cache = wasm.then(() => ClientCore.prepareCaches())}
        {await cache}
        <svelte:boundary>
          {const identity = cache.then(() => App.prepareIdentity())}
          {await identity}
          <svelte:boundary>
            {const ready = identity.then(() => App.initialize())}
            {await App.connection.startupTransportReady}
            <svelte:boundary>
              {const guarded = ready.then(() => invalidate("app:connection"))}
              {@render children(void (await guarded))}

              {#snippet pending()}
                {@render loading({
                  text: $state.eager(App.connection.connectionStep),
                  step: $state.eager(App.connection.connectionProgress),
                })}
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
      {:else if initialWebUpdateRequired}
        {@render webUpdateBlocked()}
      {:else}
        {@render startupFailed(error)}
      {/if}
    {/snippet}
  </svelte:boundary>
</div>

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

{#snippet webUpdateBlocked()}
  <div class="bg-base text-text grid h-dvh place-items-center p-6">
    <div class="border-mauve/40 bg-crust w-full max-w-md border p-5 text-center">
      <h1 class="text-mauve text-sm font-semibold">Web application update required</h1>
      <p class="text-overlay1 mt-2 text-xs leading-5">
        The updated application is ready. Install it before starting the player.
      </p>
      <button
        type="button"
        onclick={Updates.apply}
        class="bg-mauve text-3xs text-crust mt-4 px-4 py-2 font-mono font-bold">WEB UPDATE</button
      >
    </div>
  </div>
{/snippet}

{#snippet loading(/** @type {{ text: string, step: number }} */ { text, step })}
  <div class="bg-base text-text grid h-dvh place-items-center p-6">
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
        aria-valuemax={startupStepCount}
        aria-valuenow={step}
      >
        <div class="bg-mauve h-full" style={`width:${(step / startupStepCount) * 100}%`}></div>
      </div>
      {#if monitoredClient}
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
