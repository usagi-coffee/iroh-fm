<script>
  import { untrack } from "svelte";

  import AlbumActionsModal from "$lib/modals/AlbumActionsModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { immediateTauriWheelScroll } from "$lib/ui/immediate-wheel-scroll.js";
  import { longPress } from "$lib/ui/long-press.js";
  import { setPlaylistTracksDrag } from "$lib/ui/playlist-drag.js";
  import VirtualList from "$lib/ui/VirtualList.svelte";
  import { friendlyError } from "$lib/utils.js";

  import AddIcon from "virtual:icons/ri/add-line";
  import CachedIcon from "virtual:icons/ri/check-line";
  import DownloadIcon from "virtual:icons/ri/download-line";
  import StarIcon from "virtual:icons/ri/star-line";
  import GridIcon from "virtual:icons/ri/layout-grid-line";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import SubtractIcon from "virtual:icons/ri/subtract-line";

  import Cover from "../../Cover.svelte";

  /**
   * @typedef {Object} Props
   * @property {import('@iroh-fm/client/types').Album[]} albums
   * @property {boolean} [followPlayingTrack]
   * @property {string | null} [focusTrackId]
   * @property {number} [focusRequest]
   * @property {number} [initialWidth]
   */
  /** @type {Props} */
  const {
    albums,
    followPlayingTrack = false,
    focusTrackId = null,
    focusRequest = 0,
    initialWidth = 0,
  } = $props();
  const ALBUM_MIN_WIDTH_REM = 7.8125;
  const ALBUM_ACTIONS_MIN_WIDTH_REM = 7;
  const ALBUM_GAP_REM = 0.75;
  const ALBUM_HORIZONTAL_PADDING_REM = 1.5;
  const MAX_COLUMNS = 16;
  const COLUMN_ADJUSTMENT_KEY = "iroh-fm-album-column-adjustment";
  const storedColumnAdjustment = Number.parseInt(
    localStorage.getItem(COLUMN_ADJUSTMENT_KEY) ?? "",
    10,
  );
  let gridWidth = $state(untrack(() => initialWidth));
  let rootFontSize = $state(
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
  );
  let columnAdjustment = $state(
    Number.isFinite(storedColumnAdjustment)
      ? Math.max(-MAX_COLUMNS, Math.min(MAX_COLUMNS, storedColumnAdjustment))
      : 0,
  );
  /** @type {{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void } | undefined} */
  let albumList = $state();
  const initialPlayingTrackId = untrack(() =>
    followPlayingTrack ? App.player.currentTrack?.id : null,
  );
  const initialPlayingAlbumId = initialPlayingTrackId
    ? (App.library.albumByTrackId.get(initialPlayingTrackId)?.id ?? null)
    : null;
  const gap = $derived(ALBUM_GAP_REM * rootFontSize);
  const availableWidth = $derived(
    Math.max(0, gridWidth - ALBUM_HORIZONTAL_PADDING_REM * rootFontSize),
  );
  const albumMinWidth = $derived(ALBUM_MIN_WIDTH_REM * rootFontSize);
  const actionMinWidth = $derived(ALBUM_ACTIONS_MIN_WIDTH_REM * rootFontSize);
  const autoColumns = $derived(
    Math.max(1, Math.floor((availableWidth + gap) / (albumMinWidth + gap))),
  );
  const maxColumns = $derived(
    Math.max(1, Math.min(MAX_COLUMNS, Math.floor((availableWidth + gap) / (actionMinWidth + gap)))),
  );
  const columns = $derived(Math.max(1, Math.min(maxColumns, autoColumns + columnAdjustment)));
  const bufferSize = $derived(25 * rootFontSize);
  const rows = $derived.by(() => {
    /** @type {import('@iroh-fm/client/types').Album[][]} */
    const grouped = [];
    for (let index = 0; index < albums.length; index += columns)
      grouped.push(albums.slice(index, index + columns));
    return grouped;
  });
  const coverWidth = $derived((availableWidth - Math.max(0, columns - 1) * gap) / columns);
  const rowHeight = $derived(Math.max(rootFontSize * 8, coverWidth + rootFontSize * 4.25));
  const playingTrackId = $derived(App.player.currentTrack?.id ?? null);
  const playingAlbumId = $derived(
    playingTrackId ? (App.library.albumByTrackId.get(playingTrackId)?.id ?? null) : null,
  );
  const requestedAlbumId = $derived(
    focusTrackId ? (App.library.albumByTrackId.get(focusTrackId)?.id ?? null) : null,
  );
  const requestedRowIndex = $derived(
    requestedAlbumId
      ? rows.findIndex((row) => row.some((album) => album.id === requestedAlbumId))
      : -1,
  );
  const initialPlayingRowIndex = $derived(
    initialPlayingAlbumId
      ? rows.findIndex((row) => row.some((album) => album.id === initialPlayingAlbumId))
      : -1,
  );
  let focusedAlbumPosition = "";

  /** @param {import('@iroh-fm/client/types').Album[]} row */
  function albumRowKey(row) {
    return `${columns}:${row[0]?.id ?? "empty"}`;
  }

  /** @param {HTMLElement} node */
  function measureColumns(node) {
    let pendingWidth = 0;
    /** @type {number | undefined} */
    let frame;
    /** @param {number} width */
    const update = (width) => {
      if (width <= 0) return;
      const measuredFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      if (!Number.isFinite(measuredFontSize)) return;
      if (gridWidth !== width) gridWidth = width;
      if (rootFontSize !== measuredFontSize) rootFontSize = measuredFontSize;
    };
    update(node.clientWidth);
    const observer = new ResizeObserver((entries) => {
      pendingWidth = entries[0]?.contentRect.width ?? 0;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update(pendingWidth);
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }

  /** @param {HTMLElement} host */
  function focusRequestedAlbum(host) {
    if (!requestedAlbumId) {
      focusedAlbumPosition = "";
      return;
    }
    const rowIndex = requestedRowIndex;
    if (rowIndex < 0) return;
    const position = `${focusRequest}:${requestedAlbumId}:${columns}:${rowIndex}`;
    if (position === focusedAlbumPosition) return;
    focusedAlbumPosition = position;
    let attempts = 60;
    let cancelled = false;
    let positioned = false;
    /** @type {number | undefined} */
    let frame;
    const center = () => {
      if (cancelled || attempts-- <= 0) return;
      if (!albumList) {
        frame = requestAnimationFrame(center);
        return;
      }
      albumList.scrollToIndex(rowIndex, { align: "center" });
      if (!positioned) {
        positioned = true;
        frame = requestAnimationFrame(center);
        return;
      }
      const target = host.querySelector(`[data-album-id="${CSS.escape(requestedAlbumId)}"]`);
      if (target instanceof HTMLElement) return;
      positioned = false;
      frame = requestAnimationFrame(center);
    };
    frame = requestAnimationFrame(center);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }

  /** @param {-1 | 1} direction */
  function changeColumns(direction) {
    const nextColumns = Math.max(1, Math.min(maxColumns, columns + direction));
    columnAdjustment = nextColumns - autoColumns;
    localStorage.setItem(COLUMN_ADJUSTMENT_KEY, String(columnAdjustment));
  }

  /**
   * @param {import('@iroh-fm/client/types').Album} album
   * @param {MouseEvent} [event]
   */
  function openActions(album, event) {
    event?.preventDefault();
    event?.stopPropagation();
    void modal(AlbumActionsModal, {
      album,
      tracks: App.library.tracksForAlbum(album),
      title: album.title,
      cacheKey: album.id,
    }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open album actions.")),
    );
  }

  /**
   * @param {import('@iroh-fm/client/types').Album} album
   * @param {MouseEvent} event
   */
  function cacheAlbum(album, event) {
    event.stopPropagation();
    void App.library.cacheAlbum(App.library.tracksForAlbum(album), album.id);
  }

  /**
   * @param {import('@iroh-fm/client/types').Album} album
   * @param {MouseEvent} event
   */
  function starAlbum(album, event) {
    event.stopPropagation();
    void App.library.toggleStarAlbum(album);
  }
</script>

<section class="bg-mantle flex h-full min-h-0 w-full flex-col">
  <div class="border-surface0 flex h-10 shrink-0 items-center border-b px-3">
    <strong class="text-xs">ALBUMS</strong>
    <span class="text-3xs text-overlay0 ml-2 font-mono"
      >{albums.length}{#if App.library.offlineOnly}
        / {App.library.albums.length}{/if}</span
    >
    <div class="text-overlay1 ml-auto flex items-center">
      <button
        type="button"
        onclick={() => changeColumns(-1)}
        disabled={columns <= 1}
        class="hover:bg-surface0 hover:text-mauve grid size-7 place-items-center disabled:cursor-default disabled:opacity-25"
        title="Fewer columns, larger covers"
        aria-label="Show fewer album columns with larger covers"
        ><SubtractIcon class="text-sm" /></button
      >
      <span
        class="text-3xs text-overlay0 flex h-7 min-w-9 items-center justify-center gap-1 font-mono"
        title={`${columns} album columns`}><GridIcon class="text-xs" />{columns}</span
      >
      <button
        type="button"
        onclick={() => changeColumns(1)}
        disabled={columns >= maxColumns}
        class="hover:bg-surface0 hover:text-mauve grid size-7 place-items-center disabled:cursor-default disabled:opacity-25"
        title="More columns, smaller covers"
        aria-label="Show more album columns with smaller covers"><AddIcon class="text-sm" /></button
      >
    </div>
  </div>
  <div
    {@attach measureColumns}
    {@attach immediateTauriWheelScroll}
    {@attach focusRequestedAlbum}
    class="min-h-0 flex-1"
  >
    <VirtualList
      bind:api={() => albumList, (value) => (albumList = value)}
      items={rows}
      getKey={albumRowKey}
      estimateSize={rowHeight}
      measureItems="uniform"
      overscan={bufferSize}
      overscroll={false}
      paddingStart={gap}
      paddingEnd={gap}
      initialIndex={followPlayingTrack && initialPlayingRowIndex >= 0
        ? initialPlayingRowIndex
        : null}
    >
      {#snippet children(row)}
        <div
          class="grid gap-3 px-3 pb-5"
          style={`grid-template-columns:repeat(${columns},minmax(0,1fr))`}
        >
          {#each row as album (album.id)}
            {const starred = $derived(App.library.starredAlbumIds.has(album.id))}
            {const cached = $derived(App.library.isAlbumFullyCached(album))}
            {const caching = $derived(App.library.cachingAlbumIds.has(album.id))}
            <article
              data-album-id={album.id}
              draggable="true"
              ondragstart={(event) =>
                setPlaylistTracksDrag(event, App.library.tracksForAlbum(album), {
                  label: album.title,
                  detail: `${album.track_ids.length} ${album.track_ids.length === 1 ? "track" : "tracks"} · ${album.album_artist ?? album.artist}`,
                })}
              {@attach longPress(() => openActions(album))}
              oncontextmenu={(event) => openActions(album, event)}
              class="group min-w-0 select-none"
            >
              <div
                class="bg-base relative border-4 transition {playingAlbumId === album.id
                  ? 'border-mauve'
                  : 'hover:border-surface2 border-transparent'}"
              >
                <button
                  type="button"
                  onclick={() => App.library.activateAlbum(album)}
                  ondblclick={() => App.player.playAlbum(album)}
                  class="block w-full"
                  ><Cover
                    client={App.connection.client}
                    id={album.cover_art_id}
                    title={album.title}
                    class="w-full"
                  /></button
                >
                <div class="absolute bottom-2 left-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onclick={(event) => starAlbum(album, event)}
                    class="bg-crust/85 hover:bg-crust hover:text-pink grid size-7 place-items-center rounded-full shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 {starred
                      ? 'text-pink pointer-events-auto translate-y-0 opacity-100'
                      : 'text-subtext0 pointer-events-none translate-y-1 opacity-0'}"
                    title={starred ? "Unstar album" : "Star album"}
                    ><StarIcon class="text-xs" /></button
                  >
                  <button
                    type="button"
                    onclick={(event) => cacheAlbum(album, event)}
                    disabled={App.library.offlineOnly || cached || caching}
                    class="bg-crust/85 text-subtext0 hover:bg-crust hover:text-mauve pointer-events-none grid size-7 translate-y-1 place-items-center rounded-full opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 disabled:cursor-default {cached
                      ? '!text-green'
                      : ''} {caching ? 'text-mauve animate-pulse' : ''}"
                    title={cached
                      ? "Album cached"
                      : caching
                        ? "Downloading album"
                        : "Download album"}
                    >{#if cached}<CachedIcon class="text-xs" />{:else}<DownloadIcon
                        class="text-xs"
                      />{/if}</button
                  >
                </div>
                <button
                  type="button"
                  onclick={() => App.library.playAndSelectAlbum(album)}
                  class="bg-mauve text-crust pointer-events-none absolute right-2 bottom-2 grid size-8 translate-y-1 place-items-center rounded-full opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100"
                  ><PlayIcon class="text-xs" /></button
                >
              </div>
              <button
                type="button"
                onclick={() => App.library.activateAlbum(album)}
                ondblclick={() => App.player.playAlbum(album)}
                class="mt-2 block h-10 w-full text-left"
                ><h3 class="text-2xs text-text truncate font-semibold">{album.title}</h3>
                <p class="text-3xs text-overlay1 mt-0.5 truncate">
                  {album.album_artist || album.artist}
                </p></button
              >
            </article>
          {/each}
        </div>
      {/snippet}
    </VirtualList>
  </div>
</section>
