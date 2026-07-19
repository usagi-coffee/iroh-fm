<script>
	import { asset } from '$app/paths';
	import { App } from '$lib/runes/App.svelte.js';
	import { modal } from '$lib/ui/modal.js';
	import { friendlyError } from '$lib/utils.js';
	import Icon from './Icon.svelte';
	import QrScannerModal from './QrScannerModal.svelte';

	const DEMO_TRACKS = [
		['01', 'Nacre', 'Anywhere Between', 'Still Light', '3:42'],
		['02', 'Nacre', 'Glass Relay', 'Still Light', '4:16'],
		['03', 'Low Current', 'Soft Static', 'Night Index', '2:58'],
		['04', 'Low Current', 'Afterimage', 'Night Index', '5:02'],
		['05', 'Mallow', 'North Window', 'Domestic Signals', '3:31'],
		['06', 'Mallow', 'Parallel Lines', 'Domestic Signals', '4:14'],
		['07', 'Aster Vale', 'Folded Sky', 'Long Distance', '3:57'],
		['08', 'Aster Vale', 'Semaphore', 'Long Distance', '3:05'],
		['09', 'Quiet Form', 'Borrowed Color', 'Soft Focus', '4:24'],
		['10', 'Quiet Form', 'Room Tone', 'Soft Focus', '2:43'],
		['11', 'Paloma Wire', 'Overland', 'Signals', '4:01'],
		['12', 'Paloma Wire', 'Relay Bloom', 'Signals', '3:38']
	];
	const DEMO_ALBUMS = [
		['Still Light', 'Nacre', 'from-mauve/80 to-blue/30'],
		['Night Index', 'Low Current', 'from-teal/70 to-surface0'],
		['Domestic Signals', 'Mallow', 'from-peach/70 to-pink/20'],
		['Long Distance', 'Aster Vale', 'from-sapphire/70 to-mauve/20'],
		['Soft Focus', 'Quiet Form', 'from-green/60 to-teal/20'],
		['Signals', 'Paloma Wire', 'from-red/60 to-yellow/20']
	];
	let loginTab = $state('ticket');
	let showSecret = $state(false);
	let ticketLinkCopied = $state(false);
	let endpointCopied = $state(false);

	/** @param {'ticket' | 'advanced'} tab */
	function selectLoginTab(tab) {
		loginTab = tab;
		if (tab === 'advanced' && App.connection.ticket.trim()) void App.connection.syncTicketAddress(App.connection.ticket);
	}

	async function copyTicketLink() {
		if (!await App.connection.copyTicketLink()) return;
		ticketLinkCopied = true;
		setTimeout(() => (ticketLinkCopied = false), 1600);
	}

	async function copyEndpointId() {
		if (!await App.connection.copyEndpointId()) return;
		endpointCopied = true;
		setTimeout(() => (endpointCopied = false), 1600);
	}

	async function scanTicket() {
		try {
			const value = await modal(QrScannerModal, {});
			if (!value) return;
			App.connection.applyConnectionLink(App.connection.connectionFromScannedValue(value));
			if (loginTab === 'advanced' && App.connection.ticket.trim()) void App.connection.syncTicketAddress(App.connection.ticket);
		} catch (error) {
			App.connection.error = friendlyError(error, 'Could not open the QR scanner.');
		}
	}

</script>

