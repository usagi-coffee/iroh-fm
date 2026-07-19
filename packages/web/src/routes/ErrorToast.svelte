<script>
	import { App } from '$lib/runes/App.svelte.js';
	import CloseIcon from 'virtual:icons/ri/close-line';
</script>

{#if App.connection.client && App.connection.error}
	<div class="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 border border-red/40 bg-crust px-4 py-3 text-xs text-red shadow-float" role="status">
		<span>{App.connection.error}</span>
		<button type="button" onclick={() => (App.connection.error = '')} aria-label="Dismiss error"><CloseIcon class="text-sm"/></button>
	</div>
{/if}
