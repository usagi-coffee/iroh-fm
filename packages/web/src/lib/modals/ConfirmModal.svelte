<script>
	import { focusModal } from './index.js';

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
	let { dismiss, title, message, confirmLabel, cancelLabel = 'LATER', eyebrow = '', danger = false } = $props();

</script>

<div class="fixed inset-0 z-[100] grid place-items-center bg-crust/75 p-4 backdrop-blur-sm" role="presentation" onclick={() => dismiss(false)}>
	<div {@attach focusModal} class="w-full max-w-sm border border-surface1 bg-base shadow-float" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description" onclick={(event) => event.stopPropagation()} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') dismiss(false); }}>
		<div class="border-b border-surface0 bg-mantle px-5 py-4">
			{#if eyebrow}<p class="font-mono text-[10px] uppercase tracking-[.16em] {danger ? 'text-red' : 'text-mauve'}">{eyebrow}</p>{/if}
			<h2 id="modal-title" class="text-lg font-semibold text-text" class:mt-1={eyebrow}>{title}</h2>
		</div>
		<div class="p-5"><p id="modal-description" class="text-xs leading-5 text-overlay1">{message}</p></div>
		<div class="flex justify-end gap-2 border-t border-surface0 bg-mantle px-5 py-3">
			<button type="button" onclick={() => dismiss(false)} class="border border-surface1 px-4 py-2 font-mono text-[10px] text-subtext0 hover:bg-surface0">{cancelLabel}</button>
			<button type="button" onclick={() => dismiss(true)} class="px-4 py-2 font-mono text-[10px] font-bold text-crust {danger ? 'bg-red hover:bg-maroon' : 'bg-mauve hover:bg-pink'}">{confirmLabel}</button>
		</div>
	</div>
</div>
