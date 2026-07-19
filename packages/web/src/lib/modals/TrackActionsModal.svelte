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
	 * @property {import('$lib/runes/Track.svelte.js').Track} track
	 */
	/** @type {Props} */
	let { dismiss, track } = $props();

	async function toggleStar() {
		dismiss();
		await App.library.toggleStar(track);
	}

	function cache() {
		dismiss();
		void App.library.cacheTrack(track);
	}
</script>

<div class="fixed inset-0 z-[100] grid place-items-center bg-crust/75 p-4 backdrop-blur-sm" role="presentation" onclick={() => dismiss()} oncontextmenu={(event) => event.preventDefault()}>
	<div {@attach focusModal} role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="track-actions-title" class="min-w-0 w-full max-w-md overflow-hidden border border-surface1 bg-crust p-2 shadow-float" onclick={(event) => event.stopPropagation()} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') dismiss(); }}>
		<div class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-4 border-b border-surface0 p-3">
			<Cover client={App.connection.client} id={track.cover_art_id} title={track.album} class="size-24 shrink-0 rounded-sm" />
			<div class="min-w-0 overflow-hidden self-center"><p id="track-actions-title" class="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-text" title={track.title}>{track.title}</p><p class="mt-1 truncate text-xs text-mauve">{track.artist}</p><p class="mt-1 truncate text-[11px] text-overlay1">{track.album}</p><p class="mt-2 font-mono text-[10px] text-overlay0">{formatTime(track.duration_seconds)} · {formatBytes(track.file_size)}</p></div>
		</div>
		<button type="button" onclick={toggleStar} class="flex w-full items-center gap-3 px-3 py-3 text-left text-xs text-subtext0 hover:bg-surface0 hover:text-text"><HeartIcon class="text-[15px]"/>{App.library.starredTrackIds.has(track.id) ? 'Unstar' : 'Star'}</button>
		<button type="button" onclick={cache} disabled={App.library.offlineOnly || track.cached || track.downloading} class="flex w-full items-center gap-3 px-3 py-3 text-left text-xs text-subtext0 hover:bg-surface0 hover:text-text disabled:text-overlay0"><DownloadIcon class="text-[15px]"/>{track.cached ? 'Cached' : track.downloading ? 'Downloading…' : App.library.offlineOnly ? 'Unavailable offline' : 'Download'}</button>
	</div>
</div>
