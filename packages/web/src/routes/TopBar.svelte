<script>
	import { asset, resolve } from '$app/paths';
	import { page } from '$app/state';
	import ConfirmModal from '$lib/modals/ConfirmModal.svelte';
	import { modal } from '$lib/modals/index.js';
	import { App } from '$lib/runes/App.svelte.js';
	import { connectionAddressLabel, formatBytes, friendlyError } from '$lib/utils.js';
	import DisconnectIcon from 'virtual:icons/ri/logout-box-r-line';
	import OfflineIcon from 'virtual:icons/ri/wifi-off-line';
	import RefreshIcon from 'virtual:icons/ri/refresh-line';
	import SettingsIcon from 'virtual:icons/ri/settings-3-line';

	/** @typedef {{ updateReady: boolean, onupdate: () => void }} Props */
	/** @type {Props} */
	let { updateReady, onupdate } = $props();
	let path = $derived(page.url.pathname.replace(/\/$/, ''));

	async function confirmDisconnect() {
		try {
			const confirmed = await modal(ConfirmModal, {
				title: 'Leave this library?',
				message: 'Playback will stop and you will return to the connection screen.',
				confirmLabel: 'DISCONNECT',
				cancelLabel: 'CANCEL',
				eyebrow: 'Disconnect',
				danger: true
			});
			if (confirmed) await App.connection.disconnect();
		} catch (error) {
			App.connection.error = friendlyError(error, 'Could not open the disconnect dialog.');
		}
	}
</script>

<header class="flex min-w-0 items-center border-b border-surface0 bg-crust text-[11px]">
	<a href={resolve('/tracks')} class="grid h-full w-10 shrink-0 place-items-center border-r border-surface0"><img src={asset('/pwa-icon-192.png')} alt="iroh.fm" class="size-6" /></a>
	<nav class="flex h-full min-w-0 items-stretch">
		<a href={resolve('/tracks')} class="grid place-items-center whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {path.endsWith('/tracks') ? 'bg-surface0 text-text' : 'text-overlay1'}">TRACKS</a>
		<a href={resolve('/albums')} class="grid place-items-center whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {path.endsWith('/albums') ? 'bg-surface0 text-text' : 'text-overlay1'}">ALBUMS</a>
		<a href={resolve('/starred')} class="grid place-items-center whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {path.endsWith('/starred') ? 'bg-surface0 text-pink' : 'text-overlay1'}">STARRED</a>
	</nav>
	<div class="ml-auto flex h-full min-w-0 items-center">
		<div class="hidden h-full min-w-0 items-center gap-2 border-l border-surface0 px-3 font-mono text-[9px] text-overlay1 lg:flex" title={`${App.connection.info.path_type}: ${App.connection.info.address || 'selecting path'} · ${formatBytes(App.connection.info.received_bytes)} received`}><span class="size-1.5 shrink-0 rounded-full {App.connection.info.address ? 'bg-green' : 'animate-pulse bg-yellow'}"></span><span class="max-w-44 truncate text-subtext0">{connectionAddressLabel(App.connection.info)}</span><span class="shrink-0 text-overlay0">↓ {formatBytes(App.connection.info.received_bytes)}</span></div>
		{#if updateReady}<button type="button" onclick={onupdate} class="grid h-full w-9 place-items-center border-l border-surface0 bg-mauve/15 text-mauve hover:bg-mauve hover:text-crust" title="Update ready" aria-label="Install application update"><RefreshIcon class="text-[15px]"/></button>{/if}
		<button type="button" onclick={() => App.library.toggleOfflineOnly()} class="grid h-full w-9 place-items-center border-l border-surface0 hover:bg-surface0 {App.library.offlineOnly ? 'bg-surface0 text-mauve' : 'text-overlay1 hover:text-mauve'}" title={App.library.offlineOnly ? 'Offline-only mode enabled' : 'Use cached music only'} aria-pressed={App.library.offlineOnly}><OfflineIcon class="text-[15px]"/></button>
		<a href={resolve('/settings')} class="grid h-full w-9 place-items-center border-l border-surface0 hover:bg-surface0 hover:text-mauve {path.endsWith('/settings') ? 'bg-surface0 text-mauve' : 'text-overlay1'}" title="Connection settings"><SettingsIcon class="text-[15px]"/></a>
		<button type="button" onclick={confirmDisconnect} class="grid h-full w-9 place-items-center border-l border-surface0 text-overlay1 hover:bg-surface0 hover:text-red" title="Disconnect"><DisconnectIcon class="text-[15px]"/></button>
	</div>
</header>
