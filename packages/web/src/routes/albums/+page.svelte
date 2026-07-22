<script>
  import { App } from "$lib/runes/App.svelte.js";

  import AlbumGrid from "./AlbumGrid.svelte";
</script>

<div class="contents" data-album-library>
  <AlbumGrid
    albums={App.library.visibleAlbums}
    followPlayingTrack
    initialWidth={document.documentElement.clientWidth}
  />
</div>
