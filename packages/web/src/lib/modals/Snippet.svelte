<script>
  import { focusModal } from "$lib/modals/index.js";

  /**
   * @typedef {Object} Props
   * @property {(result?: any) => void} dismiss
   * @property {import('svelte').Snippet<[any]>} snippet
   * @property {any} [cancelValue]
   * @property {string} [class]
   * @property {string} [labelledBy]
   * @property {string} [describedBy]
   * @property {boolean} [preventContextMenu]
   */
  /** @type {Props & Record<string, any>} */
  const {
    dismiss,
    snippet,
    cancelValue,
    class:
      className = "w-full max-w-md overflow-hidden border border-surface1 bg-crust shadow-float",
    labelledBy,
    describedBy,
    preventContextMenu = false,
    ...props
  } = $props();

  /** @param {HTMLDialogElement} element */
  function dialog(element) {
    /** @param {Event} event */
    const cancel = (event) => {
      event.preventDefault();
      dismiss(cancelValue);
    };
    element.addEventListener("cancel", cancel);
    element.showModal();
    return () => {
      element.removeEventListener("cancel", cancel);
      if (element.open) element.close();
    };
  }
</script>

<dialog
  {@attach dialog}
  class="text-text backdrop:bg-crust/75 fixed inset-0 m-0 size-full max-h-none max-w-none place-items-center overflow-hidden border-0 bg-transparent p-4 backdrop:backdrop-blur-sm open:grid"
  aria-labelledby={labelledBy}
  aria-describedby={describedBy}
  onclick={(event) => {
    if (event.target === event.currentTarget) dismiss(cancelValue);
  }}
  oncontextmenu={(event) => {
    if (preventContextMenu) event.preventDefault();
  }}
>
  <div {@attach focusModal} class={className} role="document" tabindex="-1">
    {@render snippet({ dismiss, ...props })}
  </div>
</dialog>
