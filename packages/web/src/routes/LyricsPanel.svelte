<script>
  import { activeLyricIndex, estimateLyrics, lyricsSourceUrl, parseLrc } from "#lib/lyrics.js";

  /** @type {{ lyrics: import('#lib/lyrics-request.js').TrackLyrics | null,
   * message: string, title: string, position: number, duration: number,
   * onclose: () => void, onretry?: () => void }} */
  const { lyrics, message, title, position, duration, onclose, onretry } = $props();
  let follow = $state(true);
  let advance = $state(0);
  const synced = $derived(parseLrc(lyrics?.synced_lyrics));
  const estimated = $derived(synced.length === 0 && Boolean(lyrics?.plain_lyrics?.trim()));
  const lines = $derived(synced.length ? synced : estimateLyrics(lyrics?.plain_lyrics, duration));
  const active = $derived(activeLyricIndex(lines, position + advance));
  const source = $derived(
    lyricsSourceUrl(lyrics?.source_url) ??
      (lyrics?.status === "Available" ? "https://lrclib.net/" : null),
  );
  const status = $derived(
    lyrics?.status === "Pending"
      ? "Looking for lyrics…"
      : lyrics?.status === "NotFound"
        ? "No lyrics found for this track."
        : lyrics?.status === "Instrumental"
          ? "Instrumental track. No sung lyrics."
          : lyrics?.status === "Unavailable"
            ? "Lyrics temporarily unavailable."
            : lyrics?.status === "Available" && !lines.length
              ? "No readable lyrics for this track."
              : "",
  );

  /** @param {HTMLElement} element @param {number} index */
  function followLine(element, index) {
    if (!follow || index !== Math.max(0, active)) return;
    const viewport = element.closest("[data-lyrics-scroll]");
    if (!(viewport instanceof HTMLElement)) return;
    if (active < 0) {
      viewport.scrollTop = 0;
      return;
    }
    const lineRect = element.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    viewport.scrollTop +=
      lineRect.top - viewRect.top - (viewport.clientHeight - lineRect.height) / 2;
  }
</script>

<section
  id="player-lyrics"
  data-native-keyboard
  aria-label="Track lyrics"
  class="border-surface1 bg-crust flex h-[min(14rem,50dvh)] shrink-0 flex-col border-t"
>
  <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
    <h2 class="min-w-0 flex-1 truncate text-sm font-semibold" {title}>Lyrics · {title}</h2>
    <label class="flex items-center gap-2 text-xs">
      <input type="checkbox" bind:checked={follow} class="accent-mauve" /> Follow playback
    </label>
    <button
      type="button"
      onclick={onclose}
      aria-label="Close lyrics"
      class="hover:text-mauve text-xs">Close</button
    >
  </div>
  {#if lines.length}
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-xs">
      {#if estimated}
        <p class="text-yellow font-semibold">
          Estimated scrolling · plain text, duration-based approximation
        </p>
      {:else}
        <p class="text-overlay1">Synced lyrics</p>
        <label class="flex items-center gap-2">
          Lyrics advance (seconds)
          <input
            type="number"
            min="-10"
            max="10"
            step="0.5"
            bind:value={
              () => advance, (value) => (advance = Math.max(-10, Math.min(10, Number(value) || 0)))
            }
            class="border-surface1 bg-base w-16 border px-1"
          />
        </label>
      {/if}
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard access to the scroll region.) -->
  <div
    data-lyrics-scroll
    role="region"
    aria-label="Scrollable lyrics"
    tabindex="0"
    class="focus-visible:outline-mauve min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 text-center focus-visible:outline-2"
  >
    {#if status || message}
      <div role="status" class="text-overlay1 py-4 text-sm">
        {#if status}<p>{status}</p>{/if}
        {#if message}<p>{message}</p>{/if}
        {#if onretry && (lyrics?.status === "Unavailable" || message.startsWith("Automatic retries paused") || message.startsWith("Lyrics unavailable."))}
          <button type="button" onclick={onretry} class="text-mauve mt-2 underline">
            Retry lyrics
          </button>
        {/if}
      </div>
    {/if}
    {#if lines.length}
      <div class="mx-auto max-w-3xl py-4">
        {#each lines as line, index}
          <p
            data-lyric-index={index}
            aria-current={active >= 0 && lines[active].time === line.time ? "true" : undefined}
            class="min-h-10 py-2 text-base leading-6 break-words whitespace-pre-wrap {active >= 0 &&
            lines[active].time === line.time
              ? 'text-mauve font-semibold'
              : 'text-overlay1'}"
            {@attach (element) => followLine(element, index)}
          >
            {line.text || "♪"}
          </p>
        {/each}
      </div>
    {/if}
  </div>
  {#if source}
    <p class="text-overlay1 shrink-0 px-4 py-1 text-xs">
      Lyrics provided by <a
        href={source}
        target="_blank"
        rel="noopener noreferrer"
        class="text-mauve underline">LRCLIB</a
      >
    </p>
  {/if}
</section>
