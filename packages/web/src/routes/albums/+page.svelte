<script>
  import { App } from "$lib/runes/App.svelte.js";

  import AlbumGrid from "./AlbumGrid.svelte";

  let albums = $derived(App.library.getVisibleAlbums());
</script>

<div class="contents">
  <AlbumGrid {albums} followPlayingTrack />
</div>
