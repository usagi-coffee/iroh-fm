<script>
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import PlaylistPickerModal from "$lib/modals/PlaylistPickerModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { formatBytes, formatTime } from "$lib/utils.js";

  import DownloadIcon from "virtual:icons/ri/download-line";
  import StarIcon from "virtual:icons/ri/star-line";
  import PlaylistIcon from "virtual:icons/ri/play-list-add-line";

  import Cover from "../../routes/Cover.svelte";

  /**
   * @typedef {Object} Props
   * @property {(result?: unknown) => void} dismiss
   * @property {import('@iroh-fm/client/types').Album | null | undefined} album
   * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
   * @property {string} title
   * @property {string} cacheKey
   */
  /** @type {Props} */
  const { dismiss, album, tracks, title, cacheKey } = $props();

  async function toggleStar() {
    dismiss();
    await App.library.toggleStarAlbum(album);
  }

  function cache() {
    dismiss();
    void App.library.cacheAlbum(tracks, cacheKey);
  }

  function addToPlaylist() {
    dismiss();
    void modal(PlaylistPickerModal, { tracks });
  }
</script>

<SnippetModal
  {dismiss}
  snippet={Content}
  labelledBy="album-actions-title"
  preventContextMenu
  class="border-surface1 bg-crust shadow-float w-full max-w-md min-w-0 overflow-hidden border p-2"
/>

{#snippet Content()}
  {const cached = $derived(
    album
      ? App.library.isAlbumFullyCached(album)
      : tracks.length > 0 && tracks.every((track) => track.cached),
  )}
  {const starred = $derived(Boolean(album && App.library.starredAlbumIds.has(album.id)))}
  {const duration = $derived(
    tracks.reduce((total, track) => total + (track.duration_seconds ?? 0), 0),
  )}
  {const size = $derived(tracks.reduce((total, track) => total + (track.file_size ?? 0), 0))}
  <div class="border-surface0 grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-4 border-b p-3">
    <Cover
      client={App.connection.client}
      id={album?.cover_art_id ?? tracks[0]?.cover_art_id}
      {title}
      class="size-24 shrink-0 rounded-sm"
    />
    <div class="min-w-0 self-center overflow-hidden">
      <p
        id="album-actions-title"
        class="text-text block max-w-full overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap"
        {title}
      >
        {title}
      </p>
      <p class="text-mauve mt-1 truncate text-xs">
        {album?.album_artist ?? album?.artist ?? tracks[0]?.album_artist ?? tracks[0]?.artist}
      </p>
      <p class="text-3xs text-overlay0 mt-2 font-mono leading-5">
        {tracks.length}
        {tracks.length === 1 ? "track" : "tracks"} · {formatTime(duration)}<br />{formatBytes(size)}
      </p>
    </div>
  </div>
  <button
    type="button"
    onclick={toggleStar}
    disabled={!album}
    class="text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
    ><StarIcon class="text-sm" />{starred ? "Unstar album" : "Star album"}</button
  >
  <button
    type="button"
    onclick={cache}
    disabled={App.library.offlineOnly || cached || App.library.cachingAlbumIds.has(cacheKey)}
    class="text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 flex w-full items-center gap-3 px-3 py-3 text-left text-xs {cached
      ? '!text-green'
      : ''}"
    >{#if !cached}<DownloadIcon class="text-sm" />{/if}{cached
      ? "Album cached"
      : App.library.cachingAlbumIds.has(cacheKey)
        ? "Downloading album…"
        : App.library.offlineOnly
          ? "Unavailable offline"
          : "Download album"}</button
  >
  <button
    type="button"
    onclick={addToPlaylist}
    disabled={!tracks.length}
    class="text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
    ><PlaylistIcon class="text-sm" />Add album to playlist</button
  >
{/snippet}
