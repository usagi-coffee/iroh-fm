<script>
  import AlbumActionsModal from "$lib/modals/AlbumActionsModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { immediateTauriWheelScroll } from "$lib/ui/immediate-wheel-scroll.js";
  import { longPress } from "$lib/ui/long-press.js";
  import VirtualList from "$lib/ui/VirtualList.svelte";
  import { friendlyError } from "$lib/utils.js";

  import AddIcon from "virtual:icons/ri/add-line";
  import CachedIcon from "virtual:icons/ri/check-line";
  import DownloadIcon from "virtual:icons/ri/download-line";
  import HeartIcon from "virtual:icons/ri/heart-line";
  import GridIcon from "virtual:icons/ri/layout-grid-line";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import SubtractIcon from "virtual:icons/ri/subtract-line";

  import Cover from "../Cover.svelte";

  /** @typedef {{ albums: import('$lib/types').AlbumData[], followPlayingTrack?: boolean }} Props */
  /** @type {Props} */
  let { albums, followPlayingTrack = false } = $props();
  const ALBUM_MIN_WIDTH_REM = 7.8125;
  const ALBUM_ACTIONS_MIN_WIDTH_REM = 7;
  const ALBUM_GAP_REM = 0.75;
  const ALBUM_HORIZONTAL_PADDING_REM = 1.5;
  const MAX_COLUMNS = 16;
  const COLUMN_ADJUSTMENT_KEY = "iroh-fm-album-column-adjustment";
  let gridWidth = $state(0);
  let rootFontSize = $state(16);
  let columnAdjustment = $state(0);
  /** @type {{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void } | undefined} */
  let albumList = $state();
  /** @type {string | null} */
  let focusedAlbumId = null;
  const autoColumns = $derived.by(() => {
    const albumMinWidth = ALBUM_MIN_WIDTH_REM * rootFontSize;
    const gap = ALBUM_GAP_REM * rootFontSize;
    const available = Math.max(0, gridWidth - ALBUM_HORIZONTAL_PADDING_REM * rootFontSize);
    return Math.max(1, Math.floor((available + gap) / (albumMinWidth + gap)));
  });
  const maxColumns = $derived.by(() => {
    const minimum = ALBUM_ACTIONS_MIN_WIDTH_REM * rootFontSize;
    const gap = ALBUM_GAP_REM * rootFontSize;
    const available = Math.max(0, gridWidth - ALBUM_HORIZONTAL_PADDING_REM * rootFontSize);
    return Math.max(1, Math.min(MAX_COLUMNS, Math.floor((available + gap) / (minimum + gap))));
  });
  const columns = $derived(Math.max(1, Math.min(maxColumns, autoColumns + columnAdjustment)));
  const bufferSize = $derived(25 * rootFontSize);
  const rows = $derived.by(() => {
    /** @type {import('$lib/types').AlbumData[][]} */
    const grouped = [];
    for (let index = 0; index < albums.length; index += columns)
      grouped.push(albums.slice(index, index + columns));
    return grouped;
  });
  const estimatedRowHeight = $derived.by(() => {
    const gap = ALBUM_GAP_REM * rootFontSize;
    const available = Math.max(0, gridWidth - ALBUM_HORIZONTAL_PADDING_REM * rootFontSize);
    const coverWidth = (available - Math.max(0, columns - 1) * gap) / columns;
    return Math.max(rootFontSize * 8, coverWidth + rootFontSize * 3.75);
  });
  const playingAlbumId = $derived.by(() => {
    const track = App.player.currentTrack;
    return track ? (App.library.albumByTrackId.get(track.id)?.id ?? null) : null;
  });
  const initialPlayingRowIndex = $derived(
    playingAlbumId ? rows.findIndex((row) => row.some((album) => album.id === playingAlbumId)) : -1,
  );

  /** @param {import('$lib/types').AlbumData[]} row */
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
    const storedAdjustment = Number.parseInt(localStorage.getItem(COLUMN_ADJUSTMENT_KEY) ?? "", 10);
    if (Number.isFinite(storedAdjustment))
      columnAdjustment = Math.max(-MAX_COLUMNS, Math.min(MAX_COLUMNS, storedAdjustment));
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
  function focusPlayingAlbum(host) {
    if (!followPlayingTrack) return;
    const track = App.player.currentTrack;
    const album = track ? App.library.albumByTrackId.get(track.id) : null;
    if (!album) {
      focusedAlbumId = null;
      return;
    }
    if (album.id === focusedAlbumId) return;
    const rowIndex = initialPlayingRowIndex;
    if (rowIndex < 0) return;
    focusedAlbumId = album.id;
    let attempts = 60;
    let cancelled = false;
    /** @type {number | undefined} */
    let frame;
    const center = () => {
      if (cancelled || attempts-- <= 0) return;
      const target = host.querySelector(`[data-album-id="${CSS.escape(album.id)}"]`);
      if (target instanceof HTMLElement) return;
      albumList?.scrollToIndex(rowIndex, { align: "center" });
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

  /** @param {import('$lib/types').AlbumData} album @param {MouseEvent} [event] */
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

  /** @param {import('$lib/types').AlbumData} album @param {MouseEvent} event */
  function cacheAlbum(album, event) {
    event.stopPropagation();
    void App.library.cacheAlbum(App.library.tracksForAlbum(album), album.id);
  }

  /** @param {import('$lib/types').AlbumData} album @param {MouseEvent} event */
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
    {@attach focusPlayingAlbum}
    class="min-h-0 flex-1"
  >
    <VirtualList
      bind:api={() => albumList, (value) => (albumList = value)}
      items={rows}
      getKey={albumRowKey}
      estimateSize={estimatedRowHeight}
      measureItems="uniform"
      overscan={bufferSize}
      paddingStart={rootFontSize * ALBUM_GAP_REM}
      initialIndex={initialPlayingRowIndex >= 0 ? initialPlayingRowIndex : null}
    >
      {#snippet children(row, rowIndex)}
        <div
          class="grid gap-3 px-3 pb-5"
          style={`grid-template-columns:repeat(${columns},minmax(0,1fr))`}
        >
          {#each row as album (album.id)}
            <article
              data-album-id={album.id}
              {@attach longPress(() => openActions(album))}
              oncontextmenu={(event) => openActions(album, event)}
              class="group min-w-0"
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
                    class="bg-crust/85 hover:bg-crust hover:text-pink grid size-7 place-items-center rounded-full shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 {App.library.starredAlbumIds.has(
                      album.id,
                    )
                      ? 'text-pink pointer-events-auto translate-y-0 opacity-100'
                      : 'text-subtext0 pointer-events-none translate-y-1 opacity-0'}"
                    title={App.library.starredAlbumIds.has(album.id)
                      ? "Unstar album"
                      : "Star album"}><HeartIcon class="text-xs" /></button
                  >
                  <button
                    type="button"
                    onclick={(event) => cacheAlbum(album, event)}
                    disabled={App.library.offlineOnly ||
                      App.library.isAlbumFullyCached(album) ||
                      App.library.cachingAlbumIds.has(album.id)}
                    class="bg-crust/85 text-subtext0 hover:bg-crust hover:text-mauve pointer-events-none grid size-7 translate-y-1 place-items-center rounded-full opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 disabled:cursor-default {App.library.isAlbumFullyCached(
                      album,
                    )
                      ? '!text-green'
                      : ''} {App.library.cachingAlbumIds.has(album.id)
                      ? 'text-mauve animate-pulse'
                      : ''}"
                    title={App.library.isAlbumFullyCached(album)
                      ? "Album cached"
                      : App.library.cachingAlbumIds.has(album.id)
                        ? "Downloading album"
                        : "Download album"}
                    >{#if App.library.isAlbumFullyCached(album)}<CachedIcon
                        class="text-xs"
                      />{:else}<DownloadIcon class="text-xs" />{/if}</button
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
                class="mt-2 block w-full text-left"
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
