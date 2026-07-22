<script>
  import { App } from "$lib/runes/App.svelte.js";
  import { formatTime } from "$lib/utils.js";

  import PauseIcon from "virtual:icons/ri/pause-fill";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import RepeatIcon from "virtual:icons/ri/repeat-line";
  import ShuffleIcon from "virtual:icons/ri/shuffle-line";
  import PreviousIcon from "virtual:icons/ri/skip-back-fill";
  import NextIcon from "virtual:icons/ri/skip-forward-fill";
  import VolumeIcon from "virtual:icons/ri/volume-up-line";

  import Cover from "./Cover.svelte";

  const track = $derived(App.player.currentTrack);
  const duration = $derived(App.player.duration || track?.duration_seconds || 0);
  const downloading = $derived(Boolean(track?.downloading && !track.cached && !track.memoryCached));
</script>

<footer class="border-surface1 bg-crust relative h-18 shrink-0 border-t">
  <input
    type="range"
    min="0"
    max={duration}
    bind:value={App.player.position}
    class="accent-mauve absolute inset-x-0 top-0 h-1 w-full cursor-pointer"
    aria-label="Playback position"
  />
  <div
    class="tablet-xl:px-5 grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-3 pt-1"
  >
    <div class="text-overlay1 flex items-center gap-1">
      <button
        type="button"
        onclick={() => App.player.toggleShuffle()}
        class="hover:text-text tablet-xl:grid hidden size-8 place-items-center {App.player.shuffle
          ? 'text-teal'
          : ''}"
        title="Shuffle"><ShuffleIcon class="text-sm" /></button
      >
      <button
        type="button"
        onclick={() => App.player.skip(-1)}
        disabled={!track}
        aria-label="Previous track"
        class="hover:text-text grid size-8 place-items-center disabled:opacity-25"
        ><PreviousIcon class="text-base" /></button
      >
      <button
        type="button"
        onclick={() => App.player.toggle()}
        disabled={!track || App.player.audioLoading}
        aria-label={App.player.audioLoading && downloading
          ? `Downloading ${Math.round(App.player.downloadProgress * 100)}%`
          : App.player.audioLoading
            ? "Loading"
            : App.player.playing
              ? "Pause"
              : "Play"}
        class="bg-text text-crust hover:bg-mauve relative grid size-10 overflow-hidden disabled:opacity-70"
      >
        {#if downloading}<span
            class="bg-mauve absolute inset-y-0 left-0 transition-[width] duration-150"
            style={`width:${App.player.downloadProgress * 100}%`}
            aria-hidden="true"
          ></span>{/if}
        <span class="relative z-10 grid size-full place-items-center"
          >{#if App.player.audioLoading && downloading}<span class="text-4xs font-mono font-bold"
              >{Math.round(App.player.downloadProgress * 100)}%</span
            >{:else if App.player.audioLoading}<span class="text-4xs font-mono font-bold">…</span
            >{:else if App.player.playing}<PauseIcon class="text-lg" />{:else}<PlayIcon
              class="text-lg"
            />{/if}</span
        >
      </button>
      <button
        type="button"
        onclick={() => App.player.skip(1)}
        disabled={!track}
        aria-label="Next track"
        class="hover:text-text grid size-8 place-items-center disabled:opacity-25"
        ><NextIcon class="text-base" /></button
      >
      <button
        type="button"
        onclick={() => App.player.toggleRepeat()}
        class="hover:text-text tablet-xl:grid hidden size-8 place-items-center {App.player.repeat
          ? 'text-teal'
          : ''}"
        title="Repeat"><RepeatIcon class="text-sm" /></button
      >
    </div>

    <div class="flex min-w-0 items-center gap-3">
      {#if track}<Cover
          client={App.connection.client}
          id={track.cover_art_id}
          title={track.album}
          class="tablet-xl:size-12 size-10 shrink-0"
        />{/if}
      <div class="min-w-0">
        {#if track}<button
            type="button"
            onclick={() => App.library.focusTrack(track)}
            class="hover:text-mauve block max-w-full truncate text-left text-xs font-semibold transition"
            title="Show currently playing track">{track.title}</button
          >{:else}<p class="truncate text-xs font-semibold">Nothing playing</p>{/if}
        <p class="text-3xs text-overlay1 mt-1 truncate">
          {#if App.player.error}<span class="text-red">{App.player.error}</span
            >{:else if track}{track.artist} ·
            <button
              type="button"
              onclick={() => App.library.focusTrack(track)}
              class="hover:text-mauve transition"
              title="Show currently playing track">{track.album}</button
            >{:else}{App.library.summary.track_count} tracks · {App.library.summary.album_count} albums{/if}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-3">
      <span class="text-3xs text-overlay0 desktop:block hidden font-mono"
        >{formatTime(App.player.currentTime)} / {formatTime(duration)}</span
      >
      <div class="text-overlay1 tablet-xl:flex hidden items-center gap-2">
        <VolumeIcon class="text-sm" /><input
          type="range"
          min="0"
          max="1"
          step="0.01"
          bind:value={App.player.playbackVolume}
          onchange={(event) => event.currentTarget.blur()}
          class="accent-teal h-1 w-20 cursor-pointer"
          aria-label="Volume"
        />
      </div>
    </div>
  </div>
</footer>

<audio
  {@attach App.player.attachAudio}
  src={App.player.audioSrc || undefined}
  onplay={() => (App.player.playing = true)}
  onpause={() => (App.player.playing = false)}
  ontimeupdate={(event) => {
    const audio = event.currentTarget;
    App.player.currentTime = audio.currentTime;
    App.player.duration = Number.isFinite(audio.duration)
      ? audio.duration
      : track?.duration_seconds || 0;
  }}
  onloadedmetadata={(event) => {
    const audio = event.currentTarget;
    App.player.duration = Number.isFinite(audio.duration)
      ? audio.duration
      : track?.duration_seconds || 0;
    audio.volume = App.player.volume;
  }}
  onended={() => App.player.onEnded()}
></audio>
