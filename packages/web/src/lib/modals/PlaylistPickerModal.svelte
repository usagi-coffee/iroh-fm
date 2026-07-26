<script>
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import { App } from "$lib/runes/App.svelte.js";

  import AddIcon from "virtual:icons/ri/add-line";
  import PlaylistIcon from "virtual:icons/ri/play-list-add-line";

  /**
   * @typedef {Object} Props
   * @property {(result?: unknown) => void} dismiss
   * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
   */
  /** @type {Props} */
  const { dismiss, tracks } = $props();
  let busy = $state(false);

  /** @param {import('@iroh-fm/client/types').Playlist} playlist */
  async function add(playlist) {
    busy = true;
    const result = await App.library.addTracksToPlaylist(playlist, tracks);
    busy = false;
    if (result) dismiss(result);
  }

  async function create() {
    busy = true;
    const result = await App.library.createDefaultPlaylist(tracks);
    busy = false;
    if (result) dismiss(result);
  }
</script>

<SnippetModal
  {dismiss}
  snippet={Content}
  labelledBy="playlist-picker-title"
  class="border-surface1 bg-crust shadow-float w-full max-w-sm overflow-hidden border"
/>

{#snippet Content()}
  <div class="border-surface0 bg-mantle border-b px-4 py-3">
    <h2 id="playlist-picker-title" class="text-text text-sm font-semibold">Add to playlist</h2>
    <p class="text-3xs text-overlay0 mt-1">{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</p>
  </div>
  <div class="max-h-64 overflow-y-auto p-2">
    {#each App.library.playlists as playlist (playlist.id)}
      <button
        type="button"
        disabled={busy}
        onclick={() => add(playlist)}
        class="text-subtext0 hover:bg-surface0 hover:text-text flex w-full items-center gap-3 px-3 py-3 text-left text-xs"
        ><PlaylistIcon class="text-sm" /><span class="min-w-0 flex-1 truncate"
          >{playlist.name}</span
        ><span class="text-3xs text-overlay0">{playlist.track_ids.length}</span></button
      >
    {/each}
  </div>
  <div class="border-surface0 bg-mantle border-t p-3">
    <button
      type="button"
      onclick={create}
      disabled={busy}
      class="bg-mauve text-crust flex w-full items-center justify-center gap-2 px-3 py-2 text-xs font-semibold disabled:opacity-40"
      aria-label="Create playlist and add tracks"><AddIcon class="text-sm" />New playlist</button
    >
  </div>
{/snippet}
