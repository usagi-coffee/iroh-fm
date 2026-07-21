<script>
  import { untrack } from "svelte";

  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";

  import AlbumActionsModal from "$lib/modals/AlbumActionsModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import { App } from "$lib/runes/App.svelte.js";
  import { immediateTauriWheelScroll } from "$lib/ui/immediate-wheel-scroll.js";
  import { longPress } from "$lib/ui/long-press.js";
  import { formatBytes, formatTime, friendlyError } from "$lib/utils.js";

  import DownloadIcon from "virtual:icons/ri/download-line";
  import HeartIcon from "virtual:icons/ri/heart-line";
  import PauseIcon from "virtual:icons/ri/pause-fill";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import SearchIcon from "virtual:icons/ri/search-line";

  import Cover from "./Cover.svelte";

  import { VList } from "virtua/svelte";

  /**
   * @typedef {Object} Props
   * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
   * @property {import('$lib/types').TrackListItem[]} items
   * @property {string} query
   * @property {(value: string) => void} onquery
   */
  /** @type {Props} */
  let { tracks, items, query, onquery } = $props();
  const ROW_HEIGHT_REM = 1.75;
  let rowHeight = $state(ROW_HEIGHT_REM * 16);
  const bufferSize = $derived(rowHeight * 60);
  let focusPlayingTrackOnMount = true;
  const COVER_MARGIN = "150%";

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
    const selectedIndex = tracks.findIndex(
      (track) => track.id === App.library.selectedTrackId,
    );
    const start = selectedIndex < 0 ? (direction > 0 ? -1 : tracks.length) : selectedIndex;
    const nextIndex = Math.max(0, Math.min(tracks.length - 1, start + direction));
    App.library.requestTrackFocus(tracks[nextIndex]);
  }

  function playSearchSelection() {
    const selected = tracks.find((track) => track.id === App.library.selectedTrackId) ?? tracks[0];
    if (selected) playTrackFromList(selected);
  }

  /** @param {import('$lib/runes/Track.svelte.js').Track} track */
  function playTrackFromList(track) {
    let queue = tracks;
    if (query.trim()) {
      queue = App.library.getFilteredTracks();
      onquery("");
      void App.library.focusTrack(track);
    }
    void App.player.playFromTrackList(track, queue);
  }

  /** @param {import('$lib/runes/Track.svelte.js').Track} track @param {MouseEvent} [event] */
  function openTrackActions(track, event) {
    event?.preventDefault();
    event?.stopPropagation();
    void modal(SnippetModal, {
      snippet: TrackActions,
      track,
      labelledBy: "track-actions-title",
      preventContextMenu: true,
      class: "w-full max-w-md overflow-hidden border border-surface1 bg-crust p-2 shadow-float",
    }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open track actions.")),
    );
  }

  /** @param {import('$lib/types').AlbumData | undefined} album @param {import('$lib/runes/Track.svelte.js').Track[]} albumTracks @param {string} title @param {string} cacheKey @param {MouseEvent} [event] */
  function openAlbumActions(album, albumTracks, title, cacheKey, event) {
    event?.preventDefault();
    event?.stopPropagation();
    void modal(AlbumActionsModal, { album, tracks: albumTracks, title, cacheKey }).catch(
      (error) => (App.connection.error = friendlyError(error, "Could not open album actions.")),
    );
  }

  /** @param {HTMLElement} host */
  function focusRequestedTrack(host) {
    const playingTrackId = focusPlayingTrackOnMount
      ? untrack(() => App.player.currentTrack?.id)
      : null;
    focusPlayingTrackOnMount = false;
    const trackId =
      App.library.pendingTrackFocusId ?? page.state.focusTrackId ?? playingTrackId;
    if (!trackId) return;
    const index = items.findIndex((item) => item.kind === "track" && item.track.id === trackId);
    if (index < 0) return;
    App.library.selectedTrackId = trackId;
    let attempts = 120;
    let cancelled = false;
    let centeredFrames = 0;
    /** @type {number | undefined} */
    let frame;
    const retry = () => {
      if (!cancelled && attempts-- > 0) frame = requestAnimationFrame(scroll);
    };
    const scroll = () => {
      const viewport = host.firstElementChild;
      if (!(viewport instanceof HTMLElement)) {
        retry();
        return;
      }
      let target = null;
      for (const element of host.querySelectorAll("[data-track-id]")) {
        if (element instanceof HTMLElement && element.dataset.trackId === trackId) {
          target = element;
          break;
        }
      }
      if (target instanceof HTMLElement) {
        const viewportRect = viewport.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offset =
          targetRect.top + targetRect.height / 2 - (viewportRect.top + viewportRect.height / 2);
        if (Math.abs(offset) > 1) {
          centeredFrames = 0;
          viewport.scrollBy({ top: offset, behavior: "auto" });
          retry();
          return;
        }
        if (++centeredFrames < 2) {
          retry();
          return;
        }
        App.library.pendingTrackFocusId = null;
        if (page.state.focusTrackId) replaceState(page.url, {});
        return;
      }
      centeredFrames = 0;
      const measuredRoot = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const measuredRow = Number.isFinite(measuredRoot) ? measuredRoot * ROW_HEIGHT_REM : rowHeight;
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (maxTop === 0 && items.length > 1) {
        retry();
        return;
      }
      const rendered = host.querySelector("[data-list-index]");
      const renderedIndex =
        rendered instanceof HTMLElement ? Number(rendered.dataset.listIndex) : Number.NaN;
      const requested = Number.isFinite(renderedIndex)
        ? viewport.scrollTop +
          (rendered instanceof HTMLElement
            ? rendered.getBoundingClientRect().top - viewport.getBoundingClientRect().top
            : 0) +
          (index - renderedIndex) * measuredRow -
          (viewport.clientHeight - measuredRow) / 2
        : (index / Math.max(1, items.length - 1)) * maxTop;
      const top = Math.min(maxTop, Math.max(0, requested));
      viewport.scrollTo({ top, behavior: "auto" });
      retry();
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
      value={query}
      oninput={(event) => onquery(event.currentTarget.value)}
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

  <div
    class="min-h-0 flex-1"
    {@attach immediateTauriWheelScroll}
    {@attach focusRequestedTrack}
  >
    <VList
      data={items}
      getKey={(item) => item.key}
      itemSize={rowHeight}
      {bufferSize}
      style="height: 100%; overscroll-behavior: contain;"
    >
      {#snippet children(item, itemIndex)}
        {#if item}
          {#if item.kind === "album"}
          <button
            data-list-index={itemIndex}
            {@attach longPress(() =>
              openAlbumActions(item.album, item.tracks, item.title, item.album?.id ?? item.key),
            )}
            type="button"
            onclick={() => App.player.playAlbumTracks(item.tracks, tracks)}
            oncontextmenu={(event) =>
              openAlbumActions(
                item.album,
                item.tracks,
                item.title,
                item.album?.id ?? item.key,
                event,
              )}
            class="border-surface1 bg-mantle hover:bg-surface0 flex h-7 w-full items-center gap-2 border-y px-2 text-left transition"
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
          <div
            data-list-index={itemIndex}
            data-track-id={item.track.id}
            {@attach longPress(() => openTrackActions(item.track))}
            role="row"
            tabindex="0"
            aria-selected={App.library.selectedTrackId === item.track.id}
            onclick={() => (App.library.selectedTrackId = item.track.id)}
            ondblclick={() => playTrackFromList(item.track)}
            oncontextmenu={(event) => openTrackActions(item.track, event)}
            onkeydown={(event) => {
              if (event.key === "Enter") playTrackFromList(item.track);
              else if (event.key === " ") {
                event.preventDefault();
                App.library.selectedTrackId = item.track.id;
              }
            }}
            class="group border-surface0/35 text-track focus:ring-mauve tablet-xl:grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] grid h-7 grid-cols-[2rem_minmax(0,1fr)_3.2rem] items-center border-b px-2 transition outline-none focus:ring-1 focus:ring-inset {App
              .player.currentTrack?.id === item.track.id
              ? 'bg-mauve/15'
              : App.library.selectedTrackId === item.track.id
                ? 'bg-surface0'
                : 'hover:bg-surface0/60'}"
          >
            <button
              type="button"
              onclick={(event) => {
                event.stopPropagation();
                playTrackFromList(item.track);
              }}
              class="text-3xs text-overlay0 hover:text-mauve grid size-6 place-items-center font-mono"
              aria-label={`Play ${item.track.title}`}
            >
              {#if item.track.downloading}
                <span class="bg-surface1 h-1 w-4 overflow-hidden"
                  ><span
                    class="bg-mauve block h-full transition-[width] duration-150"
                    style={`width:${item.track.progress * 100}%`}
                  ></span></span
                >
              {:else if App.player.currentTrack?.id === item.track.id && App.player.playing}
                <PauseIcon class="text-2xs" />
              {:else if item.track.cached}
                <span class="text-green" title="Cached"
                  >{item.track.track_number || item.trackIndex + 1}</span
                >
              {:else}
                <span class="group-hover:hidden"
                  >{item.track.track_number || item.trackIndex + 1}</span
                ><span class="hidden group-hover:block"><PlayIcon class="text-3xs" /></span>
              {/if}
            </button>
            <div class="text-mauve tablet-xl:block hidden min-w-0 truncate pr-2">
              {item.track.album}
            </div>
            <div class="flex min-w-0 items-center gap-2 pr-2">
              <span class="text-teal truncate">{item.track.title}</span><button
                type="button"
                onclick={(event) => App.library.toggleStar(item.track, event)}
                class="text-overlay0 hover:text-pink ml-auto hidden shrink-0 group-hover:block {App.library.starredTrackIds.has(
                  item.track.id,
                )
                  ? 'text-pink !block'
                  : ''}"
                aria-label="Toggle favorite"><HeartIcon class="text-2xs" /></button
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
    </VList>
  </div>
</section>

{#snippet TrackActions(
  /** @type {{ dismiss: (result?: unknown) => void, track: import('$lib/runes/Track.svelte.js').Track }} */ {
    dismiss,
    track,
  },
)}
  {const downloadDisabled = $derived(App.library.offlineOnly || track.cached || track.downloading)}
  {const downloadLabel = $derived(
    track.cached
      ? "Cached"
      : track.downloading
        ? "Downloading…"
        : App.library.offlineOnly
          ? "Unavailable offline"
          : "Download",
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
    ><HeartIcon class="text-sm" />{App.library.starredTrackIds.has(track.id)
      ? "Unstar"
      : "Star"}</button
  >
  <button
    type="button"
    onclick={() => {
      dismiss();
      void App.library.cacheTrack(track);
    }}
    disabled={downloadDisabled}
    class="text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
    ><DownloadIcon class="text-sm" />{downloadLabel}</button
  >
{/snippet}
