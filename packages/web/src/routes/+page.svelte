<script>
	// @ts-nocheck
	import { MusicClient } from '@iroh-fm/client';
	import { onMount, tick } from 'svelte';
	import { VList } from 'virtua/svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';

	const ROW_HEIGHT = 30;
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

	let ticket = $state('');
	let endpoint = $state('');
	let relays = $state(['']);
	let secret = $state('');
	let clientEndpointId = $state('');
	let identityLoading = $state(true);
	let showSecret = $state(false);
	let loginTab = $state('ticket');
	let connecting = $state(false);
	let connectionStep = $state('Starting browser endpoint…');
	let connectionError = $state('');
	let client = $state(null);

	let summary = $state({ artist_count: 0, album_count: 0, track_count: 0 });
	let albums = $state([]);
	let artists = $state([]);
	let tracks = $state([]);
	let starred = $state({ artists: [], albums: [], tracks: [] });
	let starredIds = $state(new Set());

	let query = $state('');
	let favoriteOnly = $state(false);
	let activeAlbumId = $state(null);
	let selectedTrackId = $state(null);
	let mobilePane = $state('tracks');

	let trackList = $state();

	let settingsOpen = $state(false);
	let settingsTicket = $state('');
	let settingsEndpoint = $state('');
	let settingsRelays = $state(['']);
	let settingsSecret = $state('');
	let settingsShowSecret = $state(false);
	let endpointCopied = $state(false);

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
	let qrOpen = $state(false);
	let qrError = $state('');
	let qrVideo = $state();
	let qrStream;
	let qrFrame;
	let ticketParseGeneration = 0;
	let settingsTicketParseGeneration = 0;

	const activeAlbum = $derived(albums.find((album) => album.id === activeAlbumId) ?? null);
	const activeAlbumTrackIds = $derived(activeAlbum ? new Set(activeAlbum.track_ids) : null);
	const filteredTracks = $derived(filterTracks(tracks, query, activeAlbumTrackIds, favoriteOnly, starredIds));

	onMount(() => {
		ticket = localStorage.getItem('iroh-fm-ticket') ?? '';
		endpoint = localStorage.getItem('iroh-fm-endpoint') ?? '';
		relays = readStoredRelays();
		secret = localStorage.getItem('iroh-fm-secret') ?? '';
		initializeIdentity();
		return stopQrScanner;
	});

	function variant(response, key, fallback) {
		return response && key in response ? response[key] : fallback;
	}

	function readStoredRelays() {
		try {
			const stored = JSON.parse(localStorage.getItem('iroh-fm-relays') ?? 'null');
			if (Array.isArray(stored) && stored.length) return stored.map(String);
		} catch {
			// Fall through to the legacy single-relay setting.
		}
		return [localStorage.getItem('iroh-fm-relay') ?? ''];
	}

	function cleanRelays(values) {
		return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
	}

	function selectLoginTab(tab) {
		loginTab = tab;
		if (tab === 'advanced' && ticket.trim()) syncTicketAddress(ticket);
	}

	function updateLoginTicket(event) {
		ticket = event.currentTarget.value;
		if (loginTab === 'advanced') {
			endpoint = '';
			relays = [''];
			syncTicketAddress(ticket);
		}
	}

	async function syncTicketAddress(value) {
		const generation = ++ticketParseGeneration;
		if (!value.trim()) return;
		try {
			const address = await MusicClient.parseTicket(value.trim());
			if (generation !== ticketParseGeneration) return;
			endpoint = address.endpointId;
			relays = address.relays.length ? address.relays : [''];
		} catch {
			// Tickets are invalid while the user is still typing; connect reports final errors.
		}
	}

	function updateSettingsTicket(event) {
		settingsTicket = event.currentTarget.value;
		settingsEndpoint = '';
		settingsRelays = [''];
		syncSettingsTicketAddress(settingsTicket);
	}

	async function syncSettingsTicketAddress(value) {
		const generation = ++settingsTicketParseGeneration;
		if (!value.trim()) return;
		try {
			const address = await MusicClient.parseTicket(value.trim());
			if (generation !== settingsTicketParseGeneration) return;
			settingsEndpoint = address.endpointId;
			settingsRelays = address.relays.length ? address.relays : [''];
		} catch {
			// Keep the editor ready for the next input event.
		}
	}

	function addRelay(settings = false) {
		if (settings) settingsRelays.push('');
		else relays.push('');
	}

	function removeRelay(index, settings = false) {
		const list = settings ? settingsRelays : relays;
		list.splice(index, 1);
		if (!list.length) list.push('');
	}

	async function initializeIdentity() {
		identityLoading = true;
		try {
			if (secret.trim()) {
				clientEndpointId = await MusicClient.endpointIdForSecret(secret);
			} else {
				const identity = await MusicClient.generateIdentity();
				secret = identity.secret;
				clientEndpointId = identity.endpointId;
				localStorage.setItem('iroh-fm-secret', secret);
			}
		} catch (error) {
			connectionError = friendlyError(error, 'Could not prepare a browser identity.');
		} finally {
			identityLoading = false;
		}
	}

	async function updateIdentity(nextSecret) {
		secret = nextSecret;
		clientEndpointId = '';
		if (!nextSecret.trim()) return;
		try {
			clientEndpointId = await MusicClient.endpointIdForSecret(nextSecret);
		} catch {
			// Validation is reported when the user connects or saves settings.
		}
	}

	function canConnect(forceTicket = loginTab === 'ticket') {
		if (forceTicket) return Boolean(ticket.trim());
		return endpoint.trim() ? cleanRelays(relays).length > 0 : Boolean(ticket.trim());
	}

	async function connect(forceTicket = false) {
		if (!canConnect(forceTicket) || connecting) return;
		connecting = true;
		connectionError = '';
		connectionStep = 'Loading the iroh WebAssembly client…';
		let nextClient;
		try {
			if (!secret.trim()) {
				const identity = await MusicClient.generateIdentity();
				secret = identity.secret;
				clientEndpointId = identity.endpointId;
			}
			persistConnection(ticket, endpoint, relays, secret);
			nextClient = await MusicClient.connect({
				ticket: ticket.trim(),
				endpoint: forceTicket ? '' : endpoint.trim(),
				relays: cleanRelays(relays),
				secret
			});
			connectionStep = 'Indexing the remote library…';
			const data = await nextClient.bootstrap();
			client = nextClient;
			summary = variant(data.summary, 'LibrarySummary', summary);
			albums = variant(data.albums, 'Albums', []).sort(albumSort);
			artists = variant(data.artists, 'Artists', []);
			tracks = variant(data.tracks, 'Tracks', []).sort(trackSort);
			starred = variant(data.starred, 'Starred', starred);
			starredIds = new Set([
				...starred.artists.map((item) => item.id),
				...starred.albums.map((item) => item.id),
				...starred.tracks.map((item) => item.id)
			]);
		} catch (error) {
			await nextClient?.close().catch(() => {});
			connectionError = friendlyError(error, 'Could not reach this iroh-fm server.');
			client = null;
		} finally {
			connecting = false;
		}
	}

	function persistConnection(nextTicket, nextEndpoint, nextRelays, nextSecret) {
		localStorage.setItem('iroh-fm-ticket', nextTicket.trim());
		if (nextEndpoint.trim()) localStorage.setItem('iroh-fm-endpoint', nextEndpoint.trim());
		else localStorage.removeItem('iroh-fm-endpoint');
		const relayList = cleanRelays(nextRelays);
		if (relayList.length) localStorage.setItem('iroh-fm-relays', JSON.stringify(relayList));
		else localStorage.removeItem('iroh-fm-relays');
		localStorage.removeItem('iroh-fm-relay');
		if (nextSecret.trim()) localStorage.setItem('iroh-fm-secret', nextSecret.trim());
		else localStorage.removeItem('iroh-fm-secret');
	}

	async function disconnect() {
		stopPlayback();
		const previous = client;
		client = null;
		if (previous) await previous.close().catch(() => {});
	}

	function openSettings() {
		settingsTicket = ticket;
		settingsEndpoint = endpoint;
		settingsRelays = [...relays];
		settingsSecret = secret;
		settingsShowSecret = false;
		settingsOpen = true;
		if (settingsTicket.trim()) syncSettingsTicketAddress(settingsTicket);
	}

	async function applySettings() {
		if (!(settingsEndpoint.trim() ? cleanRelays(settingsRelays).length : settingsTicket.trim()) || connecting) return;
		let nextSecret = settingsSecret.trim();
		try {
			if (nextSecret) clientEndpointId = await MusicClient.endpointIdForSecret(nextSecret);
			else {
				const identity = await MusicClient.generateIdentity();
				nextSecret = identity.secret;
				clientEndpointId = identity.endpointId;
			}
		} catch (error) {
			connectionError = friendlyError(error, 'The client secret is invalid.');
			return;
		}
		ticket = settingsTicket.trim();
		endpoint = settingsEndpoint.trim();
		relays = [...settingsRelays];
		secret = nextSecret;
		persistConnection(ticket, endpoint, relays, secret);
		settingsOpen = false;
		await disconnect();
		await connect();
	}

	async function copyEndpointId() {
		try {
			await navigator.clipboard.writeText(client?.endpointId || clientEndpointId);
			endpointCopied = true;
			setTimeout(() => (endpointCopied = false), 1600);
		} catch (error) {
			connectionError = friendlyError(error, 'Could not copy the client endpoint ID.');
		}
	}

	async function startQrScanner() {
		qrOpen = true;
		qrError = '';
		await tick();
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.');
			if (!('BarcodeDetector' in window)) throw new Error('QR scanning is not supported here. Paste the ticket instead.');
			qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
			qrVideo.srcObject = qrStream;
			await qrVideo.play();
			const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
			const scan = async () => {
				if (!qrOpen || !qrVideo) return;
				try {
					const codes = await detector.detect(qrVideo);
					if (codes[0]?.rawValue) {
						ticket = codes[0].rawValue.trim();
						stopQrScanner();
						return;
					}
				} catch {
					// A frame can fail while the camera is warming up; keep scanning.
				}
				qrFrame = requestAnimationFrame(scan);
			};
			scan();
		} catch (error) {
			qrError = friendlyError(error, 'Could not start the camera.');
			qrStream?.getTracks().forEach((track) => track.stop());
			qrStream = null;
		}
	}

	function stopQrScanner() {
		qrOpen = false;
		if (qrFrame) cancelAnimationFrame(qrFrame);
		qrFrame = null;
		qrStream?.getTracks().forEach((track) => track.stop());
		qrStream = null;
		if (qrVideo) qrVideo.srcObject = null;
	}

	function updateQuery(event) {
		query = event.currentTarget.value;
		resetTrackScroll();
	}

	function resetTrackScroll() {
		trackList?.scrollToIndex(0);
	}

	function selectAlbum(album) {
		activeAlbumId = activeAlbumId === album.id ? null : album.id;
		mobilePane = 'tracks';
		resetTrackScroll();
	}

	function clearAlbum() {
		activeAlbumId = null;
		resetTrackScroll();
	}

	async function toggleStar(track, event) {
		event?.stopPropagation();
		const shouldStar = !starredIds.has(track.id);
		try {
			await client.request({ SetStarred: { id: track.id, starred: shouldStar } });
			const next = new Set(starredIds);
			if (shouldStar) next.add(track.id);
			else next.delete(track.id);
			starredIds = next;
		} catch (error) {
			connectionError = friendlyError(error, 'Could not update the favorite.');
		}
	}

	async function playAlbum(album) {
		const ids = new Set(album.track_ids);
		const albumQueue = tracks.filter((track) => ids.has(track.id)).sort(trackSort);
		if (albumQueue[0]) await playTrack(albumQueue[0], albumQueue);
	}

	async function playTrack(track, sourceQueue = filteredTracks) {
		const generation = ++playGeneration;
		audio?.pause();
		audioSource?.dispose();
		audioSource = null;
		audioSrc = '';
		currentTrack = track;
		selectedTrackId = track.id;
		queue = [...sourceQueue];
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
				if (audioSource === source && !source.disposed) playerError = friendlyError(error, 'Stream interrupted.');
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

	async function playOrToggle(track, sourceQueue = filteredTracks) {
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
		if (!audio || audioLoading || !currentTrack) return;
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
		return queue[(index + direction + queue.length) % queue.length];
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

	function filterTracks(list, term, albumIds, lovedOnly, lovedIds) {
		const needle = term.trim().toLocaleLowerCase();
		return list.filter((track) => {
			if (albumIds && !albumIds.has(track.id)) return false;
			if (lovedOnly && !lovedIds.has(track.id)) return false;
			if (!needle) return true;
			return `${track.artist}\n${track.title}\n${track.album}`.toLocaleLowerCase().includes(needle);
		});
	}

	function trackSort(left, right) {
		return left.artist.localeCompare(right.artist, undefined, { numeric: true })
			|| left.album.localeCompare(right.album, undefined, { numeric: true })
			|| (left.disc_number || 0) - (right.disc_number || 0)
			|| (left.track_number || 0) - (right.track_number || 0)
			|| left.title.localeCompare(right.title, undefined, { numeric: true });
	}

	function albumSort(left, right) {
		return (left.album_artist || left.artist).localeCompare(right.album_artist || right.artist, undefined, { numeric: true })
			|| left.title.localeCompare(right.title, undefined, { numeric: true });
	}

	function formatTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
	}

	function friendlyError(error, fallback) {
		const message = error instanceof Error ? error.message : String(error ?? '');
		return message.replace(/^Error:\s*/i, '') || fallback;
	}
</script>

<svelte:head>
	<title>iroh.fm</title>
	<meta name="description" content="A private iroh music player." />
</svelte:head>

{#if !client}
	<main class="relative h-dvh overflow-hidden bg-base text-text">
		<div class="absolute inset-0 grid grid-rows-[34px_minmax(0,1fr)_72px] select-none opacity-65" aria-hidden="true">
			<header class="flex items-center border-b border-surface0 bg-crust text-[11px]"><div class="flex h-full items-center border-r border-surface0 px-3 text-mauve"><Icon name="music" size={15}/><strong class="ml-2">iroh.fm</strong></div><span class="border-r border-surface0 bg-surface0 px-4 py-2 font-semibold">ALL TRACKS</span><span class="px-4 font-semibold text-overlay1">LOVED</span><span class="ml-auto px-4 font-mono text-overlay0">REMOTE LIBRARY</span></header>
			<div class="grid min-h-0 grid-cols-[minmax(0,2fr)_minmax(330px,1fr)]">
				<section class="min-h-0 border-r border-surface0 bg-base"><div class="flex h-10 items-center gap-3 border-b border-surface0 bg-mantle px-3 text-overlay0"><Icon name="search" size={14}/><span class="font-mono text-xs">Filter artist, title, album…</span><span class="ml-auto font-mono text-[10px]">128 TRACKS</span></div><div class="grid h-7 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0"><span>#</span><span>Artist</span><span>Title</span><span>Album</span><span>Time</span></div>{#each DEMO_TRACKS as track}<div class="grid h-[30px] grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0/40 px-2 text-[11px]"><span class="font-mono text-overlay0">{track[0]}</span><span class="truncate pr-2 text-mauve">{track[1]}</span><span class="truncate pr-2 text-teal">{track[2]}</span><span class="truncate pr-2 text-subtext0">{track[3]}</span><span class="font-mono text-overlay0">{track[4]}</span></div>{/each}</section>
				<aside class="min-h-0 bg-mantle p-3"><div class="mb-3 flex h-7 items-center justify-between"><strong class="text-xs">ALBUMS</strong><span class="font-mono text-[10px] text-overlay0">24</span></div><div class="grid grid-cols-3 gap-x-3 gap-y-5">{#each DEMO_ALBUMS as album, index}<article class="min-w-0"><div class={`grid aspect-square place-items-center bg-gradient-to-br ${album[2]}`}><div class="grid size-1/2 place-items-center rounded-full border border-crust/20 bg-crust/25"><div class="size-2 rounded-full bg-text/50"></div></div></div><h3 class="mt-2 truncate text-[11px] font-semibold">{album[0]}</h3><p class="truncate text-[10px] text-overlay1">{album[1]}</p></article>{/each}</div></aside>
			</div>
			<footer class="border-t border-surface1 bg-crust"><div class="h-1 bg-surface0"><div class="h-full w-1/3 bg-mauve"></div></div><div class="grid h-[68px] grid-cols-[auto_1fr_auto] items-center gap-4 px-5"><div class="flex items-center gap-2 text-overlay1"><Icon name="previous" size={16}/><span class="grid size-10 place-items-center bg-text text-crust"><Icon name="play" size={14}/></span><Icon name="next" size={16}/></div><div><p class="text-xs font-semibold">Anywhere Between</p><p class="mt-1 text-[10px] text-overlay1">Nacre · Still Light</p></div><span class="font-mono text-[10px] text-overlay0">1:12 / 3:42</span></div></footer>
		</div>

		<div class="absolute inset-0 bg-crust/35 backdrop-blur-[3px]"></div>
		<section class="absolute inset-0 z-10 grid place-items-center overflow-y-auto p-4 sm:p-8">
			<form onsubmit={(event) => { event.preventDefault(); connect(loginTab === 'ticket'); }} class="my-auto w-[calc(100vw-2rem)] max-w-[29rem] border border-surface1 bg-base shadow-float">
				<div class="border-b border-surface0 bg-mantle px-5 pt-5"><div class="mb-5 flex items-center gap-3"><span class="grid size-9 place-items-center bg-mauve text-crust"><Icon name="music" size={17} stroke={2.2}/></span><div><h1 class="text-[16px] font-semibold text-text">Enter your library</h1><p class="mt-0.5 text-[11px] text-overlay1">Connect privately with iroh</p></div></div><div class="flex gap-5 font-mono text-[10px] font-bold uppercase tracking-wider"><button type="button" onclick={() => selectLoginTab('ticket')} class="border-b-2 pb-3 {loginTab === 'ticket' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Ticket</button><button type="button" onclick={() => selectLoginTab('advanced')} class="border-b-2 pb-3 {loginTab === 'advanced' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Advanced</button></div></div>

				<div class="space-y-4 p-5">
					<div><div class="mb-2 flex items-center justify-between"><label for="ticket" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label>{#if loginTab === 'ticket'}<button type="button" onclick={startQrScanner} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink"><Icon name="qr" size={13}/> SCAN QR</button>{/if}</div><textarea id="ticket" value={ticket} oninput={updateLoginTicket} rows={loginTab === 'ticket' ? 3 : 2} spellcheck="false" autocomplete="off" placeholder="endpointaa…" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 text-text outline-none placeholder:text-overlay0 focus:border-mauve"></textarea></div>

					{#if loginTab === 'advanced'}
						<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>or manual address<span class="h-px flex-1 bg-surface0"></span></div>
						<div><label for="endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="endpoint" bind:value={endpoint} spellcheck="false" autocomplete="off" placeholder="Public endpoint ID" class="h-10 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
						<div><div class="mb-2 flex items-center justify-between"><label for="relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={() => addRelay()} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each relays as relayUrl, index}<div class="relative"><input id={`relay-${index}`} bind:value={relays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if relays.length > 1}<button type="button" onclick={() => removeRelay(index)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div><p class="mt-1.5 text-[10px] text-overlay0">Valid tickets fill this address automatically. You can still edit it manually.</p></div>
						<div><label for="secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label><div class="relative"><input id="secret" value={secret} oninput={(event) => updateIdentity(event.currentTarget.value)} type={showSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (showSecret = !showSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{showSecret ? 'HIDE' : 'SHOW'}</button></div></div>
					{/if}

					<div class="border border-surface0 bg-mantle/70 px-3 py-2.5"><div class="flex items-center justify-between gap-3"><div class="min-w-0"><p class="font-mono text-[9px] uppercase tracking-[.13em] text-overlay0">This browser's endpoint ID</p><code class="mt-1 block truncate text-[10px] text-subtext0">{identityLoading ? 'Generating secure identity…' : clientEndpointId || 'Invalid client secret'}</code></div><button type="button" onclick={copyEndpointId} disabled={!clientEndpointId} class="shrink-0 font-mono text-[9px] text-mauve hover:text-pink disabled:text-overlay0">{endpointCopied ? 'COPIED' : 'COPY'}</button></div></div>

					{#if connectionError}<div class="border-l-2 border-red bg-red/10 px-3 py-2 text-xs leading-5 text-red"><strong>Connection failed.</strong> {connectionError}</div>{/if}
					<button type="submit" disabled={!canConnect() || connecting || identityLoading} class="flex h-11 w-full items-center justify-center gap-3 bg-mauve font-mono text-xs font-bold tracking-wide text-crust transition hover:bg-pink disabled:cursor-not-allowed disabled:opacity-40">{#if connecting}<span class="size-3 animate-spin rounded-full border-2 border-crust/25 border-t-crust"></span>{connectionStep}{:else}CONNECT <Icon name="arrow" size={15}/>{/if}</button>
				</div>
			</form>
		</section>

		{#if qrOpen}<div class="absolute inset-0 z-30 grid place-items-center bg-crust/90 p-4" role="dialog" aria-modal="true" aria-label="Scan ticket QR code"><div class="w-full max-w-sm border border-surface1 bg-base shadow-float"><div class="flex items-center justify-between border-b border-surface0 bg-mantle px-4 py-3"><div><h2 class="text-sm font-semibold">Scan server ticket</h2><p class="mt-0.5 text-[10px] text-overlay1">Point the camera at a ticket QR code</p></div><button onclick={stopQrScanner} class="grid size-8 place-items-center text-overlay1 hover:bg-surface0 hover:text-text"><Icon name="close" size={15}/></button></div><div class="p-4"><div class="relative aspect-square overflow-hidden bg-crust"><video bind:this={qrVideo} muted playsinline class="h-full w-full object-cover"></video><div class="pointer-events-none absolute inset-8 border border-mauve/80"></div></div>{#if qrError}<p class="mt-3 text-xs leading-5 text-red">{qrError}</p>{/if}</div></div></div>{/if}
	</main>
{:else}
	<div class="grid h-dvh grid-rows-[34px_minmax(0,1fr)_72px] overflow-hidden bg-base text-text">
		<header class="flex min-w-0 items-center border-b border-surface0 bg-crust text-[11px]">
			<div class="flex h-full shrink-0 items-center border-r border-surface0 px-3 text-mauve"><Icon name="music" size={15} stroke={2.2}/><strong class="ml-2 hidden sm:inline">iroh.fm</strong></div>
			<nav class="flex h-full min-w-0 items-stretch">
				<button onclick={() => { favoriteOnly = false; mobilePane = 'tracks'; resetTrackScroll(); }} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {mobilePane === 'tracks' && !favoriteOnly ? 'bg-surface0 text-text' : 'text-overlay1'}">ALL TRACKS</button>
				<button onclick={() => { favoriteOnly = !favoriteOnly; mobilePane = 'tracks'; resetTrackScroll(); }} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {favoriteOnly ? 'bg-surface0 text-pink' : 'text-overlay1'}">LOVED</button>
				<button onclick={() => (mobilePane = 'albums')} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold text-overlay1 transition hover:bg-surface0 lg:hidden {mobilePane === 'albums' ? 'bg-surface0 text-text' : ''}">ALBUMS</button>
			</nav>
			<div class="ml-auto flex h-full min-w-0 items-center">
				<span class="hidden max-w-48 truncate px-3 font-mono text-overlay0 md:block">{client.endpointId}</span>
				<button onclick={copyEndpointId} class="h-full border-l border-surface0 px-3 font-mono text-overlay1 hover:bg-surface0 hover:text-teal" title={client.endpointId}><span class="sm:hidden">{endpointCopied ? 'OK' : 'ID'}</span><span class="hidden sm:inline">{endpointCopied ? 'COPIED' : 'ENDPOINT'}</span></button>
				<button onclick={openSettings} class="grid h-full w-9 place-items-center border-l border-surface0 text-overlay1 hover:bg-surface0 hover:text-mauve" title="Connection settings"><Icon name="settings" size={15}/></button>
				<button onclick={disconnect} class="grid h-full w-9 place-items-center border-l border-surface0 text-overlay1 hover:bg-surface0 hover:text-red" title="Disconnect"><Icon name="disconnect" size={15}/></button>
			</div>
		</header>

		<div class="grid min-h-0 lg:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
			<section class="min-h-0 flex-col border-r border-surface0 bg-base {mobilePane === 'tracks' ? 'flex' : 'hidden'} lg:flex">
				<div class="flex h-10 shrink-0 items-center gap-3 border-b border-surface0 bg-mantle px-3">
					<Icon name="search" size={14}/><input value={query} oninput={updateQuery} placeholder="Filter artist, title, album…" class="min-w-0 flex-1 bg-transparent font-mono text-xs text-text outline-none placeholder:text-overlay0"/>
					{#if activeAlbum}<button onclick={clearAlbum} class="flex min-w-0 items-center gap-2 border border-surface1 bg-surface0 px-2 py-1 font-mono text-[10px] text-mauve"><span class="max-w-40 truncate">{activeAlbum.title}</span><Icon name="close" size={11}/></button>{/if}
					<span class="shrink-0 font-mono text-[10px] text-overlay0">{filteredTracks.length} / {summary.track_count}</span>
				</div>

				<div class="hidden h-7 shrink-0 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0 sm:grid"><span>#</span><span>Artist</span><span>Title</span><span>Album</span><span class="text-right">Time</span></div>

				<div class="min-h-0 flex-1">
					<VList data={filteredTracks} getKey={(track) => track.id} itemSize={ROW_HEIGHT} bufferSize={ROW_HEIGHT * 10} bind:this={trackList} style="height: 100%; overscroll-behavior: contain;">
						{#snippet children(track, index)}
							<div role="row" tabindex="0" aria-selected={selectedTrackId === track.id} onclick={() => (selectedTrackId = track.id)} ondblclick={() => playOrToggle(track, filteredTracks)} onkeydown={(event) => { if (event.key === 'Enter') playOrToggle(track, filteredTracks); else if (event.key === ' ') { event.preventDefault(); selectedTrackId = track.id; } }} class="group grid grid-cols-[2rem_minmax(0,1fr)_3.2rem] items-center border-b border-surface0/35 px-2 text-[11px] transition outline-none focus:ring-1 focus:ring-inset focus:ring-mauve sm:grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] {currentTrack?.id === track.id ? 'bg-mauve/15' : selectedTrackId === track.id ? 'bg-surface0' : 'hover:bg-surface0/60'}" style={`height:${ROW_HEIGHT}px`}>
								<button onclick={(event) => { event.stopPropagation(); playOrToggle(track, filteredTracks); }} class="grid size-6 place-items-center font-mono text-[10px] text-overlay0 hover:text-mauve" aria-label={`Play ${track.title}`}>{#if currentTrack?.id === track.id && audioLoading}<span class="size-2.5 animate-spin rounded-full border border-overlay0 border-t-mauve"></span>{:else if currentTrack?.id === track.id && playing}<Icon name="pause" size={11}/>{:else}<span class="group-hover:hidden">{track.track_number || index + 1}</span><span class="hidden group-hover:block"><Icon name="play" size={10}/></span>{/if}</button>
								<div class="hidden min-w-0 truncate pr-2 text-mauve sm:block">{track.artist}</div>
								<div class="flex min-w-0 items-center gap-2 pr-2"><span class="truncate text-teal">{track.title}</span><button onclick={(event) => toggleStar(track, event)} class="ml-auto hidden shrink-0 text-overlay0 group-hover:block hover:text-pink {starredIds.has(track.id) ? '!block text-pink' : ''}" aria-label="Toggle favorite"><Icon name="heart" size={11}/></button><span class="truncate text-[9px] text-overlay0 sm:hidden"> · {track.artist}</span></div>
								<div class="hidden min-w-0 truncate pr-2 text-subtext0 sm:block">{track.album}</div>
								<div class="text-right font-mono text-[10px] text-overlay0">{formatTime(track.duration_seconds)}</div>
							</div>
						{/snippet}
					</VList>
				</div>
			</section>

			<aside class="min-h-0 flex-col bg-mantle {mobilePane === 'albums' ? 'flex' : 'hidden'} lg:flex">
				<div class="flex h-10 shrink-0 items-center justify-between border-b border-surface0 px-3"><div><strong class="text-xs">ALBUMS</strong><span class="ml-2 font-mono text-[10px] text-overlay0">{albums.length}</span></div>{#if activeAlbum}<button onclick={clearAlbum} class="font-mono text-[10px] text-mauve hover:text-pink">CLEAR FILTER</button>{/if}</div>
				<div class="min-h-0 flex-1 overflow-y-auto p-3">
					<div class="grid grid-cols-[repeat(auto-fill,minmax(125px,1fr))] gap-x-3 gap-y-5">
						{#each albums as album (album.id)}
							<article class="group min-w-0 {activeAlbumId === album.id ? 'text-mauve' : ''}">
								<div class="relative border-2 bg-base transition {activeAlbumId === album.id ? 'border-mauve' : 'border-transparent hover:border-surface2'}"><button onclick={() => selectAlbum(album)} class="block w-full"><Cover {client} id={album.cover_art_id} title={album.title} class="w-full" /></button><button onclick={() => playAlbum(album)} class="absolute bottom-2 right-2 grid size-8 translate-y-1 place-items-center rounded-full bg-mauve text-crust opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100"><Icon name="play" size={13}/></button></div>
								<button onclick={() => selectAlbum(album)} class="mt-2 block w-full text-left"><h3 class="truncate text-[11px] font-semibold text-text">{album.title}</h3><p class="mt-0.5 truncate text-[10px] text-overlay1">{album.album_artist || album.artist}</p></button>
							</article>
						{/each}
					</div>
				</div>
			</aside>
		</div>

		<footer class="relative border-t border-surface1 bg-crust">
			<input type="range" min="0" max={duration || currentTrack?.duration_seconds || 0} value={currentTime} oninput={seek} class="absolute inset-x-0 top-0 h-1 w-full cursor-pointer accent-mauve" aria-label="Playback position"/>
			<div class="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-3 pt-1 sm:px-5">
				<div class="flex items-center gap-1 text-overlay1"><button onclick={() => (shuffle = !shuffle)} class="hidden size-8 place-items-center hover:text-text sm:grid {shuffle ? 'text-teal' : ''}" title="Shuffle"><Icon name="shuffle" size={14}/></button><button onclick={() => skip(-1)} disabled={!currentTrack} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><Icon name="previous" size={16}/></button><button onclick={togglePlayback} disabled={!currentTrack || audioLoading} class="grid size-10 place-items-center bg-text text-crust hover:bg-mauve disabled:opacity-30">{#if audioLoading}<span class="size-3 animate-spin rounded-full border-2 border-crust/30 border-t-crust"></span>{:else if playing}<Icon name="pause" size={15}/>{:else}<Icon name="play" size={15}/>{/if}</button><button onclick={() => skip(1)} disabled={!currentTrack} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><Icon name="next" size={16}/></button><button onclick={() => (repeat = !repeat)} class="hidden size-8 place-items-center hover:text-text sm:grid {repeat ? 'text-teal' : ''}" title="Repeat"><Icon name="repeat" size={14}/></button></div>

				<div class="flex min-w-0 items-center gap-3">{#if currentTrack}<Cover {client} id={currentTrack.cover_art_id} title={currentTrack.album} class="hidden size-12 shrink-0 sm:block" />{/if}<div class="min-w-0"><p class="truncate text-xs font-semibold">{currentTrack?.title || 'Nothing playing'}</p><p class="mt-1 truncate text-[10px] text-overlay1">{#if playerError}<span class="text-red">{playerError}</span>{:else if currentTrack}{currentTrack.artist} · {currentTrack.album}{:else}{summary.track_count} tracks · {summary.album_count} albums{/if}</p></div></div>

				<div class="flex items-center gap-3"><span class="hidden font-mono text-[10px] text-overlay0 md:block">{formatTime(currentTime)} / {formatTime(duration || currentTrack?.duration_seconds)}</span><div class="hidden items-center gap-2 text-overlay1 sm:flex"><Icon name="volume" size={14}/><input type="range" min="0" max="1" step="0.01" value={volume} oninput={changeVolume} class="h-1 w-20 cursor-pointer accent-teal" aria-label="Volume"/></div></div>
			</div>
		</footer>

		{#if connectionError}<div class="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 border border-red/40 bg-crust px-4 py-3 text-xs text-red shadow-float"><span>{connectionError}</span><button onclick={() => (connectionError = '')}><Icon name="close" size={14}/></button></div>{/if}

		{#if settingsOpen}
			<div class="fixed inset-0 z-[70] grid place-items-center bg-crust/75 p-4 backdrop-blur-sm" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) settingsOpen = false; }}>
				<div class="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto border border-surface1 bg-base shadow-float" role="dialog" aria-modal="true" aria-labelledby="settings-title">
					<form onsubmit={(event) => { event.preventDefault(); applySettings(); }}>
						<div class="flex items-center justify-between border-b border-surface0 bg-mantle px-5 py-4"><div><p class="font-mono text-[10px] uppercase tracking-[.16em] text-overlay0">Connection</p><h2 id="settings-title" class="mt-1 text-lg font-semibold">Client settings</h2></div><button type="button" onclick={() => (settingsOpen = false)} class="grid size-8 place-items-center text-overlay1 hover:bg-surface0 hover:text-text"><Icon name="close" size={16}/></button></div>
						<div class="space-y-5 p-5">
							<div><label for="settings-ticket" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label><textarea id="settings-ticket" value={settingsTicket} oninput={updateSettingsTicket} rows="3" spellcheck="false" autocomplete="off" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 outline-none focus:border-mauve"></textarea></div>
							<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>manual address override<span class="h-px flex-1 bg-surface0"></span></div>
							<div><label for="settings-endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="settings-endpoint" bind:value={settingsEndpoint} spellcheck="false" autocomplete="off" placeholder="Leave empty to use ticket" class="h-11 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
							<div><div class="mb-2 flex items-center justify-between"><label for="settings-relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={() => addRelay(true)} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each settingsRelays as relayUrl, index}<div class="relative"><input id={`settings-relay-${index}`} bind:value={settingsRelays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if settingsRelays.length > 1}<button type="button" onclick={() => removeRelay(index, true)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div></div>
							<div><label for="settings-secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label><div class="relative"><input id="settings-secret" bind:value={settingsSecret} type={settingsShowSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (settingsShowSecret = !settingsShowSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{settingsShowSecret ? 'HIDE' : 'SHOW'}</button></div></div>
							<div class="border border-surface0 bg-mantle p-3"><p class="font-mono text-[9px] uppercase tracking-[.14em] text-overlay0">Current client endpoint ID</p><code class="mt-2 block break-all text-[11px] leading-5 text-subtext0">{client.endpointId}</code></div><p class="text-[11px] leading-5 text-overlay1">Credentials stay in this browser's localStorage. Saving restarts the iroh connection.</p>
						</div>
						<div class="flex justify-end gap-2 border-t border-surface0 bg-mantle px-5 py-3"><button type="button" onclick={() => (settingsOpen = false)} class="border border-surface1 px-4 py-2 font-mono text-[10px] text-subtext0 hover:bg-surface0">CANCEL</button><button type="submit" disabled={!(settingsEndpoint.trim() ? cleanRelays(settingsRelays).length : settingsTicket.trim()) || connecting} class="bg-mauve px-4 py-2 font-mono text-[10px] font-bold text-crust hover:bg-pink disabled:opacity-40">SAVE & RECONNECT</button></div>
					</form>
				</div>
			</div>
		{/if}

		<audio bind:this={audio} src={audioSrc} onplay={() => (playing = true)} onpause={() => (playing = false)} ontimeupdate={() => { currentTime = audio.currentTime; duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; }} onloadedmetadata={() => { duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; audio.volume = volume; }} onended={onEnded}></audio>
	</div>
{/if}
