<script>
  import { goto } from "$app/navigation";
  import { asset, resolve } from "$app/paths";
  import { page } from "$app/state";

  import ConfirmModal from "$lib/modals/ConfirmModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { connectionAddressLabel, formatBytes, friendlyError } from "$lib/utils.js";

  import RelayIcon from "virtual:icons/ri/base-station-line";
  import MaximizeIcon from "virtual:icons/ri/checkbox-blank-line";
  import CloseIcon from "virtual:icons/ri/close-line";
  import DatabaseIcon from "virtual:icons/ri/database-2-line";
  import DirectIcon from "virtual:icons/ri/link";
  import DisconnectIcon from "virtual:icons/ri/logout-box-r-line";
  import RefreshIcon from "virtual:icons/ri/refresh-line";
  import SettingsIcon from "virtual:icons/ri/settings-3-line";
  import MinimizeIcon from "virtual:icons/ri/subtract-line";
  import ConnectingIcon from "virtual:icons/ri/wifi-line";
  import OfflineIcon from "virtual:icons/ri/wifi-off-line";

  /** @typedef {{ updateReady: boolean, onupdate: () => void }} Props */
  /** @type {Props} */
  let { updateReady, onupdate } = $props();
  const path = $derived(page.url.pathname.replace(/\/$/, ""));
  const connectionToggleTitle = $derived(
    App.library.offlineOnly
      ? "Offline-only mode enabled — use network"
      : App.connection.info.path_type === "relay"
        ? "Connected via relay — use cached music only"
        : App.connection.info.path_type === "direct"
          ? "Connected directly — use cached music only"
          : "Connecting — use cached music only",
  );
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  /** @param {'minimize' | 'toggleMaximize' | 'close'} command */
  async function windowCommand(command) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[command]();
  }

  async function confirmDisconnect() {
    try {
      const confirmed = await modal(ConfirmModal, {
        title: "Leave this library?",
        message: "Playback will stop and you will return to the connection screen.",
        confirmLabel: "DISCONNECT",
        cancelLabel: "CANCEL",
        eyebrow: "Disconnect",
        danger: true,
      });
      if (confirmed) {
        await App.connection.disconnect();
        await goto(resolve("/connect"));
      }
    } catch (error) {
      App.connection.error = friendlyError(error, "Could not open the disconnect dialog.");
    }
  }
</script>

<header
  data-tauri-drag-region={desktop ? "" : undefined}
  class="border-surface0 bg-crust text-2xs flex h-9 min-w-0 items-center border-b"
