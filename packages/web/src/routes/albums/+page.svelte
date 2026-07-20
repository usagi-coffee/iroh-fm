<script>
  import { App } from "$lib/runes/App.svelte.js";

  import AlbumGrid from "./AlbumGrid.svelte";
</script>

<div class="contents">
  <AlbumGrid albums={App.library.visibleAlbums} followPlayingTrack />
</div>
