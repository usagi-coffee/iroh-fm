<script>
  import { App } from "$lib/runes/App.svelte.js";

  import AlbumGrid from "../albums/AlbumGrid.svelte";
  import TrackList from "../TrackList.svelte";
</script>

<div class="desktop:grid-cols-[minmax(0,2fr)_minmax(21rem,1fr)] grid h-full min-h-0 grid-cols-1">
  <div class="desktop:border-r border-surface0 min-h-0">
    <TrackList
      tracks={App.library.filteredTracks}
      items={App.library.filteredTrackListItems}
      query={App.library.trackFilterQuery}
      onquery={(value) => (App.library.trackFilterQuery = value)}
    />
  </div>
  <div class="desktop:block hidden min-h-0">
    <AlbumGrid albums={App.library.visibleAlbums} followPlayingTrack />
  </div>
</div>
