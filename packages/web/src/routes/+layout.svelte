<script>
	import { asset } from '$app/paths';
	import { activateServiceWorkerUpdate, attach as serviceworker, subscribeToServiceWorkerUpdates } from '$lib/service-worker.js';
	import { modal } from '$lib/modals/index.js';
	import { App } from '$lib/runes/App.svelte.js';
	import ConfirmModal from '$lib/modals/ConfirmModal.svelte';
	import ErrorToast from './ErrorToast.svelte';
	import LoginView from './LoginView.svelte';
	import PlayerBar from './PlayerBar.svelte';
	import TopBar from './TopBar.svelte';
	import '../app.css';

	/** @typedef {import('./$types').LayoutProps} Props */
	/** @type {Props} */
	let { children, data } = $props();
	let updateDialogOpen = false;
	let updateDialogShown = false;
	let updateReady = $state(false);

	async function showUpdateDialog() {
		if (updateDialogOpen) return;
		updateDialogOpen = true;
		try {
			const confirmed = await modal(ConfirmModal, {
				title: 'Update available',
				message: 'Reload to use the latest version.',
				confirmLabel: 'UPDATE',
				cancelLabel: 'LATER'
			});
			if (confirmed) activateServiceWorkerUpdate();
		} catch (error) {
			console.error('[ui] update dialog failed', error);
		} finally {
			updateDialogOpen = false;
		}
	}

	function watchUpdates() {
		return subscribeToServiceWorkerUpdates((ready) => {
			updateReady = ready;
			if (!ready) {
				updateDialogShown = false;
				return;
			}
			if (updateDialogShown) return;
			updateDialogShown = true;
			void showUpdateDialog();
		});
	}
</script>

<svelte:head>
	<title>iroh.fm</title>
	<meta name="description" content="A private iroh music player." />
</svelte:head>

<div id="content" {@attach serviceworker()} {@attach watchUpdates} {@attach App.connection.attachHashChanges}>
	<svelte:boundary>
		{#if await App.initialize(data.serviceWorkerReady)}
			{#if App.connection.client}
				<div {@attach App.connection.monitor(App.connection.client)} class="grid h-dvh grid-rows-[34px_minmax(0,1fr)_72px] overflow-hidden bg-base text-text">
					<TopBar {updateReady} onupdate={showUpdateDialog} />
					<main class="min-h-0 overflow-hidden">{@render children()}</main>
					<PlayerBar />
				</div>
			{:else}
				<LoginView />
			{/if}
				<ErrorToast />
		{/if}

		{#snippet pending()}
			<div class="grid h-dvh place-items-center bg-base p-6 text-text">
				<div class="flex w-full max-w-56 flex-col items-center gap-4 text-center">
					<img src={asset('/pwa-icon-192.png')} alt="" class="size-12 rounded-xl" />
					<div><p class="text-sm font-semibold">Preparing the player</p><p class="mt-1 text-[11px] text-overlay1">Starting the iroh client…</p></div>
					<div class="h-1 w-full overflow-hidden bg-surface0"><div class="h-full w-1/2 animate-pulse bg-mauve"></div></div>
				</div>
			</div>
		{/snippet}

		{#snippet failed(error, reset)}
			<div class="grid h-dvh place-items-center bg-base p-6 text-text"><div class="w-full max-w-sm border border-red/40 bg-crust p-5 text-center"><h1 class="text-sm font-semibold text-red">The player could not start</h1><p class="mt-2 break-words text-xs leading-5 text-overlay1">{String(error)}</p><button type="button" onclick={reset} class="mt-4 bg-mauve px-4 py-2 font-mono text-[10px] font-bold text-crust">RETRY</button></div></div>
		{/snippet}
	</svelte:boundary>
</div>
