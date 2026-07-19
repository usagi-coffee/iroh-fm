<script>
	import { VList } from 'virtua/svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import AlbumActionsModal from '$lib/modals/AlbumActionsModal.svelte';
	import { modal } from '$lib/modals/index.js';
	import TrackActionsModal from '$lib/modals/TrackActionsModal.svelte';
	import { App } from '$lib/runes/App.svelte.js';
	import { longPress } from '$lib/ui/long-press.js';
	import { formatTime, friendlyError } from '$lib/utils.js';
	import HeartIcon from 'virtual:icons/ri/heart-line';
	import PauseIcon from 'virtual:icons/ri/pause-fill';
	import PlayIcon from 'virtual:icons/ri/play-fill';
	import SearchIcon from 'virtual:icons/ri/search-line';
	import Cover from './Cover.svelte';

	/**
	 * @typedef {Object} Props
	 * @property {import('$lib/runes/Track.svelte.js').Track[]} tracks
	 * @property {import('$lib/types').TrackListItem[]} items
	 * @property {string} query
	 * @property {(value: string) => void} onquery
	 */
	/** @type {Props} */
	let { tracks, items, query, onquery } = $props();
	const ROW_HEIGHT = 30;
	const BUFFER_SIZE = ROW_HEIGHT * 60;
	const COVER_MARGIN = '1400px';

	/** @param {import('$lib/runes/Track.svelte.js').Track} track @param {MouseEvent} [event] */
	function openTrackActions(track, event) {
		event?.preventDefault();
		event?.stopPropagation();
		void modal(TrackActionsModal, { track }).catch((error) => (App.connection.error = friendlyError(error, 'Could not open track actions.')));
	}

	/** @param {import('$lib/types').AlbumData | undefined} album @param {import('$lib/runes/Track.svelte.js').Track[]} albumTracks @param {string} title @param {string} cacheKey @param {MouseEvent} [event] */
	function openAlbumActions(album, albumTracks, title, cacheKey, event) {
		event?.preventDefault();
		event?.stopPropagation();
		void modal(AlbumActionsModal, { album, tracks: albumTracks, title, cacheKey }).catch((error) => (App.connection.error = friendlyError(error, 'Could not open album actions.')));
	}

	/** @param {HTMLElement} host */
	function focusRequestedTrack(host) {
		const trackId = page.state.focusTrackId;
		if (!trackId) return;
		const index = items.findIndex((item) => item.kind === 'track' && item.track.id === trackId);
		if (index < 0) return;
		let attempts = 3;
		/** @type {number | undefined} */
		let frame;
		const scroll = () => {
			const viewport = host.firstElementChild;
			if (!(viewport instanceof HTMLElement)) {
				if (attempts-- > 0) frame = requestAnimationFrame(scroll);
				return;
			}
			const top = index * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2;
			viewport.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
			replaceState(page.url, {});
		};
		frame = requestAnimationFrame(scroll);
		return () => {
			if (frame) cancelAnimationFrame(frame);
		};
	}
</script>

