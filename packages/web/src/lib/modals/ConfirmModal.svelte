<script>
  import SnippetModal from "$lib/modals/Snippet.svelte";

  /**
   * @typedef {Object} Props
   * @property {(confirmed: boolean) => void} dismiss
   * @property {string} title
   * @property {string} message
   * @property {string} confirmLabel
   * @property {string} [cancelLabel]
   * @property {string} [eyebrow]
   * @property {boolean} [danger]
   */
  /** @type {Props} */
  const {
    dismiss,
    title,
    message,
    confirmLabel,
    cancelLabel = "LATER",
    eyebrow = "",
    danger = false,
  } = $props();
</script>

<SnippetModal
  {dismiss}
  snippet={Content}
  cancelValue={false}
  labelledBy="modal-title"
  describedBy="modal-description"
  class="border-surface1 bg-base shadow-float w-full max-w-sm border"
/>

{#snippet Content()}
  <div class="border-surface0 bg-mantle border-b px-5 py-4">
    {#if eyebrow}<p
        class="text-3xs font-mono tracking-[.16em] uppercase {danger ? 'text-red' : 'text-mauve'}"
      >
        {eyebrow}
      </p>{/if}
    <h2 id="modal-title" class="text-text text-lg font-semibold" class:mt-1={eyebrow}>{title}</h2>
  </div>
  <div class="p-5">
    <p id="modal-description" class="text-overlay1 text-xs leading-5">{message}</p>
  </div>
  <div class="border-surface0 bg-mantle flex justify-end gap-2 border-t px-5 py-3">
    <button
      type="button"
      onclick={() => dismiss(false)}
      class="border-surface1 text-3xs text-subtext0 hover:bg-surface0 border px-4 py-2 font-mono"
      >{cancelLabel}</button
    >
    <button
      type="button"
      onclick={() => dismiss(true)}
      class="text-3xs text-crust px-4 py-2 font-mono font-bold {danger
        ? 'bg-red hover:bg-maroon'
        : 'bg-mauve hover:bg-pink'}">{confirmLabel}</button
    >
  </div>
{/snippet}
