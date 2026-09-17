<script>
  import AlbumGrid from "./AlbumGrid.svelte";

  import { App } from "#lib/runes/App.svelte.js";
</script>

<div class="contents" data-album-library>
  <AlbumGrid
    albums={App.library.visibleAlbums}
    followPlayingTrack
    initialWidth={document.documentElement.clientWidth}
  />
</div>
