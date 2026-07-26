<script>
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import ConfirmModal from "$lib/modals/ConfirmModal.svelte";
  import PlaylistNameModal from "$lib/modals/PlaylistNameModal.svelte";
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { longPress } from "$lib/ui/long-press.js";
  import {
    hasPlaylistTracksDrag,
    readPlaylistTrackIds,
  } from "$lib/ui/playlist-drag.js";
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
  import AddIcon from "virtual:icons/ri/add-line";
  import CachedIcon from "virtual:icons/ri/check-line";
  import DeleteIcon from "virtual:icons/ri/delete-bin-line";
  import DownloadIcon from "virtual:icons/ri/download-line";
  import EditIcon from "virtual:icons/ri/edit-line";
  import LeftIcon from "virtual:icons/ri/arrow-left-line";
  import RightIcon from "virtual:icons/ri/arrow-right-line";
  import StarIcon from "virtual:icons/ri/star-line";

  /** @typedef {{ updateReady: boolean, onupdate: () => void }} Props */
  /** @type {Props} */
  const { updateReady, onupdate } = $props();
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  let dropPlaylistId = $state("");
  let creatingPlaylist = $state(false);

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

  async function createPlaylist() {
    if (creatingPlaylist) return;
    creatingPlaylist = true;
    const playlist = await App.library.createDefaultPlaylist();
    creatingPlaylist = false;
    if (playlist) await goto(resolve(`/playlists/${playlist.id}`));
  }

  /** @param {import('@iroh-fm/client/types').Playlist} playlist @param {MouseEvent} [event] */
  function openPlaylistActions(playlist, event) {
    event?.preventDefault();
    void modal(SnippetModal, {
      snippet: PlaylistActions,
      playlist,
      labelledBy: "playlist-tab-actions-title",
      class: "border-surface1 bg-crust shadow-float w-full max-w-xs border p-2",
    });
  }

  /** @param {string} activePath */
  function playlistNav(activePath) {
    return (/** @type {HTMLElement} */ element) => {
      const active = element.querySelector(`[href="${CSS.escape(activePath)}"]`);
      if (active instanceof HTMLElement)
        requestAnimationFrame(() => active.scrollIntoView({ block: "nearest", inline: "nearest" }));
      const wheel = (/** @type {WheelEvent} */ event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      };
      const dragover = (/** @type {DragEvent} */ event) => {
        if (!hasPlaylistTracksDrag(event.dataTransfer)) return;
        const bounds = element.getBoundingClientRect();
        const edge = Math.min(48, bounds.width / 4);
        if (event.clientX < bounds.left + edge) element.scrollLeft -= 16;
        else if (event.clientX > bounds.right - edge) element.scrollLeft += 16;
      };
      element.addEventListener("wheel", wheel, { passive: false });
      element.addEventListener("dragover", dragover);
      return () => {
        element.removeEventListener("wheel", wheel);
        element.removeEventListener("dragover", dragover);
      };
    };
  }

  /** @param {import('@iroh-fm/client/types').Playlist} playlist @param {DragEvent} event */
  function dragOverPlaylist(playlist, event) {
    const transfer = event.dataTransfer;
    if (
      hasPlaylistTracksDrag(transfer) ||
      Boolean(transfer && [...transfer.types].includes("text/iroh-playlist-id"))
    ) {
      event.preventDefault();
      if (transfer) transfer.dropEffect = hasPlaylistTracksDrag(transfer) ? "copy" : "move";
      dropPlaylistId = playlist.id;
    }
  }

  /** @param {import('@iroh-fm/client/types').Playlist} playlist @param {DragEvent} event */
  function dropOnPlaylist(playlist, event) {
    event.preventDefault();
    dropPlaylistId = "";
    const trackIds = readPlaylistTrackIds(event.dataTransfer);
    if (trackIds.length) {
      const tracks = trackIds
        .map((id) => App.library.tracksById.get(id))
        .filter((track) => track !== undefined);
      if (tracks.length) void App.library.addTracksToPlaylist(playlist, tracks);
      return;
    }
    const id = event.dataTransfer?.getData("text/iroh-playlist-id");
    const from = App.library.playlists.find((item) => item.id === id);
    if (from) void App.library.movePlaylist(from, App.library.playlists.indexOf(playlist));
  }

  /**
   * @param {import('@iroh-fm/client/types').Playlist} playlist
   * @param {() => void} dismiss
   */
  async function renamePlaylist(playlist, dismiss) {
    dismiss();
    const name = await modal(PlaylistNameModal, {
      title: "Rename playlist",
      initialName: playlist.name,
    });
    if (name && name !== playlist.name) await App.library.updatePlaylist(playlist, { name });
  }

  /**
   * @param {import('@iroh-fm/client/types').Playlist} playlist
   * @param {() => void} dismiss
   */
  async function deletePlaylist(playlist, dismiss) {
    dismiss();
    const confirmed = await modal(ConfirmModal, {
      title: `Delete “${playlist.name}”?`,
      message: "The playlist will be permanently removed. Your music files are not affected.",
      confirmLabel: "DELETE",
      cancelLabel: "CANCEL",
      eyebrow: "Playlist",
      danger: true,
    });
    if (!confirmed || !(await App.library.deletePlaylist(playlist))) return;
    if (page.url.pathname.endsWith(`/playlists/${playlist.id}`)) await goto(resolve("/tracks"));
  }

  /**
   * @param {import('@iroh-fm/client/types').Playlist} playlist
   * @param {import('$lib/runes/Track.svelte.js').Track[]} tracks
   * @param {() => void} dismiss
   */
  function cachePlaylist(playlist, tracks, dismiss) {
    dismiss();
    void App.library.cachePlaylist(tracks, playlist.id);
  }
