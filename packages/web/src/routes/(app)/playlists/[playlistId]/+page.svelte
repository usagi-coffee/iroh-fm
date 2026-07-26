<script>
  import { SvelteURLSearchParams } from "svelte/reactivity";

  import { goto, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import ConfirmModal from "$lib/modals/ConfirmModal.svelte";
  import PlaylistNameModal from "$lib/modals/PlaylistNameModal.svelte";
  import { modal } from "$lib/modals/index.js";
  import { App } from "$lib/runes/App.svelte.js";
  import { friendlyError } from "$lib/utils.js";

  import DeleteIcon from "virtual:icons/ri/delete-bin-line";
  import EditIcon from "virtual:icons/ri/edit-line";

  import TrackList from "../../../TrackList.svelte";

  const playlist = $derived(App.library.playlistById.get(page.params.playlistId ?? "") ?? null);
  const params = $derived(new SvelteURLSearchParams(page.url.search));
  const query = $derived(params.get("query") ?? "");
  const queueTracks = $derived(playlist ? App.library.tracksForPlaylist(playlist) : []);
  const tracks = $derived(playlist ? App.library.filteredPlaylistTracks(playlist, query) : []);
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

  async function rename() {
    if (!playlist) return;
    const name = await modal(PlaylistNameModal, {
      title: "Rename playlist",
      initialName: playlist.name,
    });
    if (name && name !== playlist.name) await App.library.updatePlaylist(playlist, { name });
  }

  async function remove() {
    if (!playlist) return;
    try {
      const confirmed = await modal(ConfirmModal, {
        title: `Delete “${playlist.name}”?`,
        message: "The playlist will be permanently removed. Your music files are not affected.",
        confirmLabel: "DELETE",
        cancelLabel: "CANCEL",
        eyebrow: "Playlist",
        danger: true,
      });
      if (confirmed && (await App.library.deletePlaylist(playlist))) await goto(resolve("/tracks"));
    } catch (error) {
      App.connection.error = friendlyError(error, "Could not open the delete dialog.");
    }
  }
</script>

{#if playlist}
  <section class="flex h-full min-h-0 flex-col">
    <header class="border-surface0 bg-mantle flex h-11 shrink-0 items-center gap-3 border-b px-4">
      <div class="min-w-0 flex-1">
        <h1 class="text-text truncate text-sm font-semibold">{playlist.name}</h1>
        <p class="text-3xs text-overlay0 font-mono">
          {queueTracks.length}{#if App.library.offlineOnly}
            / {playlist.track_ids.length}{/if}
          {playlist.track_ids.length === 1 ? "track" : "tracks"}
        </p>
      </div>
      <button
        type="button"
        onclick={rename}
        class="text-overlay1 hover:bg-surface0 hover:text-mauve grid size-8 place-items-center"
        title="Rename playlist"
        aria-label="Rename playlist"><EditIcon class="text-sm" /></button
      >
      <button
        type="button"
        onclick={remove}
        class="text-overlay1 hover:bg-surface0 hover:text-red grid size-8 place-items-center"
        title="Delete playlist"
        aria-label="Delete playlist"><DeleteIcon class="text-sm" /></button
      >
    </header>
    <div class="min-h-0 flex-1">
      <TrackList
        {tracks}
        {items}
        {query}
        {queueTracks}
        {playlist}
        onquery={updateQuery}
      />
    </div>
  </section>
{:else}
  <section class="bg-base grid h-full place-items-center p-8 text-center">
    <div>
      <p class="text-3xs text-red font-mono tracking-wider uppercase">Playlist not found</p>
      <h1 class="text-text mt-2 text-xl font-semibold">This playlist is unavailable.</h1>
      <p class="text-overlay1 mt-2 text-sm">It may have been deleted or belongs to another client.</p>
      <a
        href={resolve("/tracks")}
        class="border-surface1 text-mauve hover:bg-surface0 mt-6 inline-block border px-4 py-2 text-xs"
        >Go to Tracks</a
      >
    </div>
  </section>
{/if}
