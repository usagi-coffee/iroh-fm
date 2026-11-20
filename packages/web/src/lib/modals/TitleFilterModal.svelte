<script>
  import { untrack } from "svelte";

  import SnippetModal from "#lib/modals/Snippet.svelte";

  /** @typedef {{ initialFilter: string, dismiss: (filter: string | null) => void }} Props */
  /** @type {Props} */
  const { initialFilter, dismiss } = $props();
  let draft = $state(untrack(() => initialFilter));
</script>

<SnippetModal
  {dismiss}
  cancelValue={null}
  snippet={Content}
  labelledBy="title-filter-heading"
  class="border-surface1 bg-base shadow-float w-full max-w-sm border"
/>

{#snippet Content()}
  <form
    data-native-keyboard
    onsubmit={(event) => {
      event.preventDefault();
      dismiss(draft);
    }}
  >
    <div class="border-surface0 bg-mantle border-b px-5 py-4">
      <h2 id="title-filter-heading" class="text-text text-lg font-semibold">Filter songs</h2>
    </div>
    <div class="p-5">
      <label for="title-filter" class="text-text text-sm font-semibold"
        >Hide titles containing</label
      >
      <p id="title-filter-help" class="text-subtext0 mt-1 text-xs">
        Enter one keyword or phrase per line. Matches ignore case. This filter is saved on this
        device.
      </p>
      <textarea
        id="title-filter"
        aria-describedby="title-filter-help"
        {@attach (element) => queueMicrotask(() => element.focus())}
        bind:value={draft}
        rows="4"
        spellcheck="false"
        placeholder={"(Instrumental)\n(Off Vocal)"}
        class="border-surface1 bg-mantle text-text placeholder:text-overlay0 focus:border-mauve mt-3 w-full resize-none border px-3 py-2 font-mono text-sm outline-none"
      ></textarea>
    </div>
    <div class="border-surface0 bg-mantle flex items-center justify-end gap-2 border-t px-5 py-3">
      <button
        type="button"
        disabled={!draft}
        onclick={() => (draft = "")}
        class="text-overlay1 hover:text-text text-3xs mr-auto py-2 font-mono disabled:opacity-40"
        >CLEAR ALL</button
      >
      <button
        type="button"
        onclick={() => dismiss(null)}
        class="border-surface1 text-3xs text-subtext0 hover:bg-surface0 border px-4 py-2 font-mono"
        >CANCEL</button
      >
      <button type="submit" class="bg-mauve text-crust text-3xs px-4 py-2 font-mono font-bold"
        >APPLY</button
      >
    </div>
  </form>
{/snippet}
