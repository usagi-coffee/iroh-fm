<script>
  import { untrack } from "svelte";

  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";

  import AlbumActionsModal from "$lib/modals/AlbumActionsModal.svelte";
  import PlaylistPickerModal from "$lib/modals/PlaylistPickerModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import { App } from "$lib/runes/App.svelte.js";
  import { immediateTauriWheelScroll } from "$lib/ui/immediate-wheel-scroll.js";
  import { longPress } from "$lib/ui/long-press.js";
  import { setPlaylistTracksDrag } from "$lib/ui/playlist-drag.js";
  import VirtualList from "$lib/ui/VirtualList.svelte";
  import { formatBytes, formatTime, friendlyError } from "$lib/utils.js";

  import StarIcon from "virtual:icons/ri/star-line";
  import AddIcon from "virtual:icons/ri/play-list-add-line";
  import DownIcon from "virtual:icons/ri/arrow-down-line";
  import DragIcon from "virtual:icons/ri/draggable";
  import RemoveIcon from "virtual:icons/ri/delete-bin-line";
  import UpIcon from "virtual:icons/ri/arrow-up-line";
  import PauseIcon from "virtual:icons/ri/pause-fill";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import SearchIcon from "virtual:icons/ri/search-line";

  import Cover from "./Cover.svelte";

  /**
   * @typedef {Object} Props
   * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
   * @property {ReturnType<import('$lib/runes/Library.svelte.js').Library['getTrackListItems']>} items
   * @property {string} query
   * @property {(value: string) => void} onquery
   * @property {(track: import('$lib/runes/Track.svelte.js').Track) => void} [onplay]
   * @property {import('$lib/runes/Track.svelte.js').Track[]} [queueTracks]
   * @property {import('@iroh-fm/client/types').Playlist | null} [playlist]
   */
  /** @type {Props} */
  const {
    tracks,
    items,
    query,
    onquery,
    onplay = () => {},
    queueTracks = tracks,
    playlist = null,
  } = $props();
  let draggedTrackId = "";
  let dragOverTrackId = $state("");
  /** @type {'top' | 'bottom'} */
  let dragOverEdge = $state("top");
  const ROW_HEIGHT_REM = 1.75;
  let rowHeight = $state(ROW_HEIGHT_REM * 16);
  const bufferSize = $derived(rowHeight * 24);
  /** @type {{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void } | undefined} */
  let trackList = $state();
  const initialFocusTrackId =
    App.library.pendingTrackFocusId ??
    page.state.focusTrackId ??
    untrack(() => App.player.currentTrack?.id) ??
    null;
  let initialFocusPending = Boolean(initialFocusTrackId);
  const initialFocusIndex = $derived(
    initialFocusTrackId
      ? items.findIndex((item) => item.kind === "track" && item.track.id === initialFocusTrackId)
      : -1,
  );
  const COVER_MARGIN = "150%";

  /** @param {Props['items'][number]} item */
  function trackItemKey(item) {
    return item.key;
  }

  function measureRowHeight() {
    const update = () => {
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (Number.isFinite(rootFontSize)) rowHeight = rootFontSize * ROW_HEIGHT_REM;
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
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

  function globalTrackKeybinds() {
    /** @param {KeyboardEvent} event */
    const keydown = (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableTarget(event.target)
      )
        return;

      if (event.key === "Escape") {
        if (!App.player.currentTrack) return;
        event.preventDefault();
        event.stopPropagation();
        App.library.requestTrackFocus(App.player.currentTrack);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (!App.player.currentTrack) return;
        event.preventDefault();
        event.stopPropagation();
        App.player.seekBy(event.key === "ArrowRight" ? 5 : -5);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!tracks.length) return;
        event.preventDefault();
        event.stopPropagation();
        moveSearchSelection(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        if (!tracks.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) playSearchSelection();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }

  /** @param {HTMLInputElement} input */
  function focusRequestedFilter(input) {
    if (!App.library.trackFilterFocusPending) return;
    const frame = requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      App.library.trackFilterFocusPending = false;
    });
    return () => cancelAnimationFrame(frame);
  }

  function selectFirstSearchResult() {
    if (!query.trim()) return;
    const first = tracks[0];
    if (first) App.library.requestTrackFocus(first);
    else {
      App.library.selectedTrackId = null;
      App.library.pendingTrackFocusId = null;
    }
  }

  /** @param {-1 | 1} direction */
  function moveSearchSelection(direction) {
    if (!tracks.length) return;
    const selectedIndex = tracks.findIndex((track) => track.id === App.library.selectedTrackId);
    const start = selectedIndex < 0 ? (direction > 0 ? -1 : tracks.length) : selectedIndex;
    const nextIndex = Math.max(0, Math.min(tracks.length - 1, start + direction));
    App.library.requestTrackFocus(tracks[nextIndex]);
  }

  function playSearchSelection() {
    const selected = tracks.find((track) => track.id === App.library.selectedTrackId) ?? tracks[0];
    if (selected) playTrackFromList(selected);
  }

  /**
   * @param {DragEvent} event
   * @param {import('$lib/runes/Track.svelte.js').Track} track
   */
  function startTrackDrag(event, track) {
    draggedTrackId = track.id;
    setPlaylistTracksDrag(event, [track], {
      label: track.title,
      detail: `${track.artist} · ${track.album}`,
    });
    if (playlist && event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
  }

  /** @param {DragEvent} event @param {string} trackId */
  function dragOverPlaylistTrack(event, trackId) {
    if (!draggedTrackId || !playlist || query.trim()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (draggedTrackId === trackId) {
      dragOverTrackId = "";
      return;
    }
    const row = event.currentTarget;
    if (!(row instanceof HTMLElement)) return;
    const bounds = row.getBoundingClientRect();
    dragOverTrackId = trackId;
    dragOverEdge = event.clientY < bounds.top + bounds.height / 2 ? "top" : "bottom";
  }

  /** @param {DragEvent} event @param {string} trackId */
  function leavePlaylistTrack(event, trackId) {
    const row = event.currentTarget;
    if (!(row instanceof HTMLElement)) return;
    if (
      dragOverTrackId === trackId &&
      (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget))
    )
      dragOverTrackId = "";
  }

  /** @param {DragEvent} event @param {string} trackId */
  function dropPlaylistTrack(event, trackId) {
    event.preventDefault();
    const edge = dragOverEdge;
    dragOverTrackId = "";
    if (!playlist || !draggedTrackId || query.trim()) return;
    const from = playlist.track_ids.indexOf(draggedTrackId);
    const target = playlist.track_ids.indexOf(trackId);
    if (from >= 0 && target >= 0 && from !== target) {
      const index =
        edge === "top"
          ? target - (from < target ? 1 : 0)
          : target + (from > target ? 1 : 0);
      void App.library.movePlaylistTrack(playlist, draggedTrackId, index);
    }
    draggedTrackId = "";
  }

  function endTrackDrag() {
    draggedTrackId = "";
    dragOverTrackId = "";
  }

  /** @param {import('$lib/runes/Track.svelte.js').Track} track */
  function playTrackFromList(track) {
    console.info(`[player] track-list play invoked: trackId=${track.id}`);
    onplay(track);
    let queue = queueTracks;
    if (query.trim()) {
      onquery("");
      if (playlist) App.library.requestTrackFocus(track);
      else void App.library.focusTrack(track);
    }
    void App.player.playFromTrackList(track, queue);
  }

  /** @param {import('$lib/runes/Track.svelte.js').Track[]} albumTracks */
  function playAlbumFromList(albumTracks) {
    const albumTrackIds = new Set(albumTracks.map((track) => track.id));
    const first = tracks.find((track) => albumTrackIds.has(track.id));
    if (first) onplay(first);
    void App.player.playAlbumTracks(albumTracks, tracks);
  }

  /**
   * @param {import('$lib/runes/Track.svelte.js').Track} track
   * @param {MouseEvent} [event]
   */
  function openTrackActions(track, event) {
    event?.preventDefault();
    event?.stopPropagation();
    void modal(SnippetModal, {
      snippet: TrackActions,
      track,
      playlist,
      labelledBy: "track-actions-title",
      preventContextMenu: true,
      class: "w-full max-w-md overflow-hidden border border-surface1 bg-crust p-2 shadow-float",
    }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open track actions.")),
    );
  }

  /** @param {import('$lib/runes/Track.svelte.js').Track[]} selected */
  function openPlaylistPicker(selected) {
    void modal(PlaylistPickerModal, { tracks: selected }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open playlists.")),
    );
  }

  /**
   * @param {import('@iroh-fm/client/types').Album | undefined} album
   * @param {import('$lib/runes/Track.svelte.js').Track[]} albumTracks
   * @param {string} title
   * @param {string} cacheKey
   * @param {MouseEvent} [event]
   */
  function openAlbumActions(album, albumTracks, title, cacheKey, event) {
    event?.preventDefault();
    event?.stopPropagation();
    void modal(AlbumActionsModal, { album, tracks: albumTracks, title, cacheKey }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open album actions.")),
    );
  }

  /** @param {HTMLElement} host */
  function focusRequestedTrack(host) {
    const trackId =
      App.library.pendingTrackFocusId ??
      page.state.focusTrackId ??
      (initialFocusPending ? initialFocusTrackId : null);
    if (!trackId) return;
    const index =
      trackId === initialFocusTrackId
        ? initialFocusIndex
        : items.findIndex((item) => item.kind === "track" && item.track.id === trackId);
    if (index < 0) return;
    App.library.selectedTrackId = trackId;
    let attempts = 30;
    let cancelled = false;
    let positioned = false;
    /** @type {number | undefined} */
    let frame;
    const scroll = () => {
      if (cancelled || attempts-- <= 0) return;
      if (!trackList) {
        frame = requestAnimationFrame(scroll);
        return;
      }
      trackList.scrollToIndex(index, { align: "center" });
      if (!positioned) {
        positioned = true;
        frame = requestAnimationFrame(scroll);
        return;
      }
      const target = host.querySelector(`[data-track-id="${CSS.escape(trackId)}"]`);
      if (target instanceof HTMLElement) {
        initialFocusPending = false;
        App.library.pendingTrackFocusId = null;
        if (page.state.focusTrackId) replaceState(page.url, {});
        return;
      }
      positioned = false;
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }
</script>

<section
  {@attach measureRowHeight}
  {@attach globalTrackKeybinds}
  class="bg-base flex h-full min-h-0 w-full flex-col"
>
  <div class="border-surface0 bg-mantle flex h-10 shrink-0 items-center gap-3 border-b px-3">
    <SearchIcon class="text-sm" />
    <input
      {@attach focusRequestedFilter}
      {@attach selectFirstSearchResult}
      bind:value={() => query, onquery}
      onkeydown={(event) => {
        if (event.key === "Escape") {
          onquery("");
          event.currentTarget.blur();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveSearchSelection(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          playSearchSelection();
        }
      }}
      placeholder="Filter artist, title, album…"
      class="text-text placeholder:text-overlay0 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
    />
    <span class="text-3xs text-overlay0 shrink-0 font-mono"
      >{tracks.length} / {App.library.summary.track_count}</span
    >
  </div>

  <div
    class="border-surface0 bg-mantle text-4xs text-overlay0 tablet-xl:grid hidden h-7 shrink-0 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b px-2 font-mono tracking-wider uppercase"
  >
    <span>#</span><span>Album</span><span>Title</span><span>Artist</span><span class="text-right"
      >Time</span
    >
  </div>

  <div class="min-h-0 flex-1" {@attach immediateTauriWheelScroll} {@attach focusRequestedTrack}>
    <VirtualList
      bind:api={() => trackList, (value) => (trackList = value)}
      {items}
      getKey={trackItemKey}
      estimateSize={rowHeight}
      measureItems={false}
      overscan={bufferSize}
      initialIndex={initialFocusIndex >= 0 ? initialFocusIndex : null}
    >
      {#snippet children(item, itemIndex)}
        {#if item}
          {#if item.kind === "album"}
            <button
              data-list-index={itemIndex}
              draggable="true"
              ondragstart={(event) =>
                setPlaylistTracksDrag(event, item.tracks, {
                  label: item.title,
                  detail: `${item.tracks.length} ${item.tracks.length === 1 ? "track" : "tracks"} · ${item.artist}`,
                })}
              {@attach longPress(() =>
                openAlbumActions(item.album, item.tracks, item.title, item.album?.id ?? item.key),
              )}
              type="button"
              onclick={() => playAlbumFromList(item.tracks)}
              oncontextmenu={(event) =>
                openAlbumActions(
                  item.album,
                  item.tracks,
                  item.title,
                  item.album?.id ?? item.key,
                  event,
                )}
              class="border-surface1 bg-mantle hover:bg-surface0 flex h-7 w-full select-none items-center gap-2 border-y px-2 text-left transition"
              aria-label={`Play album ${item.title}`}
            >
              <Cover
                client={App.connection.client}
                id={item.coverArtId}
                title={item.title}
                rootMargin={COVER_MARGIN}
                class="size-5 shrink-0 rounded-sm"
              />
              <p class="text-track min-w-0 flex-1 truncate">
                <span class="text-mauve font-semibold">{item.title}</span><span
                  class="text-3xs text-overlay1 ml-2">{item.artist}</span
                >
              </p>
              <span class="text-3xs text-overlay0 shrink-0 font-mono"
                >{formatTime(item.durationSeconds)}</span
              >
            </button>
          {:else}
            {const playing = $derived(App.player.currentTrack?.id === item.track.id)}
            {const selected = $derived(App.library.selectedTrackId === item.track.id)}
            {const downloading = $derived(
              item.track.downloading && !item.track.cached && !item.track.memoryCached,
            )}
            {const trackNumber = $derived(item.track.track_number || item.trackIndex + 1)}
            <div
              data-list-index={itemIndex}
              data-track-id={item.track.id}
              {@attach longPress(() => openTrackActions(item.track))}
              role="row"
              tabindex="0"
              aria-selected={selected}
              onclick={() => (App.library.selectedTrackId = item.track.id)}
              ondblclick={() => playTrackFromList(item.track)}
              oncontextmenu={(event) => openTrackActions(item.track, event)}
              draggable="true"
              ondragstart={(event) => startTrackDrag(event, item.track)}
              ondragover={(event) => dragOverPlaylistTrack(event, item.track.id)}
              ondragleave={(event) => leavePlaylistTrack(event, item.track.id)}
              ondrop={(event) => dropPlaylistTrack(event, item.track.id)}
              ondragend={endTrackDrag}
              onkeydown={(event) => {
                if (event.key === "Enter") playTrackFromList(item.track);
                else if (event.key === " ") {
                  event.preventDefault();
                  App.library.selectedTrackId = item.track.id;
                }
              }}
              class="group border-surface0/35 text-track focus:ring-mauve tablet-xl:grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] relative grid h-7 select-none grid-cols-[2rem_minmax(0,1fr)_3.2rem] items-center border-b px-2 transition outline-none focus:ring-1 focus:ring-inset {playing
                ? 'bg-mauve/15'
                : selected
                  ? 'bg-surface0'
                  : 'hover:bg-surface0/60'}"
            >
              {#if dragOverTrackId === item.track.id}<span
                  data-playlist-drop-edge={dragOverEdge}
                  aria-hidden="true"
                  class="bg-teal pointer-events-none absolute inset-x-0 z-10 h-0.5 {dragOverEdge ===
                  'top'
                    ? 'top-0'
                    : 'bottom-0'}"
                ></span>{/if}
              <button
                type="button"
                onclick={(event) => {
                  event.stopPropagation();
                  playTrackFromList(item.track);
                }}
                class="text-3xs text-overlay0 hover:text-mauve grid size-6 place-items-center font-mono"
                aria-label={`Play ${item.track.title}`}
              >
                {#if playing && App.player.playing}
                  <PauseIcon class="text-mauve text-2xs" />
                {:else if downloading}
                  <span class="bg-surface1 h-1 w-4 overflow-hidden"
                    ><span
                      class="bg-mauve block h-full transition-[width] duration-150"
                      style={`width:${item.track.progress * 100}%`}
                    ></span></span
                  >
                {:else if item.track.cached}
                  <span class="text-green" title="Cached">{trackNumber}</span>
                {:else if item.track.memoryCached}
                  <span class="text-peach" title="In memory cache">{trackNumber}</span>
                {:else}
                  <span class="group-hover:hidden">{trackNumber}</span><span
                    class="hidden group-hover:block"><PlayIcon class="text-3xs" /></span
                  >
                {/if}
              </button>
              <div class="text-mauve tablet-xl:block hidden min-w-0 truncate pr-2">
                {item.track.album}
              </div>
              <div class="flex min-w-0 items-center gap-2 pr-2">
                  {#if playlist && !query.trim()}<button
                      type="button"
                      draggable="true"
                      onclick={(event) => event.stopPropagation()}
                      ondragstart={(event) => {
                        event.stopPropagation();
                        startTrackDrag(event, item.track);
                      }}
                      ondragend={endTrackDrag}
                      class="text-overlay0 hover:text-teal shrink-0 cursor-grab bg-transparent p-0 active:cursor-grabbing"
                      title={`Drag ${item.track.title} to reorder`}
                      aria-label={`Drag ${item.track.title} to reorder`}
                      data-playlist-drag-handle><DragIcon /></button
                    >{/if}<span class="text-teal truncate">{item.track.title}</span><button
                  type="button"
                  onclick={(event) => App.library.toggleStar(item.track, event)}
                  class="text-overlay0 hover:text-pink ml-auto hidden shrink-0 group-hover:block {App.library.starredTrackIds.has(
                    item.track.id,
                  )
                    ? 'text-pink !block'
                    : ''}"
                  aria-label={App.library.starredTrackIds.has(item.track.id)
                    ? "Unstar track"
                    : "Star track"}><StarIcon class="text-2xs" /></button
                ><span class="text-4xs text-overlay0 tablet-xl:hidden truncate">
                  · {item.track.artist}</span
                >
              </div>
              <div class="text-subtext0 tablet-xl:block hidden min-w-0 truncate pr-2">
                {item.track.artist}
              </div>
              <div class="text-3xs text-overlay0 text-right font-mono">
                {formatTime(item.track.duration_seconds)}
              </div>
            </div>
          {/if}
        {/if}
      {/snippet}
    </VirtualList>
  </div>
</section>

{#snippet TrackActions(
  /** @type {{ dismiss: (result?: unknown) => void, track: import('$lib/runes/Track.svelte.js').Track }} */ {
    dismiss,
    track,
  },
)}
  <div class="border-surface0 grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-4 border-b p-3">
    <Cover
      client={App.connection.client}
      id={track.cover_art_id}
      title={track.album}
      class="size-24 shrink-0 rounded-sm"
    />
    <div class="min-w-0 self-center overflow-hidden">
      <p
        id="track-actions-title"
        class="text-text block max-w-full overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap"
        title={track.title}
      >
        {track.title}
      </p>
      <p class="text-mauve mt-1 truncate text-xs">{track.artist}</p>
      <p class="text-2xs text-overlay1 mt-1 truncate">{track.album}</p>
      <p class="text-3xs text-overlay0 mt-2 font-mono">
        {formatTime(track.duration_seconds)} · {formatBytes(track.file_size)}
      </p>
    </div>
  </div>
  <button
    type="button"
    onclick={() => {
      dismiss();
      void App.library.toggleStar(track);
    }}
    class="text-subtext0 hover:bg-surface0 hover:text-text flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
    ><StarIcon class="text-sm" />{App.library.starredTrackIds.has(track.id)
      ? "Unstar"
      : "Star"}</button
  >
  <button
    type="button"
    onclick={() => {
      dismiss();
      openPlaylistPicker([track]);
    }}
    class="text-subtext0 hover:bg-surface0 hover:text-text flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
    ><AddIcon class="text-sm" />Add to playlist</button
  >
  {#if playlist}
    {const index = $derived(playlist.track_ids.indexOf(track.id))}
    <div class="border-surface0 grid grid-cols-2 border-t">
      <button
        type="button"
        disabled={index <= 0}
        onclick={() => {
          dismiss();
          void App.library.movePlaylistTrack(playlist, track.id, 0);
        }}
        class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
        ><UpIcon />Move to top</button
      >
      <button
        type="button"
        disabled={index <= 0}
        onclick={() => {
          dismiss();
          void App.library.movePlaylistTrack(playlist, track.id, index - 1);
        }}
        class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
        ><UpIcon />Move up</button
      >
      <button
        type="button"
        disabled={index < 0 || index >= playlist.track_ids.length - 1}
        onclick={() => {
          dismiss();
          void App.library.movePlaylistTrack(playlist, track.id, index + 1);
        }}
        class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
        ><DownIcon />Move down</button
      >
      <button
        type="button"
        disabled={index < 0 || index >= playlist.track_ids.length - 1}
        onclick={() => {
          dismiss();
          void App.library.movePlaylistTrack(playlist, track.id, playlist.track_ids.length - 1);
        }}
        class="text-subtext0 hover:bg-surface0 disabled:text-overlay0 flex items-center gap-2 px-3 py-3 text-xs"
        ><DownIcon />Move to bottom</button
      >
    </div>
    <button
      type="button"
      onclick={() => {
        dismiss();
        void App.library.removePlaylistTrack(playlist, track.id);
      }}
      class="text-red hover:bg-surface0 flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
      ><RemoveIcon class="text-sm" />Remove from playlist</button
    >
  {/if}
{/snippet}
