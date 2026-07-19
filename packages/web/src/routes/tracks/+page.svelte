<script>
  import { App } from "$lib/runes/App.svelte.js";

  import TrackList from "../TrackList.svelte";

  let query = $state("");
  let tracks = $derived(App.library.getFilteredTracks(false, query));
  let items = $derived(App.library.getTrackListItems(tracks));
</script>

<TrackList {tracks} {items} {query} onquery={(value) => (query = value)} />
