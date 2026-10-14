<script>
  import { canExportLyrics } from "#lib/lyric-export.js";
  import {
    activeLyricIndex,
    estimateLyrics,
    lyricGloss,
    lyricDictionaryDescription,
    lyricsSourceUrl,
    parseLrc,
  } from "#lib/lyrics.js";
  import { App } from "#lib/runes/App.svelte.js";

  /** @type {{ lyrics: import('#lib/lyrics-request.js').TrackLyrics | null,
   * message: string, title: string, position: number, duration: number,
   * track: import('#lib/lyric-export.js').LyricExportTrack | null,
   * exporter: import('#lib/runes/LyricExport.svelte.js').LyricExport,
   * onclose: () => void, onretry?: () => void }} */
  const { lyrics, message, title, position, duration, track, exporter, onclose, onretry } =
    $props();
  let follow = $state(true);
  let furigana = $state(false);
  let meanings = $state(false);
  let advance = $state(0);
  const exportSupported = $derived(
    Boolean(
      App.connection.client &&
      "exportTrackBlob" in App.connection.client &&
      typeof App.connection.client.exportTrackBlob === "function",
    ),
  );
  const exportAvailable = $derived(
    Boolean(
      track && lyrics?.track_id === track.id && App.connection.client && canExportLyrics(lyrics),
    ),
  );
  const annotations = $derived(lyrics?.annotated_lyrics);
  const synced = $derived(parseLrc(lyrics?.synced_lyrics, annotations?.synced));
  const estimated = $derived(synced.length === 0 && Boolean(lyrics?.plain_lyrics?.trim()));
  const lines = $derived(
    synced.length ? synced : estimateLyrics(lyrics?.plain_lyrics, duration, annotations?.plain),
  );
  const hasReadings = $derived(lines.some((line) => line.parts?.some((part) => part.reading)));
  const hasDictionary = $derived(lines.some((line) => line.parts?.some((part) => part.dictionary)));
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

  function exportLyrics() {
    const client = App.connection.client;
    if (
      exporter.running ||
      !client ||
      !("exportTrackBlob" in client) ||
      typeof client.exportTrackBlob !== "function" ||
      !track ||
      !lyrics ||
      !canExportLyrics(lyrics)
    )
      return;
    void exporter.download(client, track, lyrics, duration);
  }

  /** @param {HTMLElement} element @param {number} index */
  function followLine(element, index) {
    // Recenter when ruby changes line heights as well as on seeks.
    void furigana;
    void meanings;
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
  aria-describedby="player-lyrics-description"
  class="border-surface1 bg-crust flex h-[min(14rem,50dvh)] shrink-0 flex-col border-t"
>
  <span id="player-lyrics-description" class="sr-only">{title}</span>
  <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
    <label class="flex items-center gap-2 text-xs">
      <input type="checkbox" bind:checked={follow} class="accent-mauve" /> Follow playback
    </label>
    <label
      class="flex items-center gap-1 text-xs"
      title="Automatic dictionary readings may differ from the sung pronunciation"
    >
      <input type="checkbox" bind:checked={furigana} disabled={!hasReadings} class="accent-mauve" />
      Furigana
    </label>
    {#if hasDictionary}
      <label
        class="flex items-center gap-1 text-xs"
        title="Short English dictionary senses above furigana, not a lyric translation"
      >
        <input type="checkbox" bind:checked={meanings} disabled={!furigana} class="accent-mauve" />
        Meanings <span class="text-overlay1">(dictionary)</span>
      </label>
    {/if}
    {#if lines.length && !estimated}
      <label
        class="flex items-center gap-2 text-xs"
        title="Timing offset in seconds; positive values advance lyrics"
      >
        Offset
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
    <button
      type="button"
      onclick={onclose}
      aria-label="Close lyrics"
      class="hover:text-mauve ml-auto text-xs">Close</button
    >
  </div>
  {#if exporter.message}
    <p role="status" class="text-overlay1 shrink-0 px-4 pb-2 text-xs">{exporter.message}</p>
  {/if}
  {#if lines.length && estimated}
    <div class="shrink-0 px-4 pb-2 text-xs">
      <p class="text-yellow font-semibold">
        Estimated scrolling · plain text, duration-based approximation
      </p>
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
            {#if furigana && line.parts?.length}
              {#each line.parts as part}
                {#if part.reading}
                  <ruby lang="ja" title={meanings ? lyricDictionaryDescription(part) : undefined}
                    >{part.text}<rp>(</rp><rt
                      >{#if meanings && lyricGloss(part)}<span data-lyric-meaning lang="en"
                          >{lyricGloss(part)}</span
                        >{/if}<span data-lyric-reading>{part.reading}</span></rt
                    ><rp>)</rp></ruby
                  >
                {:else}{part.text}{/if}
              {/each}
            {:else}
              {line.text || "♪"}
            {/if}
          </p>
        {/each}
      </div>
    {/if}
  </div>
  {#if source || exportSupported}
    <div class="text-overlay1 flex shrink-0 items-center justify-between gap-2 px-4 py-1 text-xs">
      <p>
        {#if source}
          Lyrics provided by <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            class="text-mauve underline">LRCLIB</a
          >
        {/if}
      </p>
      {#if exportSupported}
        <button
          type="button"
          onclick={exportLyrics}
          disabled={!exportAvailable || exporter.running}
          title="Download lyrics, automatic readings and meanings, and complete original audio in a ZIP. This song's export may finish after playback changes. Up to 512 MiB audio; audio and ZIP are held in memory."
          class="hover:text-mauve text-xs disabled:opacity-50"
          >{exporter.running ? "Exporting…" : "Export lyrics"}</button
        >
      {/if}
    </div>
  {/if}
  {#if furigana && meanings && hasDictionary}
    <p class="text-overlay1 shrink-0 px-4 py-1 text-xs">
      Automatic dictionary senses, not lyric translation · <a
        href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
        target="_blank"
        rel="noopener noreferrer"
        class="text-mauve underline">JMdict / EDRDG</a
      >
      ·
      <a
        href="https://www.edrdg.org/edrdg/licence.html"
        target="_blank"
        rel="noopener noreferrer"
        class="text-mauve underline">CC BY-SA 4.0</a
      >
    </p>
  {/if}
</section>

<style>
  ruby {
    ruby-position: over;
    ruby-align: center;
  }
  rt {
    font-size: 0.65em;
    line-height: 1;
    font-weight: normal;
  }
  rt span {
    display: block;
  }
  [data-lyric-meaning] {
    max-width: 9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9em;
    line-height: 1.2;
  }
</style>
