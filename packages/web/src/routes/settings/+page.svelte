<script>
	import { MusicClient } from '@iroh-fm/client';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { App } from '$lib/runes/App.svelte.js';
	import { cleanRelays, formatBytes, friendlyError } from '$lib/utils.js';
	import Icon from '../Icon.svelte';

	let settings = $state({
		ticket: App.connection.ticket,
		endpoint: App.connection.endpoint,
		relays: [...App.connection.relays],
		secret: App.connection.secret,
		starredKey: App.starredKey,
		showSecret: false,
		storage: {
			loading: true,
			requesting: false,
			tracks: 0,
			trackSize: 0,
			covers: 0,
			coverSize: 0,
			usage: 0,
			quota: 0,
			persisted: false,
			supported: false
		}
	});
	let ticketParseGeneration = 0;
	let endpointCopied = $state(false);
	let draftEndpointId = $derived(settings.secret.trim() ? MusicClient.endpointIdForSecret(settings.secret.trim()) : Promise.resolve(''));

	function initialize() {
		refreshStorageInfo();
		if (settings.ticket.trim()) syncTicketAddress(settings.ticket);
	}

	/** @param {string} value */
	function updateTicket(value) {
		settings.ticket = value;
		settings.endpoint = '';
		settings.relays = [''];
		syncTicketAddress(value);
	}

	/** @param {string} value */
	async function syncTicketAddress(value) {
		const generation = ++ticketParseGeneration;
		if (!value.trim()) return;
		try {
			const address = await MusicClient.parseTicket(value.trim());
			if (generation !== ticketParseGeneration) return;
			settings.endpoint = address.endpointId;
			settings.relays = address.relays.length ? address.relays : [''];
		} catch {
			// Keep the editor ready while the user is typing.
		}
	}

	function addRelay() {
		settings.relays.push('');
	}

	/** @param {number} index */
	function removeRelay(index) {
		settings.relays.splice(index, 1);
		if (!settings.relays.length) settings.relays.push('');
	}

	async function refreshStorageInfo() {
		const storage = settings.storage;
		storage.loading = true;
		storage.supported = Boolean(navigator.storage);
		try {
			const [cacheStats, estimate, persisted] = await Promise.all([
				App.connection.client?.cacheStats() ?? MusicClient.cacheStats(),
				navigator.storage?.estimate?.() ?? Promise.resolve({}),
				navigator.storage?.persisted?.() ?? Promise.resolve(false)
			]);
			Object.assign(storage, {
				loading: false,
				tracks: cacheStats.tracks.count,
				trackSize: cacheStats.tracks.size,
				covers: cacheStats.covers.count,
				coverSize: cacheStats.covers.size,
				usage: estimate.usage ?? 0,
				quota: estimate.quota ?? 0,
				persisted
			});
		} catch (error) {
			console.warn('[storage] could not read cache statistics', error);
			storage.loading = false;
		}
	}

	async function requestPersistentStorage() {
		if (!navigator.storage?.persist) return;
		settings.storage.requesting = true;
		try {
			await navigator.storage.persist();
		} finally {
			settings.storage.requesting = false;
			await refreshStorageInfo();
		}
	}

	async function save() {
		if (!(settings.endpoint.trim() ? cleanRelays(settings.relays).length : settings.ticket.trim()) || App.connection.connecting) return;
		let secret = settings.secret.trim();
		try {
			if (secret) App.connection.clientEndpointId = await draftEndpointId;
			else {
				const identity = await MusicClient.generateIdentity();
				secret = identity.secret;
				App.connection.clientEndpointId = identity.endpointId;
			}
		} catch (error) {
			App.connection.error = friendlyError(error, 'The client secret is invalid.');
			return;
		}
		App.connection.ticket = settings.ticket.trim();
		App.connection.endpoint = settings.endpoint.trim();
		App.connection.relays = [...settings.relays];
		App.connection.secret = secret;
		App.starredKey = settings.starredKey.trim();
		if (App.starredKey) localStorage.setItem('iroh-fm-starred-key', App.starredKey);
		else localStorage.removeItem('iroh-fm-starred-key');
		localStorage.removeItem('iroh-fm-loved-key');
		if (await App.connection.connect()) await goto(resolve('/tracks'));
	}

	async function copyDraftEndpoint() {
		try {
			const endpointId = await draftEndpointId;
			if (!endpointId) return;
			await navigator.clipboard.writeText(endpointId);
			endpointCopied = true;
			setTimeout(() => (endpointCopied = false), 1600);
		} catch (error) {
			App.connection.error = friendlyError(error, 'Could not copy the client endpoint ID.');
		}
	}
</script>