</script>

<header
  data-tauri-drag-region={desktop ? "" : undefined}
  class="border-surface0 bg-crust text-2xs flex h-9 min-w-0 items-center border-b"
>
  {const path = $derived(page.url.pathname.replace(/\/$/, ""))}
  {const connectionToggleTitle = $derived(
    App.library.offlineOnly
      ? "Offline-only mode enabled — use network"
      : App.connection.info.path_type === "relay"
        ? "Connected via relay — use cached music only"
        : App.connection.info.path_type === "direct"
          ? "Connected directly — use cached music only"
          : "Connecting — use cached music only",
  )}
  <nav
    {@attach playlistNav(path)}
    class="scrollbar-none flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain"
    aria-label="Library"
  >
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
      class="border-surface0 hover:bg-surface0 grid w-9 shrink-0 place-items-center border-r font-semibold transition {path.endsWith(
        '/starred',
      )
        ? 'bg-surface0 text-pink'
        : 'text-overlay1'}"
      title="Starred"
      aria-label="Starred"><StarIcon class="text-sm" /></a
    >
    {#each App.library.playlists as playlist (playlist.id)}
      <a
        href={resolve(`/playlists/${playlist.id}`)}
        {@attach longPress(() => openPlaylistActions(playlist))}
        draggable="true"
        oncontextmenu={(event) => openPlaylistActions(playlist, event)}
        ondragstart={(event) => {
          event.dataTransfer?.setData("text/iroh-playlist-id", playlist.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        }}
        ondragover={(event) => dragOverPlaylist(playlist, event)}
        ondragleave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            dropPlaylistId = "";
        }}
        ondrop={(event) => dropOnPlaylist(playlist, event)}
        ondragend={() => (dropPlaylistId = "")}
        class="border-surface0 hover:bg-surface0 grid max-w-40 shrink-0 place-items-center border-r px-3 font-semibold whitespace-nowrap transition {path.endsWith(
          `/playlists/${playlist.id}`,
        )
          ? 'bg-surface0 text-teal'
          : dropPlaylistId === playlist.id
            ? 'bg-teal/20 text-teal ring-1 ring-inset ring-teal'
          : 'text-overlay1'}"
        title={`${playlist.name} — right-click for ordering actions`}
        ><span class="max-w-32 truncate">{playlist.name}</span></a
      >
    {/each}
    <button
      type="button"
      onclick={createPlaylist}
      disabled={creatingPlaylist}
      class="border-surface0 text-overlay1 hover:bg-surface0 hover:text-mauve grid w-9 shrink-0 place-items-center border-r"
      title="Create playlist"
      aria-label="Create playlist"><AddIcon class="text-sm" /></button
    >
  </nav>
  <div
    data-tauri-drag-region={desktop ? "" : undefined}
    ondblclick={() => desktop && windowCommand("toggleMaximize")}
    role="presentation"
    class="h-full min-w-2 shrink-0"
  ></div>
  <div class="flex h-full min-w-0 items-center">
    <div
      class="border-surface0 text-4xs text-overlay1 tablet-xl:flex hidden h-full min-w-36 items-center gap-2 border-l px-2 font-mono"
      title={`${App.connection.info.path_type}: ${App.connection.info.address || "selecting path"} · ${formatBytes(App.connection.receivedBytesPerSecond)}/s · ${formatBytes(App.connection.info.received_bytes)} received`}
    >
      <span class="flex min-w-0 flex-1 flex-col items-end text-right leading-tight"
        ><span class="text-subtext0 text-5xs desktop:max-w-44 flex max-w-28 items-center gap-1"
          ><span class="truncate">{connectionAddressLabel(App.connection.info)}</span><span
            class="size-1.5 shrink-0 rounded-full {App.connection.info.address
              ? 'bg-green'
              : 'bg-yellow animate-pulse'}"
          ></span></span
        ><span class="text-overlay0 text-5xs flex items-center gap-2 whitespace-nowrap"
          ><span class="flex items-center gap-1"
            ><DatabaseIcon class="text-4xs" />{formatBytes(
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

{#snippet PlaylistActions(
  /** @type {{ dismiss: () => void, playlist: import('@iroh-fm/client/types').Playlist }} */ {
    dismiss,
    playlist,
  },
)}
  {const index = $derived(App.library.playlists.findIndex((item) => item.id === playlist.id))}
  {const playlistTracks = $derived(
    /** @type {import('$lib/runes/Track.svelte.js').Track[]} */ (
      playlist.track_ids.map((id) => App.library.tracksById.get(id)).filter(Boolean)
    ),
  )}
  {const cached = $derived(
    playlistTracks.length > 0 && playlistTracks.every((track) => track.cached),
  )}
  {const caching = $derived(App.library.cachingAlbumIds.has(`playlist:${playlist.id}`))}
  <p id="playlist-tab-actions-title" class="text-text truncate px-3 py-3 text-sm font-semibold">
    {playlist.name}
  </p>
  <div class="grid grid-cols-2">
    <button
      type="button"
      disabled={index <= 0}
      onclick={() => {
        dismiss();
        void App.library.movePlaylist(playlist, index - 1);
      }}
      class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
      ><LeftIcon />Left</button
    >
    <button
      type="button"
      disabled={index < 0 || index >= App.library.playlists.length - 1}
      onclick={() => {
        dismiss();
        void App.library.movePlaylist(playlist, index + 1);
      }}
      class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
      ><RightIcon />Right</button
    >
  </div>
  <div class="border-surface0 border-t pt-1">
    <button
      type="button"
      disabled={App.library.offlineOnly || cached || caching || playlistTracks.length === 0}
      onclick={() => cachePlaylist(playlist, playlistTracks, dismiss)}
      class="text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 flex w-full items-center gap-2 px-3 py-3 text-xs {cached
        ? '!text-green'
        : ''}"
      >{#if cached}<CachedIcon />Playlist cached{:else}<DownloadIcon />{caching
          ? "Caching playlist…"
          : App.library.offlineOnly
            ? "Unavailable offline"
            : "Cache playlist"}{/if}</button
    >
    <button
      type="button"
      onclick={() => {
        void renamePlaylist(playlist, dismiss);
      }}
      class="text-subtext0 hover:bg-surface0 hover:text-text flex w-full items-center gap-2 px-3 py-3 text-xs"
      ><EditIcon />Rename</button
    >
    <button
      type="button"
      onclick={() => {
        void deletePlaylist(playlist, dismiss);
      }}
      class="text-red hover:bg-surface0 flex w-full items-center gap-2 px-3 py-3 text-xs"
      ><DeleteIcon />Delete</button
    >
  </div>
{/snippet}
