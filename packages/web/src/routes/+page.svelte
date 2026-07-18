<script>
	// @ts-nocheck
	import { MusicClient } from '@iroh-fm/client';
	import { onMount, tick } from 'svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let ticket = $state('');
	let rememberTicket = $state(true);
	let connecting = $state(false);
	let connectionStep = $state('Starting browser endpoint…');
	let connectionError = $state('');
	let client = $state(null);
	let summary = $state({ artist_count: 0, album_count: 0, track_count: 0 });
	let albums = $state([]);
	let artists = $state([]);
	let starred = $state({ artists: [], albums: [], tracks: [] });
	let starredIds = $state(new Set());
	let view = $state('home');
	let selectedAlbum = $state(null);
	let selectedArtist = $state(null);
	let albumTracks = $state([]);
	let albumLoading = $state(false);
	let searchTerm = $state('');
	let searchResults = $state(null);
	let searchLoading = $state(false);
	let searchTimer;

	let audio = $state();
	let audioSrc = $state('');
	let audioSource = $state(null);
	let currentTrack = $state(null);
	let queue = $state([]);
	let playing = $state(false);
	let audioLoading = $state(false);
	let playerError = $state('');
	let currentTime = $state(0);
	let duration = $state(0);
	let volume = $state(0.8);
	let repeat = $state(false);
	let shuffle = $state(false);
	let playGeneration = 0;

	const featuredAlbums = $derived(albums.slice(0, 8));
	const favoriteAlbums = $derived(albums.filter((album) => starredIds.has(album.id)));
	const artistAlbums = $derived(selectedArtist
		? albums.filter((album) => album.artist === selectedArtist.name || album.album_artist === selectedArtist.name)
		: []);

	onMount(() => {
		ticket = localStorage.getItem('iroh-fm-ticket') ?? '';
	});

	function variant(response, key, fallback) {
		return response && key in response ? response[key] : fallback;
	}

	async function connect() {
		if (!ticket.trim() || connecting) return;
		connecting = true;
		connectionError = '';
		connectionStep = 'Loading the iroh WebAssembly client…';
		let nextClient;
		try {
			nextClient = await MusicClient.connect(ticket.trim());
			connectionStep = 'Reading your music library over iroh…';
			const data = await nextClient.bootstrap();
			client = nextClient;
			summary = variant(data.summary, 'LibrarySummary', summary);
			albums = variant(data.albums, 'Albums', []);
			artists = variant(data.artists, 'Artists', []);
			starred = variant(data.starred, 'Starred', starred);
			starredIds = new Set([
				...starred.artists.map((item) => item.id),
				...starred.albums.map((item) => item.id),
				...starred.tracks.map((item) => item.id)
			]);
			if (rememberTicket) localStorage.setItem('iroh-fm-ticket', ticket.trim());
			else localStorage.removeItem('iroh-fm-ticket');
		} catch (error) {
			await nextClient?.close().catch(() => {});
			connectionError = friendlyError(error, 'Could not reach this iroh-fm server.');
			client = null;
		} finally {
			connecting = false;
		}
	}

	async function disconnect() {
		clearTimeout(searchTimer);
		stopPlayback();
		const previous = client;
		client = null;
		selectedAlbum = null;
		searchResults = null;
		if (previous) await previous.close().catch(() => {});
	}

	function navigate(nextView) {
		view = nextView;
		if (nextView !== 'album') selectedAlbum = null;
		if (nextView !== 'artist') selectedArtist = null;
	}

	function desktopNavClass(active) {
		return `flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition ${active ? 'bg-white text-ink' : 'text-white/55 hover:bg-white/10 hover:text-white'}`;
	}

	function mobileNavClass(active) {
		return `flex flex-col items-center gap-1 px-4 py-1 text-[10px] ${active ? 'text-acid' : 'text-white/50'}`;
	}

	async function openAlbum(album) {
		selectedAlbum = album;
		view = 'album';
		albumTracks = [];
		albumLoading = true;
		try {
			const response = await client.request({ GetAlbumTracks: { album_id: album.id } });
			albumTracks = variant(response, 'Tracks', []);
		} catch (error) {
			connectionError = friendlyError(error, 'Could not load this album.');
		} finally {
			albumLoading = false;
		}
	}

	function openArtist(artist) {
		selectedArtist = artist;
		view = 'artist';
	}

	async function playAlbum(album) {
		if (selectedAlbum?.id !== album.id || albumTracks.length === 0) await openAlbum(album);
		if (albumTracks[0]) await playTrack(albumTracks[0], albumTracks);
	}

	async function toggleStar(item, kind, event) {
		event?.stopPropagation();
		const shouldStar = !starredIds.has(item.id);
		try {
			await client.request({ SetStarred: { id: item.id, starred: shouldStar } });
			const next = new Set(starredIds);
			if (shouldStar) next.add(item.id); else next.delete(item.id);
			starredIds = next;
			const key = `${kind}s`;
			starred = {
				...starred,
				[key]: shouldStar
					? [item, ...starred[key].filter((entry) => entry.id !== item.id)]
					: starred[key].filter((entry) => entry.id !== item.id)
			};
		} catch (error) {
			connectionError = friendlyError(error, 'Could not update favorites.');
		}
	}

	function queueSearch() {
		clearTimeout(searchTimer);
		if (searchTerm.trim().length < 2) {
			searchResults = null;
			searchLoading = false;
			return;
		}
		searchLoading = true;
		searchTimer = setTimeout(search, 280);
	}

	async function search() {
		const term = searchTerm.trim();
		if (term.length < 2) return;
		try {
			const response = await client.request({ Search: { query: { term, limit: 30 } } });
			if (term === searchTerm.trim()) searchResults = variant(response, 'SearchResults', null);
		} catch (error) {
			connectionError = friendlyError(error, 'Search failed.');
		} finally {
			searchLoading = false;
		}
	}

	async function playTrack(track, sourceQueue = [track]) {
		const generation = ++playGeneration;
		audio?.pause();
		audioSource?.dispose();
		audioSource = null;
		audioSrc = '';
		currentTrack = track;
		queue = sourceQueue;
		playerError = '';
		currentTime = 0;
		duration = track.duration_seconds || 0;
		audioLoading = true;
		playing = false;
		try {
			const source = await client.trackSource(track.id);
			if (generation !== playGeneration) {
				source.dispose();
				return;
			}
			audioSource = source;
			audioSrc = source.url;
			await tick();
			audio.load();
			await source.start();
			if (generation !== playGeneration) return;
			source.done.catch((error) => {
				if (audioSource === source && !source.disposed) {
					playerError = friendlyError(error, 'The audio stream was interrupted.');
				}
			});
			await audio.play();
		} catch (error) {
			if (generation === playGeneration) {
				audioSource?.dispose();
				audioSource = null;
				playerError = friendlyError(error, 'This track could not be played.');
			}
		} finally {
			if (generation === playGeneration) audioLoading = false;
		}
	}

	async function playOrToggle(track, sourceQueue) {
		if (currentTrack?.id === track.id && audioSource && !playerError) await togglePlayback();
		else await playTrack(track, sourceQueue);
	}

	function stopPlayback() {
		playGeneration += 1;
		audio?.pause();
		audioSource?.dispose();
		audioSource = null;
		audioSrc = '';
		currentTrack = null;
		queue = [];
		playing = false;
		currentTime = 0;
		duration = 0;
	}

	async function togglePlayback() {
		if (!audio || audioLoading) return;
		if (audio.paused) await audio.play().catch((error) => (playerError = friendlyError(error, 'Playback was blocked.')));
		else audio.pause();
	}

	function adjacentTrack(direction) {
		if (!currentTrack || queue.length === 0) return null;
		if (shuffle && queue.length > 1) {
			let next = currentTrack;
			while (next.id === currentTrack.id) next = queue[Math.floor(Math.random() * queue.length)];
			return next;
		}
		const index = queue.findIndex((track) => track.id === currentTrack.id);
		const nextIndex = (index + direction + queue.length) % queue.length;
		return queue[nextIndex];
	}

	async function skip(direction) {
		const next = adjacentTrack(direction);
		if (next) await playTrack(next, queue);
	}

	function onEnded() {
		if (repeat) {
			audio.currentTime = 0;
			audio.play();
		} else skip(1);
	}

	function seek(event) {
		if (!audio) return;
		const knownDuration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds;
		if (!knownDuration) return;
		audio.currentTime = Math.min(Number(event.currentTarget.value), knownDuration);
		currentTime = audio.currentTime;
	}

	function changeVolume(event) {
		volume = Number(event.currentTarget.value);
		if (audio) audio.volume = volume;
	}

	function formatTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const minutes = Math.floor(seconds / 60);
		return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
	}

	function formatTotal(seconds) {
		if (!seconds) return '—';
		if (seconds < 3600) return formatTime(seconds);
		const hours = Math.floor(seconds / 3600);
		return `${hours} hr ${Math.round((seconds % 3600) / 60)} min`;
	}

	function friendlyError(error, fallback) {
		const message = error instanceof Error ? error.message : String(error ?? '');
		return message.replace(/^Error:\s*/i, '') || fallback;
	}
