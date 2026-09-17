<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import TrackList from "../../TrackList.svelte";

  import { App } from "#lib/runes/App.svelte.js";

  const params = $derived(new SvelteURLSearchParams(page.url.search));
  const query = $derived(params.get("query") ?? "");
  const tracks = $derived(App.library.getFilteredTracks(true, query));
  const items = $derived(App.library.getTrackListItems(tracks));

  /** @param {string} value */
  function updateQuery(value) {
    if (value) params.set("query", value);
    else params.delete("query");
    void goto(
      `${page.url.pathname}${params.size ? `?${params}` : ""}${page.url.hash}`,
      { shallow: true, replace: true, state: page.state },
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