>
  <a
    href={resolve("/tracks")}
    onclick={() => App.library.requestTrackFocus(App.player.currentTrack)}
    class="border-surface0 grid h-full w-10 shrink-0 place-items-center border-r"
    ><img src={asset("/pwa-icon-192.png")} alt="iroh.fm" class="size-6" /></a
  >
  <nav class="flex h-full min-w-0 items-stretch">
    <a
      href={resolve("/tracks")}
      onclick={() => App.library.requestTrackFocus(App.player.currentTrack)}
      class="border-surface0 hover:bg-surface0 grid place-items-center border-r px-3 font-semibold whitespace-nowrap transition {path.endsWith(
        '/tracks',
      )
        ? 'bg-surface0 text-text'
        : 'text-overlay1'}">TRACKS</a
    >
    <a
      href={resolve("/albums")}
      class="border-surface0 hover:bg-surface0 grid place-items-center border-r px-3 font-semibold whitespace-nowrap transition {path.endsWith(
        '/albums',
      )
        ? 'bg-surface0 text-text'
        : 'text-overlay1'}">ALBUMS</a
    >
    <a
      href={resolve("/starred")}
      class="border-surface0 hover:bg-surface0 grid place-items-center border-r px-3 font-semibold whitespace-nowrap transition {path.endsWith(
        '/starred',
      )
        ? 'bg-surface0 text-pink'
        : 'text-overlay1'}">STARRED</a
    >
  </nav>
  <div
    data-tauri-drag-region={desktop ? "" : undefined}
    ondblclick={() => desktop && windowCommand("toggleMaximize")}
    role="presentation"
    class="h-full min-w-4 flex-1"
  ></div>
  <div class="flex h-full min-w-0 items-center">
    <div
      class="border-surface0 text-4xs text-overlay1 tablet-xl:flex hidden h-full min-w-36 items-center gap-2 border-l px-2 font-mono"
      title={`${App.connection.info.path_type}: ${App.connection.info.address || "selecting path"} · ${formatBytes(App.connection.receivedBytesPerSecond)}/s · ${formatBytes(App.connection.info.received_bytes)} received`}
    >
      <span class="flex min-w-0 flex-1 flex-col items-end text-right leading-tight"
        ><span
          class="text-subtext0 text-5xs desktop:max-w-44 flex max-w-28 items-center gap-1"
          ><span class="truncate">{connectionAddressLabel(App.connection.info)}</span><span
            class="size-1.5 shrink-0 rounded-full {App.connection.info.address
              ? 'bg-green'
              : 'bg-yellow animate-pulse'}"
          ></span></span
        ><span class="text-overlay0 text-5xs flex items-center gap-2 whitespace-nowrap"
          ><span class="flex items-center gap-1"><DatabaseIcon class="text-4xs" />{formatBytes(
              App.connection.info.received_bytes,
            )}</span
          ><span>↓ {formatBytes(App.connection.receivedBytesPerSecond)}/s</span></span
        ></span
      >
    </div>
    {#if updateReady}<button
        type="button"
        onclick={onupdate}
        class="border-surface0 bg-mauve/15 text-mauve hover:bg-mauve hover:text-crust grid h-full w-9 place-items-center border-l"
        title="Update ready"
        aria-label="Install application update"><RefreshIcon class="text-sm" /></button
      >{/if}
    <button
      type="button"
      onclick={() => App.library.toggleOfflineOnly()}
      class="border-surface0 hover:bg-surface0 grid h-full w-9 place-items-center border-l {App
        .library.offlineOnly
        ? 'bg-surface0 text-mauve'
        : 'text-overlay1 hover:text-mauve'}"
      title={connectionToggleTitle}
      aria-label={connectionToggleTitle}
      aria-pressed={App.library.offlineOnly}
      >{#if App.library.offlineOnly}<OfflineIcon class="text-sm" />{:else}<span
          class="tablet-xl:hidden {App.connection.info.address
            ? 'text-green'
            : 'text-yellow animate-pulse'}"
          >{#if App.connection.info.path_type === "relay"}<RelayIcon
              class="text-sm"
            />{:else if App.connection.info.path_type === "direct"}<DirectIcon
              class="text-sm"
            />{:else}<ConnectingIcon class="text-sm" />{/if}</span
        ><OfflineIcon class="tablet-xl:block hidden text-sm" />{/if}</button
    >
    <a
      href={resolve("/settings")}
      class="border-surface0 hover:bg-surface0 hover:text-mauve grid h-full w-9 place-items-center border-l {path.endsWith(
        '/settings',
      )
        ? 'bg-surface0 text-mauve'
        : 'text-overlay1'}"
      title="Connection settings"><SettingsIcon class="text-sm" /></a
    >
    <button
      type="button"
      onclick={confirmDisconnect}
      class="border-surface0 text-overlay1 hover:bg-surface0 hover:text-red grid h-full w-9 place-items-center border-l"
      title="Disconnect"><DisconnectIcon class="text-sm" /></button
    >
    {#if desktop}<button
        type="button"
        onclick={() => windowCommand("minimize")}
        class="border-surface0 text-overlay1 hover:bg-surface0 hover:text-text grid h-full w-10 place-items-center border-l"
        title="Minimize"
        aria-label="Minimize window"><MinimizeIcon class="text-sm" /></button
      ><button
        type="button"
        onclick={() => windowCommand("toggleMaximize")}
        class="border-surface0 text-overlay1 hover:bg-surface0 hover:text-text grid h-full w-10 place-items-center border-l"
        title="Maximize or restore"
        aria-label="Maximize or restore window"><MaximizeIcon class="text-xs" /></button
      ><button
        type="button"
        onclick={() => windowCommand("close")}
        class="border-surface0 text-overlay1 hover:bg-red hover:text-crust grid h-full w-10 place-items-center border-l"
        title="Close"
        aria-label="Close window"><CloseIcon class="text-base" /></button
      >{/if}
  </div>
</header>