</script>

<svelte:head>
	<title>iroh.fm — your music, anywhere</title>
	<meta name="description" content="A private, relay-connected music player for iroh-fm." />
</svelte:head>

{#if !client}
	<main class="relative grid min-h-screen overflow-hidden bg-paper lg:grid-cols-[1.1fr_.9fr]">
		<div class="pointer-events-none absolute -left-24 -top-32 size-[34rem] rounded-full bg-acid/70 blur-[110px]"></div>
		<div class="pointer-events-none absolute -bottom-40 right-[30%] size-[28rem] rounded-full bg-coral/40 blur-[120px]"></div>

		<section class="relative z-10 flex min-h-[42vh] flex-col justify-between border-b border-ink/15 p-6 sm:p-10 lg:min-h-screen lg:border-b-0 lg:border-r lg:p-14">
			<a href="./" class="flex w-fit items-center gap-2.5" aria-label="iroh.fm home">
				<span class="grid size-9 place-items-center rounded-full bg-ink text-acid"><Icon name="music" size={17} stroke={2.2} /></span>
				<span class="text-lg font-semibold tracking-[-.04em]">iroh<span class="font-normal text-ink/50">.fm</span></span>
			</a>

			<div class="my-16 max-w-3xl lg:my-0">
				<p class="mb-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.2em] text-ink/55"><span class="size-2 rounded-full bg-coral"></span>Private by design</p>
				<h1 class="font-display text-[clamp(4.4rem,10vw,9.5rem)] leading-[.72] font-medium tracking-[-.075em]">
					Your music,<br/><em class="font-normal text-ink/45">untethered.</em>
				</h1>
				<p class="mt-9 max-w-lg text-base leading-7 text-ink/60 sm:text-lg">Open your personal library from anywhere. No account, no central database—just an end-to-end encrypted iroh connection.</p>
			</div>

			<div class="hidden items-center gap-8 text-xs text-ink/45 lg:flex">
				<span>Static web app</span><span class="h-px w-8 bg-ink/20"></span><span>End-to-end encrypted</span><span class="h-px w-8 bg-ink/20"></span><span>Relay connected</span>
			</div>
		</section>

		<section class="relative z-10 flex items-center p-6 sm:p-10 lg:p-14">
			<form onsubmit={(event) => { event.preventDefault(); connect(); }} class="mx-auto w-full max-w-xl rounded-[2rem] border border-ink/10 bg-white/65 p-6 shadow-float backdrop-blur-2xl sm:p-9">
				<div class="mb-8 flex items-start justify-between gap-4">
					<div><p class="mb-2 text-xs font-semibold uppercase tracking-[.18em] text-ink/45">Connect to your server</p><h2 class="text-2xl font-semibold tracking-[-.04em]">Paste an endpoint ticket</h2></div>
					<div class="grid size-11 shrink-0 place-items-center rounded-full border border-ink/10 bg-paper"><Icon name="disc" /></div>
				</div>

				<label for="ticket" class="sr-only">iroh endpoint ticket</label>
				<textarea id="ticket" bind:value={ticket} rows="5" spellcheck="false" autocomplete="off" placeholder="endpointaa…" class="w-full resize-none rounded-2xl border border-ink/15 bg-paper/80 px-4 py-4 font-mono text-sm leading-6 outline-none transition placeholder:text-ink/25 focus:border-ink focus:ring-4 focus:ring-acid/30"></textarea>

				<div class="mt-4 flex items-start gap-3">
					<input id="remember" type="checkbox" bind:checked={rememberTicket} class="mt-0.5 size-4 accent-ink" />
					<label for="remember" class="text-xs leading-5 text-ink/50">Remember this ticket on this device. Tickets contain server dialing addresses, so only save it on a device you trust.</label>
				</div>

				{#if connectionError}
					<div class="mt-5 rounded-2xl border border-coral/40 bg-coral/10 px-4 py-3 text-sm leading-6 text-ink"><strong class="font-semibold">Connection failed.</strong> {connectionError}<div class="mt-1 text-xs text-ink/55">Browser clients require the server ticket to include an online relay.</div></div>
				{/if}

				<button type="submit" disabled={!ticket.trim() || connecting} class="mt-6 flex h-14 w-full items-center justify-center gap-3 rounded-full bg-ink px-6 font-semibold text-white transition hover:-translate-y-0.5 hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0">
					{#if connecting}<span class="size-4 animate-spin rounded-full border-2 border-white/30 border-t-acid"></span>{connectionStep}{:else}Enter your library <Icon name="arrow" size={18} />{/if}
				</button>

				<p class="mt-5 text-center text-[11px] leading-5 text-ink/40">The ticket is sent only to the local WebAssembly client. This static page has no application backend.</p>
			</form>
		</section>
	</main>
{:else}
	<div class="min-h-screen bg-paper pb-32 text-ink lg:pl-64">
		<header class="fixed inset-x-0 top-0 z-40 flex h-20 items-center gap-4 border-b border-ink/10 bg-paper/85 px-5 backdrop-blur-xl lg:left-64 lg:px-8">
			<div class="relative max-w-xl flex-1">
				<div class="pointer-events-none absolute inset-y-0 left-4 flex items-center text-ink/35"><Icon name="search" size={18} /></div>
				<input bind:value={searchTerm} oninput={queueSearch} onfocus={() => (view = 'search')} placeholder="Search artists, albums, tracks" class="h-11 w-full rounded-full border border-ink/10 bg-white/60 pl-11 pr-5 text-sm outline-none transition placeholder:text-ink/35 focus:border-ink/30 focus:bg-white" />
			</div>
			<div class="hidden items-center gap-2 rounded-full border border-ink/10 bg-white/60 px-3 py-2 text-xs text-ink/55 sm:flex"><span class="size-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10"></span>Connected via relay</div>
			<button onclick={disconnect} class="grid size-10 place-items-center rounded-full border border-ink/10 transition hover:bg-ink hover:text-white" title="Disconnect"><Icon name="disconnect" size={17} /></button>
		</header>

		<aside class="fixed inset-y-0 left-0 z-50 hidden w-64 flex-col border-r border-white/10 bg-ink px-5 py-7 text-white lg:flex">
			<div class="mb-12 flex items-center gap-2.5 px-2"><span class="grid size-9 place-items-center rounded-full bg-acid text-ink"><Icon name="music" size={17} stroke={2.2}/></span><span class="text-lg font-semibold tracking-[-.04em]">iroh<span class="font-normal text-white/40">.fm</span></span></div>
			<nav class="space-y-1.5">
				<button onclick={() => navigate('home')} class={desktopNavClass(view === 'home')}><Icon name="home" size={19}/>Home</button>
				<button onclick={() => navigate('library')} class={desktopNavClass(view === 'library' || view === 'album' || view === 'artist')}><Icon name="library" size={19}/>Library</button>
				<button onclick={() => navigate('favorites')} class={desktopNavClass(view === 'favorites')}><Icon name="heart" size={19}/>Favorites</button>
			</nav>

			<div class="mt-10 min-h-0 flex-1 overflow-y-auto border-t border-white/10 pt-7">
				<p class="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.2em] text-white/30">Artists</p>
				{#each artists.slice(0, 18) as artist}
					<button onclick={() => openArtist(artist)} class="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-white/45 transition hover:bg-white/5 hover:text-white">{artist.name}</button>
				{/each}
			</div>

			<div class="mt-6 rounded-2xl border border-white/10 bg-white/5 p-3.5">
				<div class="mb-2 flex items-center justify-between"><span class="text-[10px] font-semibold uppercase tracking-[.15em] text-white/35">Server</span><span class="size-1.5 rounded-full bg-emerald-400"></span></div>
				<p class="truncate font-mono text-[10px] text-white/55" title={client.remoteId}>{client.remoteId}</p>
			</div>
		</aside>

		<main class="px-5 pt-28 sm:px-8 lg:px-10 xl:px-14">
			{#if connectionError}
				<div class="mb-6 flex items-start justify-between rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm"><span>{connectionError}</span><button onclick={() => (connectionError = '')} class="ml-4 text-ink/45"><Icon name="close" size={16}/></button></div>
			{/if}

			{#if view === 'home'}
				<section class="relative mb-14 overflow-hidden rounded-[2rem] bg-ink px-6 py-9 text-white sm:px-10 sm:py-12 xl:px-14">
					<div class="absolute -right-16 -top-24 size-80 rounded-full bg-acid/80 blur-[80px]"></div><div class="absolute bottom-[-65%] right-[22%] size-72 rounded-full bg-coral/70 blur-[95px]"></div>
					<div class="relative max-w-3xl"><p class="mb-4 text-xs font-semibold uppercase tracking-[.2em] text-acid">Your private collection</p><h1 class="font-display text-5xl leading-[.9] tracking-[-.055em] sm:text-7xl">Good to hear you.</h1><p class="mt-6 max-w-xl text-sm leading-6 text-white/55 sm:text-base">Your whole library is online and ready to play, privately bridged through iroh.</p>
						<div class="mt-8 flex flex-wrap gap-6 text-sm"><span><strong class="text-xl text-acid">{summary.album_count}</strong> <span class="text-white/40">albums</span></span><span><strong class="text-xl text-acid">{summary.artist_count}</strong> <span class="text-white/40">artists</span></span><span><strong class="text-xl text-acid">{summary.track_count}</strong> <span class="text-white/40">tracks</span></span></div>
					</div>
				</section>

				<div class="mb-6 flex items-end justify-between"><div><p class="mb-1 text-xs font-semibold uppercase tracking-[.18em] text-ink/40">From your shelves</p><h2 class="text-2xl font-semibold tracking-[-.04em] sm:text-3xl">Albums to play</h2></div><button onclick={() => navigate('library')} class="flex items-center gap-1 text-sm font-semibold hover:underline">View all <Icon name="chevron" size={16}/></button></div>
				{@render AlbumGrid(featuredAlbums)}

				{#if starred.tracks.length}
					<div class="mb-6 mt-14 flex items-end justify-between"><div><p class="mb-1 text-xs font-semibold uppercase tracking-[.18em] text-ink/40">Hand picked</p><h2 class="text-2xl font-semibold tracking-[-.04em]">Recently loved</h2></div></div>
					{@render TrackList(starred.tracks.slice(0, 6))}
				{/if}
			{:else if view === 'library'}
				{@render PageTitle('Your collection', 'Library', `${summary.album_count} albums · ${summary.artist_count} artists`)}
				{@render AlbumGrid(albums)}
			{:else if view === 'favorites'}
				{@render PageTitle('Saved for later', 'Favorites', `${favoriteAlbums.length} albums · ${starred.tracks.length} tracks`)}
				{#if favoriteAlbums.length}<h2 class="mb-5 text-lg font-semibold">Albums</h2>{@render AlbumGrid(favoriteAlbums)}{/if}
				{#if starred.tracks.length}<h2 class="mb-5 mt-14 text-lg font-semibold">Tracks</h2>{@render TrackList(starred.tracks)}{/if}
				{#if !favoriteAlbums.length && !starred.tracks.length}{@render Empty('heart', 'Nothing saved yet', 'Tap the heart beside any album or track and it will show up here.')}{/if}
			{:else if view === 'search'}
				{@render PageTitle('Across your library', searchTerm ? `Search for “${searchTerm}”` : 'Search', 'Artists, albums and songs')}
				{#if searchLoading}<div class="flex items-center gap-3 py-12 text-sm text-ink/50"><span class="size-4 animate-spin rounded-full border-2 border-ink/15 border-t-ink"></span>Searching over iroh…</div>
				{:else if searchResults}
					{#if searchResults.artists.length}<h2 class="mb-4 text-lg font-semibold">Artists</h2><div class="mb-12 flex flex-wrap gap-3">{#each searchResults.artists as artist}<button onclick={() => openArtist(artist)} class="rounded-full border border-ink/15 bg-white/50 px-5 py-2.5 text-sm transition hover:border-ink hover:bg-white">{artist.name}</button>{/each}</div>{/if}
					{#if searchResults.albums.length}<h2 class="mb-5 text-lg font-semibold">Albums</h2>{@render AlbumGrid(searchResults.albums)}{/if}
					{#if searchResults.tracks.length}<h2 class="mb-5 mt-12 text-lg font-semibold">Tracks</h2>{@render TrackList(searchResults.tracks)}{/if}
					{#if !searchResults.artists.length && !searchResults.albums.length && !searchResults.tracks.length}{@render Empty('search', 'No matches', 'Try another artist, album, or song title.')}{/if}
				{:else}{@render Empty('search', 'Find something to play', 'Type at least two characters in the search field above.')}{/if}
			{:else if view === 'album' && selectedAlbum}
				<button onclick={() => navigate('library')} class="mb-7 flex items-center gap-2 text-sm text-ink/50 transition hover:text-ink"><span class="rotate-180"><Icon name="arrow" size={16}/></span>Back to library</button>
				<section class="mb-10 grid gap-7 sm:grid-cols-[minmax(220px,300px)_1fr] sm:items-end lg:gap-10">
					<Cover {client} id={selectedAlbum.cover_art_id} title={selectedAlbum.title} class="w-full rounded-[1.5rem] shadow-float" />
					<div><p class="mb-3 text-xs font-semibold uppercase tracking-[.18em] text-ink/40">{selectedAlbum.album_artist || selectedAlbum.artist}</p><h1 class="font-display text-5xl leading-[.9] font-semibold tracking-[-.055em] sm:text-7xl">{selectedAlbum.title}</h1><p class="mt-5 text-sm text-ink/50">{selectedAlbum.year || selectedAlbum.date || 'Unknown year'} · {selectedAlbum.track_ids.length} tracks · {formatTotal(selectedAlbum.duration_seconds)}</p>
						<div class="mt-7 flex gap-3"><button onclick={() => playAlbum(selectedAlbum)} disabled={albumLoading} class="flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5"><Icon name="play" size={16}/>Play album</button><button onclick={(event) => toggleStar(selectedAlbum, 'album', event)} class="grid size-11 place-items-center rounded-full border border-ink/15 transition hover:bg-white" class:text-coral={starredIds.has(selectedAlbum.id)} title="Favorite album"><Icon name="heart" size={18}/></button></div>
					</div>
				</section>
				{#if albumLoading}<div class="flex items-center gap-3 py-10 text-sm text-ink/50"><span class="size-4 animate-spin rounded-full border-2 border-ink/15 border-t-ink"></span>Loading track list…</div>{:else}{@render TrackList(albumTracks)}{/if}
			{:else if view === 'artist' && selectedArtist}
				<button onclick={() => navigate('library')} class="mb-7 flex items-center gap-2 text-sm text-ink/50 transition hover:text-ink"><span class="rotate-180"><Icon name="arrow" size={16}/></span>Back to library</button>
				<section class="mb-12 border-b border-ink/10 pb-10"><p class="mb-4 text-xs font-semibold uppercase tracking-[.2em] text-ink/40">Artist</p><div class="flex items-end justify-between gap-5"><h1 class="font-display text-6xl leading-[.8] font-semibold tracking-[-.06em] sm:text-8xl">{selectedArtist.name}</h1><button onclick={(event) => toggleStar(selectedArtist, 'artist', event)} class="mb-1 grid size-11 shrink-0 place-items-center rounded-full border border-ink/15 transition hover:bg-white" class:text-coral={starredIds.has(selectedArtist.id)}><Icon name="heart" size={18}/></button></div></section>
				{@render AlbumGrid(artistAlbums)}
			{/if}
		</main>

		<nav class="fixed inset-x-3 bottom-[6.7rem] z-40 flex items-center justify-around rounded-2xl border border-white/10 bg-ink/95 px-2 py-2 text-white shadow-float backdrop-blur-xl lg:hidden">
			<button onclick={() => navigate('home')} class={mobileNavClass(view === 'home')}><Icon name="home" size={18}/>Home</button>
			<button onclick={() => navigate('library')} class={mobileNavClass(view === 'library' || view === 'album' || view === 'artist')}><Icon name="library" size={18}/>Library</button>
			<button onclick={() => navigate('favorites')} class={mobileNavClass(view === 'favorites')}><Icon name="heart" size={18}/>Favorites</button>
		</nav>

		{#if currentTrack}
			<footer class="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-ink text-white shadow-[0_-18px_50px_rgb(0_0_0/.12)]">
				<div class="grid min-h-24 grid-cols-[1fr_auto] items-center gap-4 px-3 py-3 sm:grid-cols-[minmax(180px,1fr)_minmax(280px,1.5fr)_minmax(150px,1fr)] sm:px-5 lg:px-7">
					<div class="flex min-w-0 items-center gap-3"><Cover {client} id={currentTrack.cover_art_id} title={currentTrack.album} class="size-14 shrink-0 rounded-lg"/><div class="min-w-0"><p class="truncate text-sm font-semibold">{currentTrack.title}</p><p class="mt-0.5 truncate text-xs text-white/40">{currentTrack.artist}</p>{#if audioLoading}<p class="mt-1 text-[10px] text-acid">Fetching securely over relay…</p>{:else if playerError}<p class="mt-1 truncate text-[10px] text-coral">{playerError}</p>{/if}</div></div>
					<div class="order-3 col-span-2 sm:order-none sm:col-span-1"><div class="mb-2 flex items-center justify-center gap-4"><button onclick={() => (shuffle = !shuffle)} class="hidden transition hover:text-white sm:block {shuffle ? 'text-acid' : 'text-white/35'}"><Icon name="shuffle" size={16}/></button><button onclick={() => skip(-1)} class="text-white/60 transition hover:text-white"><Icon name="previous" size={19}/></button><button onclick={togglePlayback} disabled={audioLoading} class="grid size-10 place-items-center rounded-full bg-white text-ink transition hover:scale-105 disabled:opacity-50">{#if audioLoading}<span class="size-4 animate-spin rounded-full border-2 border-ink/20 border-t-ink"></span>{:else if playing}<Icon name="pause" size={17}/>{:else}<span class="translate-x-px"><Icon name="play" size={17}/></span>{/if}</button><button onclick={() => skip(1)} class="text-white/60 transition hover:text-white"><Icon name="next" size={19}/></button><button onclick={() => (repeat = !repeat)} class="hidden transition hover:text-white sm:block {repeat ? 'text-acid' : 'text-white/35'}"><Icon name="repeat" size={16}/></button></div>
						<div class="flex items-center gap-2 text-[10px] text-white/30"><span class="w-8 text-right">{formatTime(currentTime)}</span><input type="range" min="0" max={duration || currentTrack.duration_seconds || 0} value={currentTime} oninput={seek} class="h-1 flex-1 cursor-pointer accent-acid"/><span class="w-8">{formatTime(duration || currentTrack.duration_seconds)}</span></div>
					</div>
					<div class="hidden items-center justify-end gap-2 text-white/40 sm:flex"><Icon name="volume" size={17}/><input type="range" min="0" max="1" step="0.01" value={volume} oninput={changeVolume} class="h-1 w-24 cursor-pointer accent-acid"/></div>
				</div>
			</footer>
		{/if}

		<audio bind:this={audio} src={audioSrc} onplay={() => (playing = true)} onpause={() => (playing = false)} ontimeupdate={() => { currentTime = audio.currentTime; duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; }} onloadedmetadata={() => { duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; audio.volume = volume; }} onended={onEnded}></audio>
	</div>
{/if}

{#snippet PageTitle(eyebrow, title, detail)}
	<header class="mb-10 border-b border-ink/10 pb-8"><p class="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-ink/40">{eyebrow}</p><div class="flex flex-wrap items-end justify-between gap-4"><h1 class="font-display text-6xl leading-[.8] font-semibold tracking-[-.06em] sm:text-8xl">{title}</h1><p class="text-sm text-ink/45">{detail}</p></div></header>
{/snippet}

{#snippet AlbumGrid(list)}
	{#if list.length}
		<div class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
			{#each list as album (album.id)}
				<article class="group min-w-0">
					<button onclick={() => openAlbum(album)} class="relative block w-full overflow-hidden rounded-[1.15rem] bg-mist text-left shadow-sm transition duration-300 group-hover:-translate-y-1 group-hover:shadow-float">
						<Cover {client} id={album.cover_art_id} title={album.title} class="w-full" />
						<span class="absolute bottom-3 right-3 grid size-11 translate-y-3 place-items-center rounded-full bg-acid text-ink opacity-0 shadow-lg transition duration-300 group-hover:translate-y-0 group-hover:opacity-100"><Icon name="play" size={17}/></span>
					</button>
					<div class="mt-3 flex items-start gap-2"><button onclick={() => openAlbum(album)} class="min-w-0 flex-1 text-left"><h3 class="truncate text-sm font-semibold tracking-[-.02em]">{album.title}</h3><p class="mt-1 truncate text-xs text-ink/45">{album.album_artist || album.artist}{album.year ? ` · ${album.year}` : ''}</p></button><button onclick={(event) => toggleStar(album, 'album', event)} class="mt-0.5 transition hover:text-coral {starredIds.has(album.id) ? 'text-coral' : 'text-ink/25'}" aria-label="Favorite album"><Icon name="heart" size={16}/></button></div>
				</article>
			{/each}
		</div>
	{:else}{@render Empty('disc', 'No albums here', 'Your server did not return any albums for this view.')}{/if}
{/snippet}

{#snippet TrackList(tracks)}
	<div class="overflow-hidden rounded-2xl border border-ink/10 bg-white/45">
		{#each tracks as track, index (track.id)}
			<div class="group grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 border-b border-ink/8 px-3 py-3 last:border-0 sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(100px,.8fr)_5rem_2.5rem] sm:px-4 {currentTrack?.id === track.id ? 'bg-acid/20' : ''}">
				<button onclick={() => playOrToggle(track, tracks)} class="grid size-8 place-items-center rounded-full text-xs text-ink/35 transition group-hover:bg-ink group-hover:text-white">{#if currentTrack?.id === track.id && playing}<Icon name="pause" size={13}/>{:else if currentTrack?.id === track.id}<Icon name="play" size={13}/>{:else}<span class="group-hover:hidden">{track.track_number || index + 1}</span><span class="hidden group-hover:block"><Icon name="play" size={12}/></span>{/if}</button>
				<button onclick={() => playOrToggle(track, tracks)} class="min-w-0 text-left"><p class="truncate text-sm font-medium">{track.title}</p><p class="mt-0.5 truncate text-xs text-ink/40 sm:hidden">{track.artist}</p></button>
				<p class="hidden truncate text-xs text-ink/40 sm:block">{track.artist}</p>
				<p class="hidden text-right text-xs tabular-nums text-ink/35 sm:block">{formatTime(track.duration_seconds)}</p>
				<button onclick={(event) => toggleStar(track, 'track', event)} class="grid size-8 place-items-center transition hover:text-coral {starredIds.has(track.id) ? 'text-coral' : 'text-ink/20'}" aria-label="Favorite track"><Icon name="heart" size={15}/></button>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet Empty(icon, title, text)}
	<div class="grid min-h-72 place-items-center rounded-[2rem] border border-dashed border-ink/15 bg-white/25 p-8 text-center"><div><div class="mx-auto mb-5 grid size-14 place-items-center rounded-full bg-ink text-acid"><Icon name={icon}/></div><h2 class="text-lg font-semibold">{title}</h2><p class="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink/45">{text}</p></div></div>
{/snippet}
