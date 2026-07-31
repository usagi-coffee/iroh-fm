<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";

  import TrackList from "../../TrackList.svelte";
  import AlbumGrid from "../albums/AlbumGrid.svelte";

  const params = $derived(new SvelteURLSearchParams(page.url.search));
  const query = $derived(params.get("query") ?? "");
  const tracks = $derived(App.library.getFilteredTracks(false, query));
  const items = $derived(App.library.getTrackListItems(tracks));
  /** @type {string | null} */
  let albumFocusTrackId = $derived(
    App.library.pendingTrackFocusId ??
      page.state.focusTrackId ??
      App.player.currentTrack?.id ??
      null,
  );
  let albumFocusRequest = $state(0);

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

<div class="desktop:grid-cols-[minmax(0,2fr)_minmax(21rem,1fr)] grid h-full min-h-0 grid-cols-1">
  <div class="desktop:border-r border-surface0 min-h-0">
    <TrackList
      {tracks}
      {items}
      {query}
      queueTracks={App.library.availableTracks}
      onquery={updateQuery}
      onplay={(track) => {
        albumFocusTrackId = track.id;
        albumFocusRequest += 1;
      }}
    />
  </div>
  <div class="desktop:block hidden min-h-0">
    <AlbumGrid
      albums={App.library.visibleAlbums}
      focusTrackId={albumFocusTrackId}
      focusRequest={albumFocusRequest}
    />
  </div>
</div>
