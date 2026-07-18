<script>
	import { base } from '$app/paths';
	import { attach as serviceworker } from '$lib/service-worker.js';
	import '../app.css';

	let { children, data } = $props();
</script>

<div id="content" {@attach serviceworker()}>
	<svelte:boundary>
		{#if await data.serviceWorkerReady}
			{@render children()}
		{/if}

		{#snippet pending()}
			<div class="grid h-dvh place-items-center bg-base p-6 text-text">
				<div class="flex w-full max-w-56 flex-col items-center gap-4 text-center">
					<img src={`${base}/pwa-icon-192.png`} alt="" class="size-12 rounded-xl" />
					<div><p class="text-sm font-semibold">Preparing the player</p><p class="mt-1 text-[11px] text-overlay1">Starting offline support…</p></div>
					<div class="h-1 w-full overflow-hidden bg-surface0"><div class="h-full w-1/2 animate-pulse bg-mauve"></div></div>
				</div>
			</div>
		{/snippet}

		{#snippet failed()}
			<div class="grid h-dvh place-items-center bg-base p-6 text-text">
				<div class="max-w-sm border border-red/40 bg-mantle p-5 text-center"><p class="text-sm font-semibold text-red">Offline support could not start</p><p class="mt-2 text-xs leading-5 text-overlay1">Reload the page to retry service-worker registration.</p><button onclick={() => location.reload()} class="mt-4 bg-mauve px-4 py-2 font-mono text-[10px] font-bold text-crust">RELOAD</button></div>
			</div>
		{/snippet}
	</svelte:boundary>
</div>
