<script>
	import { App } from '$lib/runes/App.svelte.js';
	import { focusModal } from './index.js';
	import { formatBytes, formatTime } from '$lib/utils.js';
	import DownloadIcon from 'virtual:icons/ri/download-line';
	import HeartIcon from 'virtual:icons/ri/heart-line';
	import Cover from '../../routes/Cover.svelte';

	/**
	 * @typedef {Object} Props
	 * @property {(result?: unknown) => void} dismiss
	 * @property {import('$lib/types').AlbumData | null | undefined} album
	 * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
	 * @property {string} title
	 * @property {string} cacheKey
	 */
	/** @type {Props} */
	let { dismiss, album, tracks, title, cacheKey } = $props();
	let cached = $derived(tracks.every((track) => track.cached));
	let starred = $derived(Boolean(album && App.library.starred.albums.some((item) => item.id === album?.id)));
	let duration = $derived(tracks.reduce((total, track) => total + (track.duration_seconds ?? 0), 0));
	let size = $derived(tracks.reduce((total, track) => total + (track.file_size ?? 0), 0));

	async function toggleStar() {
		dismiss();
		await App.library.toggleStarAlbum(album);
	}

	function cache() {
		dismiss();
		void App.library.cacheAlbum(tracks, cacheKey);
	}
</script>

<div class="fixed inset-0 z-[100] grid place-items-center bg-crust/75 p-4 backdrop-blur-sm" role="presentation" onclick={() => dismiss()} oncontextmenu={(event) => event.preventDefault()}>
	<div {@attach focusModal} role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="album-actions-title" class="min-w-0 w-full max-w-md overflow-hidden border border-surface1 bg-crust p-2 shadow-float" onclick={(event) => event.stopPropagation()} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') dismiss(); }}>
		<div class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-4 border-b border-surface0 p-3">
			<Cover client={App.connection.client} id={album?.cover_art_id ?? tracks[0]?.cover_art_id} {title} class="size-24 shrink-0 rounded-sm" />
			<div class="min-w-0 overflow-hidden self-center"><p id="album-actions-title" class="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-text" title={title}>{title}</p><p class="mt-1 truncate text-xs text-mauve">{album?.album_artist ?? album?.artist ?? tracks[0]?.album_artist ?? tracks[0]?.artist}</p><p class="mt-2 font-mono text-[10px] leading-5 text-overlay0">{tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} · {formatTime(duration)}<br/>{formatBytes(size)}</p></div>
		</div>
		<button type="button" onclick={toggleStar} disabled={!album} class="flex w-full items-center gap-3 px-3 py-3 text-left text-xs text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0"><HeartIcon class="text-[15px]"/>{starred ? 'Unstar album' : 'Star album'}</button>
		<button type="button" onclick={cache} disabled={App.library.offlineOnly || cached || App.library.cachingAlbumIds.has(cacheKey)} class="flex w-full items-center gap-3 px-3 py-3 text-left text-xs text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0 {cached ? '!text-green' : ''}">{#if !cached}<DownloadIcon class="text-[15px]"/>{/if}{cached ? 'Album cached' : App.library.cachingAlbumIds.has(cacheKey) ? 'Downloading album…' : App.library.offlineOnly ? 'Unavailable offline' : 'Download album'}</button>
	</div>
</div>