<section class="flex min-h-0 flex-col bg-base">
	<div class="flex h-10 shrink-0 items-center gap-3 border-b border-surface0 bg-mantle px-3">
		<SearchIcon class="text-sm"/>
		<input value={query} oninput={(event) => onquery(event.currentTarget.value)} placeholder="Filter artist, title, album…" class="min-w-0 flex-1 bg-transparent font-mono text-xs text-text outline-none placeholder:text-overlay0"/>
		<span class="shrink-0 font-mono text-[10px] text-overlay0">{tracks.length} / {App.library.summary.track_count}</span>
	</div>

	<div class="hidden h-7 shrink-0 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0 sm:grid"><span>#</span><span>Album</span><span>Title</span><span>Artist</span><span class="text-right">Time</span></div>

	<div class="min-h-0 flex-1" {@attach focusRequestedTrack}>
		<VList data={items} getKey={(item) => item.key} itemSize={ROW_HEIGHT} bufferSize={BUFFER_SIZE} style="height: 100%; overscroll-behavior: contain;">
			{#snippet children(item)}
				{#if item.kind === 'album'}
					<button {@attach longPress(() => openAlbumActions(item.album, item.tracks, item.title, item.album?.id ?? item.key))} type="button" onclick={() => App.player.play(item.tracks[0], item.tracks)} oncontextmenu={(event) => openAlbumActions(item.album, item.tracks, item.title, item.album?.id ?? item.key, event)} class="flex h-[30px] w-full items-center gap-2 border-y border-surface1 bg-mantle px-2 text-left transition hover:bg-surface0" aria-label={`Play album ${item.title}`}>
						<Cover client={App.connection.client} id={item.coverArtId} title={item.title} rootMargin={COVER_MARGIN} class="size-7 shrink-0 rounded-sm" />
						<p class="min-w-0 flex-1 truncate text-[11px]"><span class="font-semibold text-mauve">{item.title}</span><span class="ml-2 text-[10px] text-overlay1">{item.artist}</span></p>
						<span class="shrink-0 font-mono text-[10px] text-overlay0">{formatTime(item.durationSeconds)}</span>
					</button>
				{:else}
					<div {@attach longPress(() => openTrackActions(item.track))} role="row" tabindex="0" aria-selected={App.library.selectedTrackId === item.track.id} onclick={() => (App.library.selectedTrackId = item.track.id)} ondblclick={() => App.player.playFromTrackList(item.track, tracks)} oncontextmenu={(event) => openTrackActions(item.track, event)} onkeydown={(event) => { if (event.key === 'Enter') App.player.playFromTrackList(item.track, tracks); else if (event.key === ' ') { event.preventDefault(); App.library.selectedTrackId = item.track.id; } }} class="group grid grid-cols-[2rem_minmax(0,1fr)_3.2rem] items-center border-b border-surface0/35 px-2 text-[11px] transition outline-none focus:ring-1 focus:ring-inset focus:ring-mauve sm:grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] {App.player.currentTrack?.id === item.track.id ? 'bg-mauve/15' : App.library.selectedTrackId === item.track.id ? 'bg-surface0' : 'hover:bg-surface0/60'}" style={`height:${ROW_HEIGHT}px`}>
						<button type="button" onclick={(event) => { event.stopPropagation(); App.player.playFromTrackList(item.track, tracks); }} class="grid size-6 place-items-center font-mono text-[10px] text-overlay0 hover:text-mauve" aria-label={`Play ${item.track.title}`}>
							{#if item.track.downloading}
								<span class="h-1 w-4 overflow-hidden bg-surface1"><span class="block h-full bg-mauve transition-[width] duration-150" style={`width:${item.track.progress * 100}%`}></span></span>
							{:else if App.player.currentTrack?.id === item.track.id && App.player.playing}
								<PauseIcon class="text-[11px]"/>
							{:else if item.track.cached}
								<span class="text-green" title="Cached">{item.track.track_number || item.trackIndex + 1}</span>
							{:else}
								<span class="group-hover:hidden">{item.track.track_number || item.trackIndex + 1}</span><span class="hidden group-hover:block"><PlayIcon class="text-[10px]"/></span>
							{/if}
						</button>
						<div class="hidden min-w-0 truncate pr-2 text-mauve sm:block">{item.track.album}</div>
						<div class="flex min-w-0 items-center gap-2 pr-2"><span class="truncate text-teal">{item.track.title}</span><button type="button" onclick={(event) => App.library.toggleStar(item.track, event)} class="ml-auto hidden shrink-0 text-overlay0 group-hover:block hover:text-pink {App.library.starredTrackIds.has(item.track.id) ? '!block text-pink' : ''}" aria-label="Toggle favorite"><HeartIcon class="text-[11px]"/></button><span class="truncate text-[9px] text-overlay0 sm:hidden"> · {item.track.artist}</span></div>
						<div class="hidden min-w-0 truncate pr-2 text-subtext0 sm:block">{item.track.artist}</div>
						<div class="text-right font-mono text-[10px] text-overlay0">{formatTime(item.track.duration_seconds)}</div>
					</div>
				{/if}
			{/snippet}
		</VList>
	</div>
</section>
