<script>
  import { App } from "$lib/runes/App.svelte.js";

  import TrackList from "../TrackList.svelte";

  let query = $state("");
  const tracks = $derived(App.library.getFilteredTracks(true, query));
  const items = $derived(App.library.getTrackListItems(tracks));
</script>

<TrackList {tracks} {items} {query} onquery={(value) => (query = value)} />
