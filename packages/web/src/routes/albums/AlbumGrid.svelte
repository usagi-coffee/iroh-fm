<script>
	import { VList } from 'virtua/svelte';
	import AlbumActionsModal from '$lib/modals/AlbumActionsModal.svelte';
	import { modal } from '$lib/modals/index.js';
	import { App } from '$lib/runes/App.svelte.js';
	import { longPress } from '$lib/ui/long-press.js';
	import { friendlyError } from '$lib/utils.js';
	import CachedIcon from 'virtual:icons/ri/check-line';
	import DownloadIcon from 'virtual:icons/ri/download-line';
	import HeartIcon from 'virtual:icons/ri/heart-line';
	import PlayIcon from 'virtual:icons/ri/play-fill';
	import Cover from '../Cover.svelte';

	/** @typedef {{ albums: import('$lib/types').AlbumData[] }} Props */
	/** @type {Props} */
	let { albums } = $props();
	const ALBUM_MIN_WIDTH = 125;
	const ALBUM_GAP = 12;
	let columns = $state(3);
	let rows = $derived.by(() => {
		/** @type {import('$lib/types').AlbumData[][]} */
		const grouped = [];
		for (let index = 0; index < albums.length; index += columns) grouped.push(albums.slice(index, index + columns));
		return grouped;
	});

	/** @param {HTMLElement} node */
	function measureColumns(node) {
		/** @param {number} width */
		const update = (width) => {
			if (width <= 0) return;
			const available = Math.max(0, width - 24);
			columns = Math.max(1, Math.floor((available + ALBUM_GAP) / (ALBUM_MIN_WIDTH + ALBUM_GAP)));
		};
		update(node.clientWidth);
		const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
		observer.observe(node);
		return () => observer.disconnect();
	}

	/** @param {import('$lib/types').AlbumData} album @param {MouseEvent} [event] */
	function openActions(album, event) {
		event?.preventDefault();
		event?.stopPropagation();
		void modal(AlbumActionsModal, {
			album,
			tracks: App.library.tracksForAlbum(album),
			title: album.title,
			cacheKey: album.id
		}).catch((error) => (App.connection.error = friendlyError(error, 'Could not open album actions.')));
	}

	/** @param {import('$lib/types').AlbumData} album @param {MouseEvent} event */
	function cacheAlbum(album, event) {
		event.stopPropagation();
		void App.library.cacheAlbum(App.library.tracksForAlbum(album), album.id);
	}

	/** @param {import('$lib/types').AlbumData} album @param {MouseEvent} event */
	function starAlbum(album, event) {
		event.stopPropagation();
		void App.library.toggleStarAlbum(album);
	}
</script>

<section class="flex min-h-0 flex-col bg-mantle">
	<div class="flex h-10 shrink-0 items-center border-b border-surface0 px-3"><strong class="text-xs">ALBUMS</strong><span class="ml-2 font-mono text-[10px] text-overlay0">{rows.flat().length}{#if App.library.offlineOnly} / {App.library.albums.length}{/if}</span></div>
	<div {@attach measureColumns} class="min-h-0 flex-1">
		<VList data={rows} getKey={(row) => `${columns}:${row.map((album) => album.id).join('|')}`} bufferSize={400} style="height: 100%; overscroll-behavior: contain;">
			{#snippet children(row, rowIndex)}
				<div class="grid gap-3 px-3 pb-5" class:pt-3={rowIndex === 0} style={`grid-template-columns:repeat(${columns},minmax(0,1fr))`}>
					{#each row as album (album.id)}
						<article {@attach longPress(() => openActions(album))} oncontextmenu={(event) => openActions(album, event)} class="group min-w-0">
							<div class="relative border-2 border-transparent bg-base transition hover:border-surface2">
								<button type="button" onclick={() => App.library.activateAlbum(album)} ondblclick={() => App.player.playAlbum(album)} class="block w-full"><Cover client={App.connection.client} id={album.cover_art_id} title={album.title} class="w-full" /></button>
								<div class="absolute bottom-2 left-2 flex items-center gap-1.5">
									<button type="button" onclick={(event) => starAlbum(album, event)} class="grid size-7 place-items-center rounded-full bg-crust/85 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 hover:bg-crust hover:text-pink {App.library.starred.albums.some((item) => item.id === album.id) ? 'pointer-events-auto translate-y-0 text-pink opacity-100' : 'pointer-events-none translate-y-1 text-subtext0 opacity-0'}" title={App.library.starred.albums.some((item) => item.id === album.id) ? 'Unstar album' : 'Star album'}><HeartIcon class="text-[13px]"/></button>
									<button type="button" onclick={(event) => cacheAlbum(album, event)} disabled={App.library.offlineOnly || album.track_ids.every((id) => App.library.cachedTrackIds.has(id)) || App.library.cachingAlbumIds.has(album.id)} class="pointer-events-none grid size-7 translate-y-1 place-items-center rounded-full bg-crust/85 text-subtext0 opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 hover:bg-crust hover:text-mauve disabled:cursor-default {album.track_ids.every((id) => App.library.cachedTrackIds.has(id)) ? '!text-green' : ''} {App.library.cachingAlbumIds.has(album.id) ? 'animate-pulse text-mauve' : ''}" title={album.track_ids.every((id) => App.library.cachedTrackIds.has(id)) ? 'Album cached' : App.library.cachingAlbumIds.has(album.id) ? 'Downloading album' : 'Download album'}>{#if album.track_ids.every((id) => App.library.cachedTrackIds.has(id))}<CachedIcon class="text-[13px]"/>{:else}<DownloadIcon class="text-[13px]"/>{/if}</button>
								</div>
								<button type="button" onclick={() => App.library.playAndSelectAlbum(album)} class="pointer-events-none absolute bottom-2 right-2 grid size-8 translate-y-1 place-items-center rounded-full bg-mauve text-crust opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100"><PlayIcon class="text-[13px]"/></button>
							</div>
							<button type="button" onclick={() => App.library.activateAlbum(album)} ondblclick={() => App.player.playAlbum(album)} class="mt-2 block w-full text-left"><h3 class="truncate text-[11px] font-semibold text-text">{album.title}</h3><p class="mt-0.5 truncate text-[10px] text-overlay1">{album.album_artist || album.artist}</p></button>
						</article>
					{/each}
				</div>
			{/snippet}
		</VList>
	</div>
</section>
