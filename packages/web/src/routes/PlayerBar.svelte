<script>
	import Cover from './Cover.svelte';
	import { App } from '$lib/runes/App.svelte.js';
	import { formatTime } from '$lib/utils.js';
	import NextIcon from 'virtual:icons/ri/skip-forward-fill';
	import PauseIcon from 'virtual:icons/ri/pause-fill';
	import PlayIcon from 'virtual:icons/ri/play-fill';
	import PreviousIcon from 'virtual:icons/ri/skip-back-fill';
	import RepeatIcon from 'virtual:icons/ri/repeat-line';
	import ShuffleIcon from 'virtual:icons/ri/shuffle-line';
	import VolumeIcon from 'virtual:icons/ri/volume-up-line';

	let track = $derived(App.player.currentTrack);
	let duration = $derived(App.player.duration || track?.duration_seconds || 0);
</script>

<footer class="relative border-t border-surface1 bg-crust">
	<input type="range" min="0" max={duration} value={App.player.currentTime} oninput={(event) => App.player.seek(event.currentTarget.value)} class="absolute inset-x-0 top-0 h-1 w-full cursor-pointer accent-mauve" aria-label="Playback position"/>
	<div class="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-3 pt-1 sm:px-5">
		<div class="flex items-center gap-1 text-overlay1">
			<button type="button" onclick={() => (App.player.shuffle = !App.player.shuffle)} class="hidden size-8 place-items-center hover:text-text sm:grid {App.player.shuffle ? 'text-teal' : ''}" title="Shuffle"><ShuffleIcon class="text-sm"/></button>
			<button type="button" onclick={() => App.player.skip(-1)} disabled={!track} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><PreviousIcon class="text-base"/></button>
			<button type="button" onclick={() => App.player.toggle()} disabled={!track || App.player.audioLoading} aria-label={App.player.audioLoading ? `Downloading ${Math.round(App.player.downloadProgress * 100)}%` : App.player.playing ? 'Pause' : 'Play'} class="relative grid size-10 overflow-hidden bg-text text-crust hover:bg-mauve disabled:opacity-70">
				{#if track && App.player.downloadProgress < 1}<span class="absolute inset-y-0 left-0 bg-mauve transition-[width] duration-150" style={`width:${App.player.downloadProgress * 100}%`} aria-hidden="true"></span>{/if}
				<span class="relative z-10 grid size-full place-items-center">{#if App.player.audioLoading}<span class="font-mono text-[9px] font-bold">{Math.round(App.player.downloadProgress * 100)}%</span>{:else if App.player.playing}<PauseIcon class="text-lg"/>{:else}<PlayIcon class="text-lg"/>{/if}</span>
			</button>
			<button type="button" onclick={() => App.player.skip(1)} disabled={!track} class="grid size-8 place-items-center hover:text-text disabled:opacity-25"><NextIcon class="text-base"/></button>
			<button type="button" onclick={() => (App.player.repeat = !App.player.repeat)} class="hidden size-8 place-items-center hover:text-text sm:grid {App.player.repeat ? 'text-teal' : ''}" title="Repeat"><RepeatIcon class="text-sm"/></button>
		</div>

		<div class="flex min-w-0 items-center gap-3">{#if track}<Cover client={App.connection.client} id={track.cover_art_id} title={track.album} class="size-10 shrink-0 sm:size-12" />{/if}<div class="min-w-0"><p class="truncate text-xs font-semibold">{track?.title || 'Nothing playing'}</p><p class="mt-1 truncate text-[10px] text-overlay1">{#if App.player.error}<span class="text-red">{App.player.error}</span>{:else if track}{track.artist} · {track.album}{:else}{App.library.summary.track_count} tracks · {App.library.summary.album_count} albums{/if}</p></div></div>

		<div class="flex items-center gap-3"><span class="hidden font-mono text-[10px] text-overlay0 md:block">{formatTime(App.player.currentTime)} / {formatTime(duration)}</span><div class="hidden items-center gap-2 text-overlay1 sm:flex"><VolumeIcon class="text-sm"/><input type="range" min="0" max="1" step="0.01" value={App.player.volume} oninput={(event) => App.player.changeVolume(event.currentTarget.value)} class="h-1 w-20 cursor-pointer accent-teal" aria-label="Volume"/></div></div>
	</div>
</footer>

<audio {@attach App.player.attachAudio} src={App.player.audioSrc} onplay={() => (App.player.playing = true)} onpause={() => (App.player.playing = false)} ontimeupdate={(event) => { const audio = event.currentTarget; App.player.currentTime = audio.currentTime; App.player.duration = Number.isFinite(audio.duration) ? audio.duration : track?.duration_seconds || 0; }} onloadedmetadata={(event) => { const audio = event.currentTarget; App.player.duration = Number.isFinite(audio.duration) ? audio.duration : track?.duration_seconds || 0; audio.volume = App.player.volume; }} onended={() => App.player.onEnded()}></audio>
