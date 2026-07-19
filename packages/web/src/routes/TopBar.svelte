<script>
  import { goto } from "$app/navigation";
  import { asset, resolve } from "$app/paths";
  import { page } from "$app/state";

  import ConfirmModal from "$lib/modals/ConfirmModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { connectionAddressLabel, formatBytes, friendlyError } from "$lib/utils.js";

  import DisconnectIcon from "virtual:icons/ri/logout-box-r-line";
  import RefreshIcon from "virtual:icons/ri/refresh-line";
  import SettingsIcon from "virtual:icons/ri/settings-3-line";
  import OfflineIcon from "virtual:icons/ri/wifi-off-line";

  /** @typedef {{ updateReady: boolean, onupdate: () => void }} Props */
  /** @type {Props} */
  let { updateReady, onupdate } = $props();
  let path = $derived(page.url.pathname.replace(/\/$/, ""));

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

<header class="border-surface0 bg-crust text-2xs flex h-9 min-w-0 items-center border-b">
  <a
    href={resolve("/tracks")}
    class="border-surface0 grid h-full w-10 shrink-0 place-items-center border-r"
    ><img src={asset("/pwa-icon-192.png")} alt="iroh.fm" class="size-6" /></a
  >
  <nav class="flex h-full min-w-0 items-stretch">
    <a
      href={resolve("/tracks")}
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
  <div class="ml-auto flex h-full min-w-0 items-center">
    <div
      class="border-surface0 text-4xs text-overlay1 desktop:flex hidden h-full min-w-0 items-center gap-2 border-l px-3 font-mono"
      title={`${App.connection.info.path_type}: ${App.connection.info.address || "selecting path"} · ${formatBytes(App.connection.info.received_bytes)} received`}
    >
      <span
        class="size-1.5 shrink-0 rounded-full {App.connection.info.address
          ? 'bg-green'
          : 'bg-yellow animate-pulse'}"
      ></span><span class="text-subtext0 max-w-44 truncate"
        >{connectionAddressLabel(App.connection.info)}</span
      ><span class="text-overlay0 shrink-0"
        >↓ {formatBytes(App.connection.info.received_bytes)}</span
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
      title={App.library.offlineOnly ? "Offline-only mode enabled" : "Use cached music only"}
      aria-pressed={App.library.offlineOnly}><OfflineIcon class="text-sm" /></button
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
  </div>
</header>
