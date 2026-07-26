<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";

  import { App } from "$lib/runes/App.svelte.js";

  import TrackList from "../../TrackList.svelte";

  const params = $derived(new SvelteURLSearchParams(page.url.search));
  const query = $derived(params.get("query") ?? "");
  const tracks = $derived(App.library.getFilteredTracks(true, query));
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

<TrackList
  {tracks}
  {items}
  {query}
  queueTracks={App.library.availableStarredTracks}
  onquery={updateQuery}
/>
