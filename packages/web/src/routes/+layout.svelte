<script>
  import { invalidate } from "$app/navigation";
  import { asset } from "$app/paths";

  import { App } from "$lib/runes/App.svelte.js";
  import { Updater } from "$lib/runes/Updater.svelte.js";
  import { connectionAddressLabel, formatBytes } from "$lib/utils.js";

  import DatabaseIcon from "virtual:icons/ri/database-2-line";

  import { ClientCore } from "@iroh-fm/client/core";
  import "../app.css";

  /** @type {{ children: import("svelte").Snippet<[void]> }} */
  const { children } = $props();
</script>

<svelte:head>
  <title>iroh.fm</title>
  <meta name="description" content="A private iroh music player." />
</svelte:head>

<div id="content" {@attach Updater.watch} {@attach App.connection.watch}>
  <svelte:boundary>
    {const sw = Updater.start}
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
      {#if Updater.block === "web"}
        {@render webUpdateBlocked()}
      {:else if Updater.block}
        {@render nativeBlocked(Updater.block)}
      {:else}
        {@render startupFailed(error)}
      {/if}
    {/snippet}
  </svelte:boundary>
</div>

{#snippet nativeBlocked(/** @type {{ platform: string, releaseUrl: string }} */ requirement)}
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
        onclick={Updater.apply}
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
        aria-valuemax="9"
        aria-valuenow={step}
      >
        <div class="bg-mauve h-full" style={`width:${(step / 9) * 100}%`}></div>
      </div>
      {#if App.connection.loadingClient ?? App.connection.client}
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
