<script>
  import { untrack } from "svelte";

  import SnippetModal from "$lib/modals/Snippet.svelte";

  /** @typedef {{ dismiss: (name: string | null) => void, title: string, initialName?: string, submitLabel?: string }} Props */
  /** @type {Props} */
  const { dismiss, title, initialName = "", submitLabel = "SAVE" } = $props();
  let name = $state(untrack(() => initialName));

  /** @param {HTMLInputElement} element */
  function focusName(element) {
    element.focus();
    element.select();
  }
</script>

<SnippetModal
  {dismiss}
  cancelValue={null}
  snippet={Content}
  labelledBy="playlist-name-title"
  class="border-surface1 bg-base shadow-float w-full max-w-sm border"
/>

{#snippet Content()}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      const value = name.trim();
      if (value) dismiss(value);
    }}
  >
    <div class="border-surface0 bg-mantle border-b px-5 py-4">
      <h2 id="playlist-name-title" class="text-text text-lg font-semibold">{title}</h2>
    </div>
    <div class="p-5">
      <label class="text-3xs text-overlay1 font-mono tracking-wider uppercase" for="playlist-name"
        >Name</label
      >
      <input
        id="playlist-name"
        {@attach focusName}
        bind:value={name}
        maxlength="200"
        class="border-surface1 bg-mantle text-text mt-2 w-full border px-3 py-2 text-sm outline-none focus:border-mauve"
      />
    </div>
    <div class="border-surface0 bg-mantle flex justify-end gap-2 border-t px-5 py-3">
      <button
        type="button"
        onclick={() => dismiss(null)}
        class="border-surface1 text-3xs text-subtext0 hover:bg-surface0 border px-4 py-2 font-mono"
        >CANCEL</button
      >
      <button
        type="submit"
        disabled={!name.trim()}
        class="bg-mauve text-crust text-3xs px-4 py-2 font-mono font-bold disabled:opacity-40"
        >{submitLabel}</button
      >
    </div>
  </form>
{/snippet}
