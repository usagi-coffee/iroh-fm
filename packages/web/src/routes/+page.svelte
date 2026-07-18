<script>
	// @ts-nocheck
	import { MusicClient } from '@iroh-fm/client';
	import { base } from '$app/paths';
	import { onMount, tick } from 'svelte';
	import { VList } from 'virtua/svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';

	const ROW_HEIGHT = 30;
	const TRACK_LIST_BUFFER = ROW_HEIGHT * 60;
	const TRACK_COVER_MARGIN = '1400px';
	const ALBUM_MIN_WIDTH = 125;
	const ALBUM_GAP = 12;
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
	let connectionStep = $state('Connecting to the iroh server…');
	let connectionError = $state('');
	let client = $state(null);
	let connectionInfo = $state({ path_type: 'unknown', address: '', received_bytes: 0 });

	let summary = $state({ artist_count: 0, album_count: 0, track_count: 0 });
	let albums = $state([]);
	let artists = $state([]);
	let tracks = $state([]);
	let starred = $state({ artists: [], albums: [], tracks: [] });
	let starredTrackIds = $state(new Set());

	let query = $state('');
	let favoriteOnly = $state(false);
	let activeAlbumId = $state(null);
	let selectedTrackId = $state(null);
	let mobilePane = $state('tracks');

	let trackList = $state();
	let trackViewRevision = $state(0);
	let albumGridElement = $state();
	let albumColumns = $state(3);

	let settingsOpen = $state(false);
	let settingsTicket = $state('');
	let settingsEndpoint = $state('');
	let settingsRelays = $state(['']);
	let settingsSecret = $state('');
	let starredKey = $state('');
	let settingsStarredKey = $state('');
	let settingsShowSecret = $state(false);
	let settingsStorage = $state({ loading: false, requesting: false, tracks: 0, trackSize: 0, covers: 0, coverSize: 0, usage: 0, quota: 0, persisted: false, supported: false });
	let endpointCopied = $state(false);
	let ticketLinkCopied = $state(false);

	let audio = $state();
	let audioSrc = $state('');
	let audioSource = $state(null);
	let currentTrack = $state(null);
	let queue = $state([]);
	let playing = $state(false);
	let audioLoading = $state(false);
	let audioDownloadProgress = $state(0);
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
	let autoConnectAttempted = false;

	const activeAlbum = $derived(albums.find((album) => album.id === activeAlbumId) ?? null);
	const starredTracks = $derived.by(() => {
		const byId = new Map(starred.tracks.map((track) => [track.id, track]));
		const tracksById = new Map(tracks.map((track) => [track.id, track]));
		const albumsById = new Map(albums.map((album) => [album.id, album]));
		const addAlbum = (album) => {
			if (!album) return;
			for (const trackId of album.track_ids) {
				const track = tracksById.get(trackId);
				if (track) byId.set(track.id, track);
			}
		};
		for (const album of starred.albums) addAlbum(album);
		for (const artist of starred.artists) {
			for (const albumId of artist.album_ids) addAlbum(albumsById.get(albumId));
		}
		return [...byId.values()];
	});
	const filteredTracks = $derived(filterTracks(favoriteOnly ? starredTracks : tracks, query));
	const trackListItems = $derived.by(() => {
		const albumByTrackId = new Map();
		for (const album of albums) {
			for (const trackId of album.track_ids) albumByTrackId.set(trackId, album);
		}
		const durationByAlbum = new Map();
		const tracksByAlbum = new Map();
		for (const track of tracks) {
			const album = albumByTrackId.get(track.id);
			const albumKey = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
			durationByAlbum.set(albumKey, (durationByAlbum.get(albumKey) ?? 0) + (track.duration_seconds ?? 0));
			const albumTracks = tracksByAlbum.get(albumKey) ?? [];
			albumTracks.push(track);
			tracksByAlbum.set(albumKey, albumTracks);
		}
		const items = [];
		let previousAlbumKey = null;
		for (const [trackIndex, track] of filteredTracks.entries()) {
			const album = albumByTrackId.get(track.id);
			const albumKey = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
			if (albumKey !== previousAlbumKey) {
				items.push({
					kind: 'album',
					key: `album:${albumKey}`,
					title: album?.title ?? track.album,
					artist: album?.album_artist ?? album?.artist ?? track.album_artist ?? track.artist,
					coverArtId: album?.cover_art_id ?? track.cover_art_id,
					durationSeconds: album?.duration_seconds ?? durationByAlbum.get(albumKey) ?? 0,
					tracks: tracksByAlbum.get(albumKey) ?? [track]
				});
				previousAlbumKey = albumKey;
			}
			items.push({ kind: 'track', key: `track:${track.id}`, track, trackIndex });
		}
		return items;
	});
	const albumRows = $derived.by(() => {
		const rows = [];
		for (let index = 0; index < albums.length; index += albumColumns) {
			rows.push(albums.slice(index, index + albumColumns));
		}
		return rows;
	});

	onMount(() => {
		ticket = localStorage.getItem('iroh-fm-ticket') ?? '';
		endpoint = localStorage.getItem('iroh-fm-endpoint') ?? '';
		relays = readStoredRelays();
		secret = localStorage.getItem('iroh-fm-secret') ?? '';
		starredKey = localStorage.getItem('iroh-fm-starred-key') ?? localStorage.getItem('iroh-fm-loved-key') ?? '';
		const storedVolume = localStorage.getItem('iroh-fm-volume');
		if (storedVolume !== null) {
			const parsedVolume = Number(storedVolume);
			if (Number.isFinite(parsedVolume)) volume = Math.min(1, Math.max(0, parsedVolume));
		}
		const importConnection = () => {
			const linked = connectionFromHash(location.hash);
			if (linked.ticket) ticket = linked.ticket;
			if (linked.secret) {
				secret = linked.secret;
				localStorage.setItem('iroh-fm-secret', secret);
				updateIdentity(secret);
			}
			if (loginTab === 'advanced') syncTicketAddress(ticket);
		};
		importConnection();
		window.addEventListener('hashchange', importConnection);
		let mounted = true;
		initializeIdentity().then(() => {
			if (mounted) autoConnectOnce();
		});
		return () => {
			mounted = false;
			window.removeEventListener('hashchange', importConnection);
			stopQrScanner();
		};
	});

	$effect(() => {
		if (!albumGridElement) return;
		const update = (width) => {
			if (width <= 0) return;
			const available = Math.max(0, width - 24);
			albumColumns = Math.max(1, Math.floor((available + ALBUM_GAP) / (ALBUM_MIN_WIDTH + ALBUM_GAP)));
		};
		update(albumGridElement.clientWidth);
		const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
		observer.observe(albumGridElement);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!client) {
			connectionInfo = { path_type: 'unknown', address: '', received_bytes: 0 };
			return;
		}
		const update = () => {
			try {
				connectionInfo = client.connectionInfo();
			} catch {
				// The connection may be closing while the settings are being applied.
			}
		};
		update();
		const interval = setInterval(update, 1000);
		return () => clearInterval(interval);
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

	function connectionFromHash(hash) {
		const fragment = hash.replace(/^#/, '').trim();
		if (!fragment) return { ticket: '', secret: '' };
		const parameters = new URLSearchParams(fragment);
		const ticketParameter = parameters.get('ticket')?.trim() ?? '';
		const secretParameter = parameters.get('secret')?.trim() ?? '';
		if (ticketParameter || secretParameter) {
			return { ticket: ticketParameter, secret: secretParameter };
		}
		try {
			const raw = decodeURIComponent(fragment);
			return { ticket: raw.startsWith('endpoint') ? raw : '', secret: '' };
		} catch {
			return { ticket: '', secret: '' };
		}
	}

	function connectionFromScannedValue(value) {
		try {
			const url = new URL(value);
			const linked = connectionFromHash(url.hash);
			return linked.ticket || linked.secret ? linked : { ticket: value.trim(), secret: '' };
		} catch {
			const linked = connectionFromHash(value);
			return linked.ticket || linked.secret ? linked : { ticket: value.trim(), secret: '' };
		}
	}

	async function copyTicketLink() {
		if (!ticket.trim()) return;
		try {
			const url = new URL(location.href);
			const setup = new URLSearchParams({ ticket: ticket.trim() });
			if (secret.trim()) setup.set('secret', secret.trim());
			url.hash = setup.toString();
			await navigator.clipboard.writeText(url.toString());
			ticketLinkCopied = true;
			setTimeout(() => (ticketLinkCopied = false), 1600);
		} catch (error) {
			connectionError = friendlyError(error, 'Could not copy the ticket link.');
		}
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

	async function generateClientIdentity() {
		if (identityLoading || connecting) return;
		identityLoading = true;
		connectionError = '';
		try {
			const identity = await MusicClient.generateIdentity();
			secret = identity.secret;
			clientEndpointId = identity.endpointId;
			localStorage.setItem('iroh-fm-secret', secret);
			endpointCopied = false;
		} catch (error) {
			connectionError = friendlyError(error, 'Could not generate a new client identity.');
		} finally {
			identityLoading = false;
		}
	}

	async function autoConnectOnce() {
		if (autoConnectAttempted || !ticket.trim() || !clientEndpointId) return;
		autoConnectAttempted = true;
		await connect(true);
	}

	function canConnect(forceTicket = loginTab === 'ticket') {
		if (forceTicket) return Boolean(ticket.trim());
		return endpoint.trim() ? cleanRelays(relays).length > 0 : Boolean(ticket.trim());
	}

	async function connect(forceTicket = false) {
		if (!canConnect(forceTicket) || connecting) return;
		connecting = true;
		connectionError = '';
		connectionStep = 'Connecting to the iroh server…';
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
			const data = await nextClient.bootstrap(starredKey);
			client = nextClient;
			summary = variant(data.summary, 'LibrarySummary', summary);
			albums = variant(data.albums, 'Albums', []).sort(albumSort);
			artists = variant(data.artists, 'Artists', []);
			tracks = variant(data.tracks, 'Tracks', []).sort(trackSort);
			starred = variant(data.starred, 'Starred', starred);
			starredTrackIds = new Set(starred.tracks.map((item) => item.id));
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
		settingsStarredKey = starredKey;
		settingsShowSecret = false;
		settingsOpen = true;
		refreshStorageInfo();
		if (settingsTicket.trim()) syncSettingsTicketAddress(settingsTicket);
	}

	async function refreshStorageInfo() {
		settingsStorage = { ...settingsStorage, loading: true, supported: Boolean(navigator.storage) };
		try {
			const [cacheStats, estimate, persisted] = await Promise.all([
				client?.cacheStats() ?? MusicClient.cacheStats(),
				navigator.storage?.estimate?.() ?? Promise.resolve({}),
				navigator.storage?.persisted?.() ?? Promise.resolve(false)
			]);
			settingsStorage = {
				...settingsStorage,
				loading: false,
				tracks: cacheStats.tracks.count,
				trackSize: cacheStats.tracks.size,
				covers: cacheStats.covers.count,
				coverSize: cacheStats.covers.size,
				usage: estimate.usage ?? 0,
				quota: estimate.quota ?? 0,
				persisted
			};
		} catch (error) {
			console.warn('[storage] could not read cache statistics', error);
			settingsStorage = { ...settingsStorage, loading: false };
		}
	}

	async function requestPersistentStorage() {
		if (!navigator.storage?.persist) return;
		settingsStorage = { ...settingsStorage, requesting: true };
		try {
			await navigator.storage.persist();
		} finally {
			settingsStorage = { ...settingsStorage, requesting: false };
			await refreshStorageInfo();
		}
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
		starredKey = settingsStarredKey.trim();
		if (starredKey) localStorage.setItem('iroh-fm-starred-key', starredKey);
		else localStorage.removeItem('iroh-fm-starred-key');
		localStorage.removeItem('iroh-fm-loved-key');
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
						const linked = connectionFromScannedValue(codes[0].rawValue);
						if (linked.ticket) ticket = linked.ticket;
						if (linked.secret) {
							secret = linked.secret;
							localStorage.setItem('iroh-fm-secret', secret);
							updateIdentity(secret);
						}
						if (loginTab === 'advanced') syncTicketAddress(ticket);
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
		trackViewRevision += 1;
	}

	function resetTrackScroll() {
		trackList?.scrollToIndex(0);
	}

	async function showTrackView(starredOnly) {
		favoriteOnly = starredOnly;
		activeAlbumId = null;
		query = '';
		mobilePane = 'tracks';
		trackViewRevision += 1;
		await tick();
		resetTrackScroll();
		if (!starredOnly) return;
		try {
			const response = await client.request(starredKey ? { GetStarredWithKey: { key: starredKey } } : 'GetStarred');
			starred = variant(response, 'Starred', starred);
			starredTrackIds = new Set(starred.tracks.map((track) => track.id));
			if (favoriteOnly) {
				trackViewRevision += 1;
				await tick();
				resetTrackScroll();
			}
		} catch (error) {
			connectionError = friendlyError(error, 'Could not refresh starred tracks.');
		}
	}

	async function selectAlbum(album) {
		activeAlbumId = album.id;
		mobilePane = 'tracks';
		favoriteOnly = false;
		query = '';
		trackViewRevision += 1;
		const albumTrackIds = new Set(album.track_ids);
		const firstTrack = tracks.find((track) => albumTrackIds.has(track.id));
		if (!firstTrack) return null;
		selectedTrackId = firstTrack.id;
		await tick();
		const index = trackListItems.findIndex((item) => item.kind === 'track' && item.track.id === firstTrack.id);
		if (index >= 0) trackList?.scrollToIndex(index, { align: 'center' });
		return firstTrack;
	}

	async function activateAlbum(album) {
		const firstTrack = await selectAlbum(album);
		if (firstTrack && window.matchMedia('(max-width: 1023px)').matches) await playAlbum(album);
	}

	async function playAndSelectAlbum(album) {
		const firstTrack = await selectAlbum(album);
		if (firstTrack) await playAlbum(album);
	}

	function clearAlbum() {
		activeAlbumId = null;
	}

	async function toggleStar(track, event) {
		event?.stopPropagation();
		const shouldStar = !starredTrackIds.has(track.id);
		try {
			await client.request(starredKey
				? { SetStarredWithKey: { id: track.id, starred: shouldStar, key: starredKey } }
				: { SetStarred: { id: track.id, starred: shouldStar } });
			const next = new Set(starredTrackIds);
			if (shouldStar) next.add(track.id);
			else next.delete(track.id);
			starredTrackIds = next;
			starred = {
				...starred,
				tracks: shouldStar
					? [track, ...starred.tracks.filter((item) => item.id !== track.id)]
					: starred.tracks.filter((item) => item.id !== track.id)
			};
			if (favoriteOnly) trackViewRevision += 1;
		} catch (error) {
			connectionError = friendlyError(error, 'Could not update the favorite.');
		}
	}

	async function playAlbum(album) {
		const ids = new Set(album.track_ids);
		const albumQueue = tracks.filter((track) => ids.has(track.id)).sort(trackSort);
		if (albumQueue[0]) await playTrack(albumQueue[0], albumQueue);
	}

	function prefetchNextTrack(track, sourceQueue, generation) {
		if (generation !== playGeneration || shuffle || repeat || sourceQueue.length < 2) return;
		const index = sourceQueue.findIndex((item) => item.id === track.id);
		if (index < 0) return;
		const next = sourceQueue[(index + 1) % sourceQueue.length];
		if (!next || next.id === track.id) return;
		client.prefetchTrack(next.id).catch((error) => console.warn('[player] next-track prefetch failed', error));
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
		audioDownloadProgress = 0;
		playing = false;
		try {
			const source = await client.trackSource(track.id, (received, total) => {
				if (generation !== playGeneration || total <= 0) return;
				audioDownloadProgress = Math.min(1, received / total);
			});
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
			source.done.then(
				() => prefetchNextTrack(track, sourceQueue, generation),
				(error) => {
					if (audioSource === source && !source.disposed) playerError = friendlyError(error, 'Stream interrupted.');
				}
			);
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

	async function playFromTrackList(track, sourceQueue = filteredTracks) {
		selectedTrackId = track.id;
		await playOrToggle(track, sourceQueue);
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
		audioDownloadProgress = 0;
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
		volume = Math.min(1, Math.max(0, Number(event.currentTarget.value)));
		localStorage.setItem('iroh-fm-volume', String(volume));
		if (audio) audio.volume = volume;
	}

	function filterTracks(list, term) {
		const needle = term.trim().toLocaleLowerCase();
		return list.filter((track) => {
			if (!needle) return true;
			return `${track.artist}\n${track.title}\n${track.album}`.toLocaleLowerCase().includes(needle);
		});
	}

	function trackSort(left, right) {
		return left.album.localeCompare(right.album, undefined, { numeric: true })
			|| (left.disc_number || 0) - (right.disc_number || 0)
			|| (left.track_number || 0) - (right.track_number || 0)
			|| left.artist.localeCompare(right.artist, undefined, { numeric: true })
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

	function formatBytes(bytes) {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
		const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
		const value = bytes / 1024 ** unit;
		return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
	}

	function connectionAddressLabel(info) {
		if (!info.address) return 'CONNECTING';
		if (info.path_type !== 'relay') return info.path_type.toUpperCase();
		try {
			return new URL(info.address).host;
		} catch {
			return info.address;
		}
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
		<div class="absolute inset-0 hidden grid-rows-[34px_minmax(0,1fr)_72px] select-none opacity-65 sm:grid" aria-hidden="true">
			<header class="flex items-center border-b border-surface0 bg-crust text-[11px]"><div class="grid h-full w-10 shrink-0 place-items-center border-r border-surface0"><img src={`${base}/pwa-icon-192.png`} alt="" class="size-6" /></div><span class="border-r border-surface0 bg-surface0 px-4 py-2 font-semibold">SONGS</span><span class="px-4 font-semibold text-overlay1">STARRED</span><span class="ml-auto px-4 font-mono text-overlay0">REMOTE LIBRARY</span></header>
			<div class="grid min-h-0 grid-cols-[minmax(0,2fr)_minmax(330px,1fr)]">
				<section class="min-h-0 border-r border-surface0 bg-base"><div class="flex h-10 items-center gap-3 border-b border-surface0 bg-mantle px-3 text-overlay0"><Icon name="search" size={14}/><span class="font-mono text-xs">Filter artist, title, album…</span><span class="ml-auto font-mono text-[10px]">128 TRACKS</span></div><div class="grid h-7 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0"><span>#</span><span>Artist</span><span>Title</span><span>Album</span><span>Time</span></div>{#each DEMO_TRACKS as track}<div class="grid h-[30px] grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0/40 px-2 text-[11px]"><span class="font-mono text-overlay0">{track[0]}</span><span class="truncate pr-2 text-mauve">{track[1]}</span><span class="truncate pr-2 text-teal">{track[2]}</span><span class="truncate pr-2 text-subtext0">{track[3]}</span><span class="font-mono text-overlay0">{track[4]}</span></div>{/each}</section>
				<aside class="min-h-0 bg-mantle p-3"><div class="mb-3 flex h-7 items-center justify-between"><strong class="text-xs">ALBUMS</strong><span class="font-mono text-[10px] text-overlay0">24</span></div><div class="grid grid-cols-3 gap-x-3 gap-y-5">{#each DEMO_ALBUMS as album, index}<article class="min-w-0"><div class={`grid aspect-square place-items-center bg-gradient-to-br ${album[2]}`}><div class="grid size-1/2 place-items-center rounded-full border border-crust/20 bg-crust/25"><div class="size-2 rounded-full bg-text/50"></div></div></div><h3 class="mt-2 truncate text-[11px] font-semibold">{album[0]}</h3><p class="truncate text-[10px] text-overlay1">{album[1]}</p></article>{/each}</div></aside>
			</div>
			<footer class="border-t border-surface1 bg-crust"><div class="h-1 bg-surface0"><div class="h-full w-1/3 bg-mauve"></div></div><div class="grid h-[68px] grid-cols-[auto_1fr_auto] items-center gap-4 px-5"><div class="flex items-center gap-2 text-overlay1"><Icon name="previous" size={16}/><span class="grid size-10 place-items-center bg-text text-crust"><Icon name="play" size={14}/></span><Icon name="next" size={16}/></div><div><p class="text-xs font-semibold">Anywhere Between</p><p class="mt-1 text-[10px] text-overlay1">Nacre · Still Light</p></div><span class="font-mono text-[10px] text-overlay0">1:12 / 3:42</span></div></footer>
		</div>

		<div class="absolute inset-0 bg-crust sm:bg-crust/35 sm:backdrop-blur-[3px]"></div>
		<section class="absolute inset-0 z-10 grid place-items-center overflow-y-auto p-4 sm:p-8">
			<form onsubmit={(event) => { event.preventDefault(); connect(loginTab === 'ticket'); }} class="my-auto w-[calc(100vw-2rem)] max-w-[29rem] border border-surface1 bg-base shadow-float">
				<div class="border-b border-surface0 bg-mantle px-5 pt-5"><div class="mb-5 flex items-center gap-3"><img src={`${base}/pwa-icon-192.png`} alt="" class="size-9" /><div><h1 class="text-[16px] font-semibold text-text">Enter your library</h1><p class="mt-0.5 text-[11px] text-overlay1">Connect privately with iroh</p></div></div><div class="flex gap-5 font-mono text-[10px] font-bold uppercase tracking-wider"><button type="button" onclick={() => selectLoginTab('ticket')} class="border-b-2 pb-3 {loginTab === 'ticket' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Ticket</button><button type="button" onclick={() => selectLoginTab('advanced')} class="border-b-2 pb-3 {loginTab === 'advanced' ? 'border-mauve text-mauve' : 'border-transparent text-overlay1 hover:text-text'}">Advanced</button></div></div>

				<div class="space-y-4 p-5">
					<div><div class="mb-2 flex items-center justify-between gap-3"><label for="ticket" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label><div class="flex items-center gap-3"><button type="button" onclick={copyTicketLink} disabled={!ticket.trim()} title="Copy setup link including the client secret" class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="copy" size={12}/>{ticketLinkCopied ? 'COPIED' : 'COPY'}</button>{#if loginTab === 'ticket'}<button type="button" onclick={startQrScanner} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink"><Icon name="qr" size={13}/> SCAN QR</button>{/if}</div></div><textarea id="ticket" value={ticket} oninput={updateLoginTicket} rows={loginTab === 'ticket' ? 3 : 2} spellcheck="false" autocomplete="off" placeholder="endpointaa…" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 text-text outline-none placeholder:text-overlay0 focus:border-mauve"></textarea></div>

					{#if loginTab === 'advanced'}
						<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>or manual address<span class="h-px flex-1 bg-surface0"></span></div>
						<div><label for="endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="endpoint" bind:value={endpoint} spellcheck="false" autocomplete="off" placeholder="Public endpoint ID" class="h-10 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
						<div><div class="mb-2 flex items-center justify-between"><label for="relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={() => addRelay()} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each relays as relayUrl, index}<div class="relative"><input id={`relay-${index}`} bind:value={relays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if relays.length > 1}<button type="button" onclick={() => removeRelay(index)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div><p class="mt-1.5 text-[10px] text-overlay0">Valid tickets fill this address automatically. You can still edit it manually.</p></div>
						<div><label for="secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label><div class="relative"><input id="secret" value={secret} oninput={(event) => updateIdentity(event.currentTarget.value)} type={showSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-10 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (showSecret = !showSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{showSecret ? 'HIDE' : 'SHOW'}</button></div></div>
					{/if}

					<div><div class="mb-2 flex items-center justify-between gap-3"><p class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client endpoint ID</p><div class="flex items-center gap-3"><button type="button" onclick={generateClientIdentity} disabled={identityLoading || connecting} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="refresh" size={12}/>GENERATE</button><button type="button" onclick={copyEndpointId} disabled={!clientEndpointId} class="flex items-center gap-1.5 font-mono text-[10px] text-mauve hover:text-pink disabled:text-overlay0"><Icon name="copy" size={12}/>{endpointCopied ? 'COPIED' : 'COPY'}</button></div></div><div class="border border-surface0 bg-mantle/70 px-3 py-2.5"><code class="block truncate text-[10px] text-subtext0">{identityLoading ? 'Generating secure identity…' : clientEndpointId || 'Invalid client secret'}</code></div></div>

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
			<div class="grid h-full w-10 shrink-0 place-items-center border-r border-surface0"><img src={`${base}/pwa-icon-192.png`} alt="iroh.fm" class="size-6" /></div>
			<nav class="flex h-full min-w-0 items-stretch">
				<button onclick={() => showTrackView(false)} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {mobilePane === 'tracks' && !favoriteOnly ? 'bg-surface0 text-text' : 'text-overlay1'}">SONGS</button>
				<button onclick={() => (mobilePane = 'albums')} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold text-overlay1 transition hover:bg-surface0 lg:hidden {mobilePane === 'albums' ? 'bg-surface0 text-text' : ''}">ALBUMS</button>
				<button onclick={() => showTrackView(true)} class="whitespace-nowrap border-r border-surface0 px-3 font-semibold transition hover:bg-surface0 {favoriteOnly ? 'bg-surface0 text-pink' : 'text-overlay1'}">STARRED</button>
			</nav>
			<div class="ml-auto flex h-full min-w-0 items-center">
				<div class="hidden h-full min-w-0 items-center gap-2 border-l border-surface0 px-3 font-mono text-[9px] text-overlay1 lg:flex" title={`${connectionInfo.path_type}: ${connectionInfo.address || 'selecting path'} · ${formatBytes(connectionInfo.received_bytes)} received`}><span class="size-1.5 shrink-0 rounded-full {connectionInfo.address ? 'bg-green' : 'animate-pulse bg-yellow'}"></span><span class="max-w-44 truncate text-subtext0">{connectionAddressLabel(connectionInfo)}</span><span class="shrink-0 text-overlay0">↓ {formatBytes(connectionInfo.received_bytes)}</span></div>
				<button onclick={openSettings} class="grid h-full w-9 place-items-center border-l border-surface0 text-overlay1 hover:bg-surface0 hover:text-mauve" title="Connection settings"><Icon name="settings" size={15}/></button>
				<button onclick={disconnect} class="grid h-full w-9 place-items-center border-l border-surface0 text-overlay1 hover:bg-surface0 hover:text-red" title="Disconnect"><Icon name="disconnect" size={15}/></button>
			</div>
		</header>

		<div class="grid min-h-0 lg:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
			<section class="min-h-0 flex-col border-r border-surface0 bg-base {mobilePane === 'tracks' ? 'flex' : 'hidden'} lg:flex">
				<div class="flex h-10 shrink-0 items-center gap-3 border-b border-surface0 bg-mantle px-3">
					<Icon name="search" size={14}/><input value={query} oninput={updateQuery} placeholder="Filter artist, title, album…" class="min-w-0 flex-1 bg-transparent font-mono text-xs text-text outline-none placeholder:text-overlay0"/>
					<span class="shrink-0 font-mono text-[10px] text-overlay0">{filteredTracks.length} / {summary.track_count}</span>
				</div>

				<div class="hidden h-7 shrink-0 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b border-surface0 bg-mantle px-2 font-mono text-[9px] uppercase tracking-wider text-overlay0 sm:grid"><span>#</span><span>Album</span><span>Title</span><span>Artist</span><span class="text-right">Time</span></div>

				<div class="min-h-0 flex-1">
					{#key trackViewRevision}
					<VList data={trackListItems} getKey={(item) => item.key} itemSize={ROW_HEIGHT} bufferSize={TRACK_LIST_BUFFER} bind:this={trackList} style="height: 100%; overscroll-behavior: contain;">
						{#snippet children(item)}
							{#if item.kind === 'album'}
								<button onclick={() => playTrack(item.tracks[0], item.tracks)} class="flex h-9 w-full items-center gap-2 border-y border-surface1 bg-mantle px-2 text-left transition hover:bg-surface0" aria-label={`Play album ${item.title}`}>
									<Cover {client} id={item.coverArtId} title={item.title} rootMargin={TRACK_COVER_MARGIN} class="size-7 shrink-0 rounded-sm" />
									<p class="min-w-0 flex-1 truncate text-[11px]"><span class="font-semibold text-mauve">{item.title}</span><span class="ml-2 text-[10px] text-overlay1">{item.artist}</span></p>
									<span class="shrink-0 font-mono text-[10px] text-overlay0">{formatTime(item.durationSeconds)}</span>
								</button>
							{:else}
								{@const track = item.track}
								<div role="row" tabindex="0" aria-selected={selectedTrackId === track.id} onclick={() => (selectedTrackId = track.id)} ondblclick={() => playFromTrackList(track, filteredTracks)} onkeydown={(event) => { if (event.key === 'Enter') playFromTrackList(track, filteredTracks); else if (event.key === ' ') { event.preventDefault(); selectedTrackId = track.id; } }} class="group grid grid-cols-[2rem_minmax(0,1fr)_3.2rem] items-center border-b border-surface0/35 px-2 text-[11px] transition outline-none focus:ring-1 focus:ring-inset focus:ring-mauve sm:grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] {currentTrack?.id === track.id ? 'bg-mauve/15' : selectedTrackId === track.id ? 'bg-surface0' : 'hover:bg-surface0/60'}" style={`height:${ROW_HEIGHT}px`}>
									<button onclick={(event) => { event.stopPropagation(); playFromTrackList(track, filteredTracks); }} class="grid size-6 place-items-center font-mono text-[10px] text-overlay0 hover:text-mauve" aria-label={`Play ${track.title}`}>{#if currentTrack?.id === track.id && audioLoading}<span class="h-1 w-4 overflow-hidden bg-surface1"><span class="block h-full bg-mauve transition-[width] duration-150" style={`width:${audioDownloadProgress * 100}%`}></span></span>{:else if currentTrack?.id === track.id && playing}<Icon name="pause" size={11}/>{:else}<span class="group-hover:hidden">{track.track_number || item.trackIndex + 1}</span><span class="hidden group-hover:block"><Icon name="play" size={10}/></span>{/if}</button>
									<div class="hidden min-w-0 truncate pr-2 text-mauve sm:block">{track.album}</div>
									<div class="flex min-w-0 items-center gap-2 pr-2"><span class="truncate text-teal">{track.title}</span><button onclick={(event) => toggleStar(track, event)} class="ml-auto hidden shrink-0 text-overlay0 group-hover:block hover:text-pink {starredTrackIds.has(track.id) ? '!block text-pink' : ''}" aria-label="Toggle favorite"><Icon name="heart" size={11}/></button><span class="truncate text-[9px] text-overlay0 sm:hidden"> · {track.artist}</span></div>
									<div class="hidden min-w-0 truncate pr-2 text-subtext0 sm:block">{track.artist}</div>
									<div class="text-right font-mono text-[10px] text-overlay0">{formatTime(track.duration_seconds)}</div>
								</div>
							{/if}
						{/snippet}
					</VList>
					{/key}
				</div>
			</section>

			<aside class="min-h-0 flex-col bg-mantle {mobilePane === 'albums' ? 'flex' : 'hidden'} lg:flex">
				<div class="flex h-10 shrink-0 items-center justify-between border-b border-surface0 px-3"><div><strong class="text-xs">ALBUMS</strong><span class="ml-2 font-mono text-[10px] text-overlay0">{albums.length}</span></div>{#if activeAlbum}<button onclick={clearAlbum} class="font-mono text-[10px] text-mauve hover:text-pink">CLEAR SELECTION</button>{/if}</div>
				<div bind:this={albumGridElement} class="min-h-0 flex-1">
					<VList data={albumRows} getKey={(row) => `${albumColumns}:${row.map((album) => album.id).join('|')}`} bufferSize={400} style="height: 100%; overscroll-behavior: contain;">
						{#snippet children(row, rowIndex)}
							<div class="grid gap-3 px-3 pb-5" class:pt-3={rowIndex === 0} style={`grid-template-columns:repeat(${albumColumns},minmax(0,1fr))`}>
								{#each row as album (album.id)}
									<article class="group min-w-0 {activeAlbumId === album.id ? 'text-mauve' : ''}">
										<div class="relative border-2 bg-base transition {activeAlbumId === album.id ? 'border-mauve' : 'border-transparent hover:border-surface2'}"><button onclick={() => activateAlbum(album)} ondblclick={() => playAlbum(album)} class="block w-full"><Cover {client} id={album.cover_art_id} title={album.title} class="w-full" /></button><button onclick={() => playAndSelectAlbum(album)} class="absolute bottom-2 right-2 grid size-8 translate-y-1 place-items-center rounded-full bg-mauve text-crust opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100"><Icon name="play" size={13}/></button></div>
										<button onclick={() => activateAlbum(album)} ondblclick={() => playAlbum(album)} class="mt-2 block w-full text-left"><h3 class="truncate text-[11px] font-semibold text-text">{album.title}</h3><p class="mt-0.5 truncate text-[10px] text-overlay1">{album.album_artist || album.artist}</p></button>
									</article>
								{/each}
							</div>
						{/snippet}
					</VList>
				</div>
			</aside>
		</div>

		<footer class="relative border-t border-surface1 bg-crust">
			<input type="range" min="0" max={duration || currentTrack?.duration_seconds || 0} value={currentTime} oninput={seek} class="absolute inset-x-0 top-0 h-1 w-full cursor-pointer accent-mauve" aria-label="Playback position"/>
			<div class="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-3 pt-1 sm:px-5">
				<div class="flex items-center gap-1 text-overlay1"><button onclick={() => (shuffle = !shuffle)} class="hidden size-8 place-items-center hover:text-text sm:grid {shuffle ? 'text-teal' : ''}" title="Shuffle"><Icon name="shuffle" size={14}/></button><button onclick={() => skip(-1)} disabled={!currentTrack} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><Icon name="previous" size={16}/></button><button onclick={togglePlayback} disabled={!currentTrack || audioLoading} aria-label={audioLoading ? `Downloading ${Math.round(audioDownloadProgress * 100)}%` : playing ? 'Pause' : 'Play'} class="relative grid size-10 overflow-hidden bg-text text-crust hover:bg-mauve disabled:opacity-70">{#if currentTrack && audioDownloadProgress < 1}<span class="absolute inset-y-0 left-0 bg-mauve transition-[width] duration-150" style={`width:${audioDownloadProgress * 100}%`} aria-hidden="true"></span>{/if}<span class="relative z-10 grid size-full place-items-center">{#if audioLoading}<span class="font-mono text-[9px] font-bold">{Math.round(audioDownloadProgress * 100)}%</span>{:else if playing}<Icon name="pause" size={18}/>{:else}<Icon name="play" size={18}/>{/if}</span></button><button onclick={() => skip(1)} disabled={!currentTrack} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><Icon name="next" size={16}/></button><button onclick={() => (repeat = !repeat)} class="hidden size-8 place-items-center hover:text-text sm:grid {repeat ? 'text-teal' : ''}" title="Repeat"><Icon name="repeat" size={14}/></button></div>

				<div class="flex min-w-0 items-center gap-3">{#if currentTrack}<Cover {client} id={currentTrack.cover_art_id} title={currentTrack.album} class="size-10 shrink-0 sm:size-12" />{/if}<div class="min-w-0"><p class="truncate text-xs font-semibold">{currentTrack?.title || 'Nothing playing'}</p><p class="mt-1 truncate text-[10px] text-overlay1">{#if playerError}<span class="text-red">{playerError}</span>{:else if currentTrack}{currentTrack.artist} · {currentTrack.album}{:else}{summary.track_count} tracks · {summary.album_count} albums{/if}</p></div></div>

				<div class="flex items-center gap-3"><span class="hidden font-mono text-[10px] text-overlay0 md:block">{formatTime(currentTime)} / {formatTime(duration || currentTrack?.duration_seconds)}</span><div class="hidden items-center gap-2 text-overlay1 sm:flex"><Icon name="volume" size={14}/><input type="range" min="0" max="1" step="0.01" value={volume} oninput={changeVolume} class="h-1 w-20 cursor-pointer accent-teal" aria-label="Volume"/></div></div>
			</div>
		</footer>

		{#if connectionError}<div class="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 border border-red/40 bg-crust px-4 py-3 text-xs text-red shadow-float"><span>{connectionError}</span><button onclick={() => (connectionError = '')}><Icon name="close" size={14}/></button></div>{/if}

		{#if settingsOpen}
			<div class="fixed inset-0 z-[70] grid place-items-center bg-crust/75 p-4 backdrop-blur-sm" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) settingsOpen = false; }}>
				<div class="w-full max-w-xl overflow-hidden border border-surface1 bg-base shadow-float" role="dialog" aria-modal="true" aria-labelledby="settings-title">
					<form onsubmit={(event) => { event.preventDefault(); applySettings(); }} class="flex max-h-[calc(100dvh-2rem)] flex-col">
						<div class="flex shrink-0 items-center justify-between border-b border-surface0 bg-mantle px-5 py-4"><div><p class="font-mono text-[10px] uppercase tracking-[.16em] text-overlay0">Connection</p><h2 id="settings-title" class="mt-1 text-lg font-semibold">Client settings</h2></div><button type="button" onclick={() => (settingsOpen = false)} class="grid size-8 place-items-center text-overlay1 hover:bg-surface0 hover:text-text"><Icon name="close" size={16}/></button></div>
						<div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
							<div><label for="settings-ticket" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server ticket</label><textarea id="settings-ticket" value={settingsTicket} oninput={updateSettingsTicket} rows="3" spellcheck="false" autocomplete="off" class="w-full resize-none border border-surface1 bg-mantle px-3 py-3 font-mono text-xs leading-5 outline-none focus:border-mauve"></textarea></div>
							<div class="flex items-center gap-3 text-[9px] uppercase tracking-wider text-overlay0"><span class="h-px flex-1 bg-surface0"></span>manual address override<span class="h-px flex-1 bg-surface0"></span></div>
							<div><label for="settings-endpoint" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Server endpoint ID</label><input id="settings-endpoint" bind:value={settingsEndpoint} spellcheck="false" autocomplete="off" placeholder="Leave empty to use ticket" class="h-11 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/></div>
							<div><div class="mb-2 flex items-center justify-between"><label for="settings-relay-0" class="font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Relay URLs</label><button type="button" onclick={() => addRelay(true)} class="font-mono text-[10px] text-mauve hover:text-pink">+ ADD RELAY</button></div><div class="space-y-2">{#each settingsRelays as relayUrl, index}<div class="relative"><input id={`settings-relay-${index}`} bind:value={settingsRelays[index]} spellcheck="false" autocomplete="url" placeholder="https://relay.example" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-10 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/>{#if settingsRelays.length > 1}<button type="button" onclick={() => removeRelay(index, true)} class="absolute inset-y-0 right-2 grid w-7 place-items-center text-overlay0 hover:text-red" aria-label={`Remove relay ${index + 1}`}><Icon name="close" size={12}/></button>{/if}</div>{/each}</div></div>
							<div><label for="settings-secret" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Client secret</label><div class="relative"><input id="settings-secret" bind:value={settingsSecret} type={settingsShowSecret ? 'text' : 'password'} spellcheck="false" autocomplete="new-password" class="h-11 w-full border border-surface1 bg-mantle px-3 pr-14 font-mono text-xs outline-none focus:border-mauve"/><button type="button" onclick={() => (settingsShowSecret = !settingsShowSecret)} class="absolute inset-y-0 right-3 font-mono text-[10px] text-overlay1 hover:text-mauve">{settingsShowSecret ? 'HIDE' : 'SHOW'}</button></div></div>
							<div><label for="settings-starred-key" class="mb-2 block font-mono text-[10px] uppercase tracking-[.14em] text-subtext0">Starred collection key</label><input id="settings-starred-key" bind:value={settingsStarredKey} spellcheck="false" autocomplete="off" placeholder="Default: this client identity" class="h-11 w-full border border-surface1 bg-mantle px-3 font-mono text-xs outline-none placeholder:text-overlay0 focus:border-mauve"/><p class="mt-1.5 text-[10px] leading-4 text-overlay0">Leave empty for a private collection tied to the Client Endpoint ID. Use the same custom key on multiple clients to share one collection.</p></div>
							<section class="border border-surface0 bg-mantle p-3" aria-labelledby="storage-title">
								<div class="flex items-center justify-between gap-3"><div><p id="storage-title" class="font-mono text-[9px] uppercase tracking-[.14em] text-overlay0">Offline cache</p><p class="mt-1 text-[10px] text-overlay1">Played and prefetched songs are reused across visits.</p></div><button type="button" onclick={refreshStorageInfo} disabled={settingsStorage.loading} class="shrink-0 font-mono text-[9px] text-mauve hover:text-pink disabled:opacity-40">{settingsStorage.loading ? 'READING…' : 'REFRESH'}</button></div>
								<div class="mt-3 grid grid-cols-2 gap-2"><div class="border border-surface0 bg-base p-2"><p class="font-mono text-[9px] uppercase text-overlay0">Songs</p><p class="mt-1 text-xs text-text">{settingsStorage.tracks} · {formatBytes(settingsStorage.trackSize)}</p><p class="mt-1 text-[9px] text-overlay0">Cache API</p></div><div class="border border-surface0 bg-base p-2"><p class="font-mono text-[9px] uppercase text-overlay0">Covers</p><p class="mt-1 text-xs text-text">{settingsStorage.covers} · {formatBytes(settingsStorage.coverSize)}</p><p class="mt-1 text-[9px] text-overlay0">Cache API</p></div></div>
								<div class="mt-3 flex items-center justify-between gap-3 border-t border-surface0 pt-3"><div class="min-w-0"><p class="text-[10px] text-subtext0">Browser storage: {formatBytes(settingsStorage.usage)} / {formatBytes(settingsStorage.quota)}</p><p class="mt-1 text-[9px] text-overlay0">{settingsStorage.persisted ? 'Persistent storage granted; the browser should not evict this cache automatically.' : 'Storage may be evicted under pressure. Browser quota is managed automatically.'}</p></div>{#if settingsStorage.supported && !settingsStorage.persisted}<button type="button" onclick={requestPersistentStorage} disabled={settingsStorage.requesting} class="shrink-0 border border-mauve px-2 py-1.5 font-mono text-[9px] text-mauve hover:bg-mauve hover:text-crust disabled:opacity-40">{settingsStorage.requesting ? 'REQUESTING…' : 'KEEP OFFLINE'}</button>{/if}</div>
							</section>
							<div class="border border-surface0 bg-mantle p-3"><p class="font-mono text-[9px] uppercase tracking-[.14em] text-overlay0">Current client endpoint ID</p><code class="mt-2 block break-all text-[11px] leading-5 text-subtext0">{client.endpointId}</code></div><p class="text-[11px] leading-5 text-overlay1">Credentials stay in this browser's localStorage. Saving restarts the iroh connection.</p>
						</div>
						<div class="flex shrink-0 justify-end gap-2 border-t border-surface0 bg-mantle px-5 py-3"><button type="button" onclick={() => (settingsOpen = false)} class="border border-surface1 px-4 py-2 font-mono text-[10px] text-subtext0 hover:bg-surface0">CANCEL</button><button type="submit" disabled={!(settingsEndpoint.trim() ? cleanRelays(settingsRelays).length : settingsTicket.trim()) || connecting} class="bg-mauve px-4 py-2 font-mono text-[10px] font-bold text-crust hover:bg-pink disabled:opacity-40">SAVE & RECONNECT</button></div>
					</form>
				</div>
			</div>
		{/if}

		<audio bind:this={audio} src={audioSrc} onplay={() => (playing = true)} onpause={() => (playing = false)} ontimeupdate={() => { currentTime = audio.currentTime; duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; }} onloadedmetadata={() => { duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.duration_seconds || 0; audio.volume = volume; }} onended={onEnded}></audio>
	</div>
{/if}