<section {@attach initialize} class="h-full overflow-y-auto bg-base text-text">
	<form onsubmit={(event) => { event.preventDefault(); save(); }} class="mx-auto flex min-h-full w-full max-w-3xl flex-col">
		<div class="flex shrink-0 items-center justify-between border-b border-surface0 bg-mantle px-5 py-4"><div><p class="font-mono text-[10px] uppercase tracking-[.16em] text-overlay0">Connection</p><h1 class="mt-1 text-lg font-semibold">Client settings</h1></div><a href={resolve('/tracks')} class="grid size-8 place-items-center text-overlay1 hover:bg-surface0 hover:text-text" aria-label="Close settings"><Icon name="close" size={16}/></a></div>

		<div class="flex-1 space-y-5 p-5">
			<div><label for="settings-ticket" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label><textarea id="settings-ticket" value={settings.ticket} oninput={(event) => updateTicket(event.currentTarget.value)} rows="3" spellcheck="false" autocomplete="off" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 outline-none focus:border-mauve"></textarea></div>
			<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>manual address override<span class="h-px flex-1 bg-surface0"></span></div>
			<div><label for="settings-endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="settings-endpoint" bind:value={settings.endpoint} spellcheck="false" autocomplete="off" placeholder="Leave empty to use ticket" class="h-11 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
			<div><div class="mb-2 flex items-center justify-between"><label for="settings-relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={addRelay} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each settings.relays as relayUrl, index}<div class="relative"><input id={`settings-relay-${index}`} bind:value={settings.relays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if settings.relays.length > 1}<button type="button" onclick={() => removeRelay(index)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div></div>
			<div>
				<label for="settings-secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label>
				<div class="relative"><input id="settings-secret" bind:value={settings.secret} type={settings.showSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (settings.showSecret = !settings.showSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{settings.showSecret ? 'HIDE' : 'SHOW'}</button></div>
				<div class="mt-3">
					<svelte:boundary>
						<div class="mb-2 flex items-center justify-between gap-3"><p class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client endpoint ID</p><button type="button" onclick={copyDraftEndpoint} disabled={!settings.secret.trim()} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="copy" size={12}/>{endpointCopied ? 'COPIED' : 'COPY'}</button></div>
						<code class="block break-all font-mono text-[11px] leading-5 text-subtext0">{settings.secret.trim() ? await draftEndpointId : 'Generated automatically when settings are saved'}</code>
						{#snippet pending()}<code class="block font-mono text-[11px] leading-5 text-overlay0">Calculating endpoint ID…</code>{/snippet}
						{#snippet failed()}<code class="block font-mono text-[11px] leading-5 text-red">Invalid client secret</code>{/snippet}
					</svelte:boundary>
				</div>
			</div>
			<div><label for="settings-starred-key" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Starred collection key</label><input id="settings-starred-key" bind:value={settings.starredKey} spellcheck="false" autocomplete="off" placeholder="Default: this client identity" class="h-11 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/><p class="mt-1.5 text-[10px] leading-4 text-overlay0">Leave empty for a private collection tied to the Client Endpoint ID. Use the same custom key on multiple clients to share one collection.</p></div>

			<section aria-labelledby="storage-title">
				<div class="flex items-center justify-between gap-3"><div><p id="storage-title" class="font-mono text-[9px] uppercase tracking-[.14em] text-overlay0">Offline cache</p><p class="mt-1 text-[10px] text-overlay1">Played and prefetched tracks are reused across visits.</p></div><button type="button" onclick={refreshStorageInfo} disabled={settings.storage.loading} class="shrink-0 font-mono text-[9px] text-mauve hover:text-pink disabled:opacity-40">{settings.storage.loading ? 'READING…' : 'REFRESH'}</button></div>
				<div class="mt-3 grid grid-cols-2 divide-x divide-surface0"><div class="pr-3"><p class="font-mono text-[9px] uppercase text-overlay0">Tracks</p><p class="mt-1 text-xs text-text">{settings.storage.tracks} · {formatBytes(settings.storage.trackSize)}</p></div><div class="pl-3"><p class="font-mono text-[9px] uppercase text-overlay0">Covers</p><p class="mt-1 text-xs text-text">{settings.storage.covers} · {formatBytes(settings.storage.coverSize)}</p></div></div>
				<div class="mt-3 flex items-center justify-between gap-3 border-t border-surface0 pt-3"><div class="min-w-0"><p class="text-[10px] text-subtext0">Browser storage: {formatBytes(settings.storage.usage)} / {formatBytes(settings.storage.quota)}</p><p class="mt-1 text-[9px] text-overlay0">{settings.storage.persisted ? 'Persistent storage granted; the browser should not evict this cache automatically.' : 'Storage may be evicted under pressure. Browser quota is managed automatically.'}</p></div>{#if settings.storage.supported && !settings.storage.persisted}<button type="button" onclick={requestPersistentStorage} disabled={settings.storage.requesting} class="shrink-0 border border-mauve px-2 py-1.5 font-mono text-[9px] text-mauve hover:bg-mauve hover:text-crust disabled:opacity-40">{settings.storage.requesting ? 'REQUESTING…' : 'KEEP OFFLINE'}</button>{/if}</div>
			</section>
			<div class="flex items-start justify-between gap-4 text-[11px] leading-5 text-overlay1"><p>Credentials stay in this browser's localStorage. Saving restarts the iroh connection.</p><p class="shrink-0 font-mono text-[9px] text-overlay0" title="Application build commit">BUILD {__BUILD_COMMIT__}</p></div>
		</div>

			<div class="sticky bottom-0 flex shrink-0 justify-end gap-2 border-t border-surface0 bg-mantle px-5 py-3"><a href={resolve('/tracks')} class="border border-surface1 px-4 py-2 font-mono text-[10px] text-subtext0 hover:bg-surface0">CANCEL</a><button type="submit" disabled={!(settings.endpoint.trim() ? cleanRelays(settings.relays).length : settings.ticket.trim()) || App.connection.connecting} class="bg-mauve px-4 py-2 font-mono text-[10px] font-bold text-crust hover:bg-pink disabled:opacity-40">SAVE & RECONNECT</button></div>
	</form>
</section>
