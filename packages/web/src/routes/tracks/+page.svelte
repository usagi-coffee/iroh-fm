<script>
  import { App } from "$lib/runes/App.svelte.js";

  import AlbumGrid from "../albums/AlbumGrid.svelte";
  import TrackList from "../TrackList.svelte";

  let query = $state("");
  let tracks = $derived(App.library.getFilteredTracks(false, query));
  let items = $derived(App.library.getTrackListItems(tracks));
  let albums = $derived(App.library.getVisibleAlbums());
</script>

<div class="desktop:grid-cols-[minmax(0,2fr)_minmax(21rem,1fr)] grid h-full min-h-0 grid-cols-1">
  <div class="desktop:border-r border-surface0 min-h-0">
    <TrackList {tracks} {items} {query} onquery={(value) => (query = value)} />
  </div>
  <div class="desktop:block hidden min-h-0">
    <AlbumGrid {albums} />
  </div>
</div>