<main class="relative h-dvh overflow-hidden bg-base text-text">
	<div class="absolute inset-0 hidden grid-rows-[34px_minmax(0,1fr)_72px] select-none opacity-65 sm:grid" aria-hidden="true">
		<header class="flex items-center border-b border-surface0 bg-crust text-[11px]"><div class="grid h-full w-10 shrink-0 place-items-center border-r border-surface0"><img src={asset('/pwa-icon-192.png')} alt="" class="size-6 rounded-md" /></div><span class="border-r border-surface0 bg-surface0 px-4 py-2 font-semibold">TRACKS</span><span class="px-4 font-semibold text-overlay1">STARRED</span><span class="ml-auto px-4 font-mono text-overlay0">REMOTE LIBRARY</span></header>
		<div class="grid min-h-0 grid-cols-[minmax(0,2fr)_minmax(330px,1fr)]">
			<section class="min-h-0 border-r border-surface0 bg-base"><div class="flex h-10 items-center gap-3 border-b border-surface0 bg-mantle px-3 text-overlay0"><Icon name="search" size={14}/><span class="font-mono text-xs">Filter artist, title, album…</span><span class="ml-auto font-mono text-[10px]">128 TRACKS</span></div><div class="grid h-7 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0"><span>#</span><span>Album</span><span>Title</span><span>Artist</span><span>Time</span></div>{#each DEMO_TRACKS as track}<div class="grid h-[30px] grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0/40 px-2 text-[11px]"><span class="font-mono text-overlay0">{track[0]}</span><span class="truncate pr-2 text-mauve">{track[3]}</span><span class="truncate pr-2 text-teal">{track[2]}</span><span class="truncate pr-2 text-subtext0">{track[1]}</span><span class="font-mono text-overlay0">{track[4]}</span></div>{/each}</section>
			<aside class="min-h-0 bg-mantle p-3"><div class="mb-3 flex h-7 items-center justify-between"><strong class="text-xs">ALBUMS</strong><span class="font-mono text-[10px] text-overlay0">24</span></div><div class="grid grid-cols-3 gap-x-3 gap-y-5">{#each DEMO_ALBUMS as album}<article class="min-w-0"><div class={`grid aspect-square place-items-center bg-gradient-to-br ${album[2]}`}><div class="grid size-1/2 place-items-center rounded-full border border-crust/20 bg-crust/25"><div class="size-2 rounded-full bg-text/50"></div></div></div><h3 class="mt-2 truncate text-[11px] font-semibold">{album[0]}</h3><p class="truncate text-[10px] text-overlay1">{album[1]}</p></article>{/each}</div></aside>
		</div>
		<footer class="border-t border-surface1 bg-crust"><div class="h-1 bg-surface0"><div class="h-full w-1/3 bg-mauve"></div></div><div class="grid h-[68px] grid-cols-[auto_1fr_auto] items-center gap-4 px-5"><div class="flex items-center gap-2 text-overlay1"><Icon name="previous" size={16}/><span class="grid size-10 place-items-center bg-text text-crust"><Icon name="play" size={14}/></span><Icon name="next" size={16}/></div><div><p class="text-xs font-semibold">Anywhere Between</p><p class="mt-1 text-[10px] text-overlay1">Nacre · Still Light</p></div><span class="font-mono text-[10px] text-overlay0">1:12 / 3:42</span></div></footer>
	</div>

	<div class="absolute inset-0 bg-crust sm:bg-crust/35 sm:backdrop-blur-[3px]"></div>
	<section class="absolute inset-0 z-10 grid place-items-center overflow-y-auto p-4 sm:p-8">
		<form onsubmit={(event) => { event.preventDefault(); App.connection.connect(loginTab === 'ticket'); }} class="my-auto w-[calc(100vw-2rem)] max-w-[29rem] border border-surface1 bg-base shadow-float">
			<div class="border-b border-surface0 bg-mantle px-5 pt-5">
				<div class="mb-5 flex items-center gap-3"><img src={asset('/pwa-icon-192.png')} alt="" class="size-9 rounded-lg" /><div><h1 class="text-[16px] font-semibold text-text">Enter your library</h1><p class="mt-0.5 text-[11px] text-overlay1">Connect privately with iroh</p></div></div>
				<div class="flex gap-5 font-mono text-[10px] font-bold uppercase tracking-wider"><button type="button" onclick={() => selectLoginTab('ticket')} class="border-b-2 pb-3 {loginTab === 'ticket' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Ticket</button><button type="button" onclick={() => selectLoginTab('advanced')} class="border-b-2 pb-3 {loginTab === 'advanced' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Advanced</button></div>
			</div>

			<div class="space-y-4 p-5">
				<div><div class="mb-2 flex items-center justify-between gap-3"><label for="ticket" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label><div class="flex items-center gap-3"><button type="button" onclick={copyTicketLink} disabled={!App.connection.ticket.trim()} title="Copy setup link including the client secret" class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="copy" size={12}/>{ticketLinkCopied ? 'COPIED' : 'COPY'}</button>{#if loginTab === 'ticket'}<button type="button" onclick={scanTicket} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink"><Icon name="qr" size={13}/> SCAN QR</button>{/if}</div></div><textarea id="ticket" value={App.connection.ticket} oninput={(event) => App.connection.updateLoginTicket(event.currentTarget.value, loginTab === 'advanced')} rows={loginTab === 'ticket' ? 3 : 2} spellcheck="false" autocomplete="off" placeholder="endpointaa…" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 text-text outline-none placeholder:text-overlay0 focus:border-mauve"></textarea></div>

				{#if loginTab === 'advanced'}
					<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>or manual address<span class="h-px flex-1 bg-surface0"></span></div>
					<div><label for="endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="endpoint" bind:value={App.connection.endpoint} spellcheck="false" autocomplete="off" placeholder="Public endpoint ID" class="h-10 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
					<div><div class="mb-2 flex items-center justify-between"><label for="relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={() => App.connection.addRelay()} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each App.connection.relays as relayUrl, index}<div class="relative"><input id={`relay-${index}`} bind:value={App.connection.relays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if App.connection.relays.length > 1}<button type="button" onclick={() => App.connection.removeRelay(index)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div><p class="mt-1.5 text-[10px] text-overlay0">Valid tickets fill this address automatically. You can still edit it manually.</p></div>
					<div><label for="secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label><div class="relative"><input id="secret" value={App.connection.secret} oninput={(event) => App.connection.updateIdentity(event.currentTarget.value)} type={showSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (showSecret = !showSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{showSecret ? 'HIDE' : 'SHOW'}</button></div></div>
				{/if}

				<div><div class="mb-2 flex items-center justify-between gap-3"><p class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client endpoint ID</p><div class="flex items-center gap-3"><button type="button" onclick={() => App.connection.generateIdentity()} disabled={App.connection.identityLoading || App.connection.connecting} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="refresh" size={12}/>GENERATE</button><button type="button" onclick={copyEndpointId} disabled={!App.connection.clientEndpointId} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="copy" size={12}/>{endpointCopied ? 'COPIED' : 'COPY'}</button></div></div><div class="border border-surface0 bg-mantle/70 px-3 py-2.5"><code class="block truncate text-[10px] text-subtext0">{App.connection.identityLoading ? 'Generating secure identity…' : App.connection.clientEndpointId || 'Invalid client secret'}</code></div></div>

				{#if App.connection.error}<div class="border-l-2 border-red bg-red/10 px-3 py-2 text-xs leading-5 text-red"><strong>Connection failed.</strong> {App.connection.error}</div>{/if}
				<button type="submit" disabled={!App.connection.canConnect(loginTab === 'ticket') || App.connection.connecting || App.connection.identityLoading} class="flex h-11 w-full items-center justify-center gap-3 bg-mauve font-mono text-xs font-bold tracking-wide text-crust transition hover:bg-pink disabled:cursor-not-allowed disabled:opacity-40">{#if App.connection.connecting}<span class="size-3 animate-spin rounded-full border-2 border-crust/25 border-t-crust"></span>{App.connection.connectionStep}{:else}CONNECT <Icon name="arrow" size={15}/>{/if}</button>
			</div>
		</form>
	</section>

</main>
