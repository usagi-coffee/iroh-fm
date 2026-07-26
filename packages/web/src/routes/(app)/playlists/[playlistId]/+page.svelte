<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";

  import TrackList from "../../../TrackList.svelte";

  const playlist = $derived(App.library.playlistById.get(page.params.playlistId ?? "") ?? null);
  const params = $derived(new SvelteURLSearchParams(page.url.search));
  const query = $derived(params.get("query") ?? "");
  const queueTracks = $derived(playlist ? App.library.tracksForPlaylist(playlist) : []);
  const tracks = $derived(playlist ? App.library.filteredPlaylistTracks(playlist, query) : []);
  const items = $derived(App.library.getTrackListItems(tracks));

  /** @param {string} value */
  function updateQuery(value) {
    if (value) params.set("query", value);
    else params.delete("query");
    replaceState(
      `${page.url.pathname}${params.size ? `?${params}` : ""}${page.url.hash}`,
      page.state,
    );
  }

</script>

{#if playlist}
  <section class="h-full min-h-0">
    <TrackList {tracks} {items} {query} {queueTracks} {playlist} onquery={updateQuery} />
  </section>
{:else}
  <section class="bg-base grid h-full place-items-center p-8 text-center">
    <div>
      <p class="text-3xs text-red font-mono tracking-wider uppercase">Playlist not found</p>
      <h1 class="text-text mt-2 text-xl font-semibold">This playlist is unavailable.</h1>
      <p class="text-overlay1 mt-2 text-sm">It may have been deleted or belongs to another client.</p>
      <a
        href={resolve("/tracks")}
        class="border-surface1 text-mauve hover:bg-surface0 mt-6 inline-block border px-4 py-2 text-xs"
        >Go to Tracks</a
      >
    </div>
  </section>
{/if}
