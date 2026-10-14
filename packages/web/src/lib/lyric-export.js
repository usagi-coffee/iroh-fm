import { lyricAttribution } from "./lyric-export-attribution.js";
import { estimateLyrics, lyricsSourceUrl, parseLrc } from "./lyrics.js";

import { Zip, ZipPassThrough } from "fflate";

/** @typedef {import('./lyrics-request.js').TrackLyrics} TrackLyrics */
/** @typedef {import('@iroh-fm/client/types').LyricReading} LyricReading */
/** @typedef {{id: string, title: string, artist: string, album: string,
 * duration_seconds: number | null, suffix: string | null, content_type: string, file_size?: number}} LyricExportTrack */

// The final archive and the source audio coexist in memory. Avoid unbounded
// allocations on mobile, and stay well below the non-ZIP64 archive limit.
export const MAX_LYRIC_AUDIO_BYTES = 512 * 1024 * 1024;

/** Preserve Unicode, but remove path separators, control and bidi characters. @param {string} value */
export function lyricFilename(value) {
  let stem = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const char of value.normalize("NFC").replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_")) {
    bytes += encoder.encode(char).length;
    if (bytes > 200) break;
    stem += char;
  }
  stem = stem.replace(/^[. ]+|[. ]+$/g, "");
  const safe = stem || "song";
  return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? "_" : ""}${safe}-lyrics.zip`;
}

/** @param {TrackLyrics | null} lyrics */
export function canExportLyrics(lyrics) {
  return (
    lyrics?.status === "Available" &&
    Boolean(lyrics.plain_lyrics?.trim() || parseLrc(lyrics.synced_lyrics).some((line) => line.text))
  );
}

/**
 * Source offsets always refer to raw UTF-16 strings, never rendered text.
 * Original annotations are retained separately, including fields introduced
 * by newer servers. Invalid spans cannot become exported words.
 * @param {string} source
 * @param {LyricReading[]} readings
 * @param {'plain' | 'synced'} kind
 * @param {number} duration
 */
function exportLines(source, readings, kind, duration) {
  const validReadings = readings
    .filter(
      (span) =>
        Number.isInteger(span.start) &&
        Number.isInteger(span.end) &&
        span.start >= 0 &&
        span.end <= source.length &&
        span.start < span.end &&
        Boolean(span.reading),
    )
    .sort((a, b) => a.start - b.start);
  let readingCursor = 0;
  const rows = [];
  let start = source.startsWith("\uFEFF") ? 1 : 0;
  for (const row of source.slice(start).split(/\r?\n/)) {
    rows.push({ row, start, end: start + row.length });
    start += row.length + (source[start + row.length] === "\r" ? 2 : 1);
  }
  const offsets = [...source.matchAll(/^\s*\[offset:\s*([+-]?\d+)\]\s*$/gim)];
  const offset = offsets.at(-1)?.[1] ?? "0";
  const nonempty = rows.filter(({ row }) => row.trim());
  const estimated = kind === "plain" ? estimateLyrics(source, duration) : [];
  return (kind === "plain" ? nonempty : rows)
    .flatMap(({ row, start, end }, index) => {
      const tags =
        kind === "synced"
          ? [...row.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]|<\d+:[0-5]?\d(?:[.:]\d+)?>/g)]
          : [];
      while (readingCursor < validReadings.length && validReadings[readingCursor].start < start)
        readingCursor++;
      const rowReadings = [];
      while (readingCursor < validReadings.length && validReadings[readingCursor].start < end)
        rowReadings.push(validReadings[readingCursor++]);
      const words = rowReadings
        .filter(
          (span) =>
            span.end <= end &&
            !tags.some(
              (tag) =>
                span.start < start + tag.index + tag[0].length && span.end > start + tag.index,
            ),
        )
        .map((span) => ({
          ...span,
          surface: source.slice(span.start, span.end),
        }));
      const display =
        kind === "synced" ? parseLrc(`${row}\n[offset:${offset}]`) : [estimated[index]];
      return display.map((line) => ({
        source: kind,
        source_start: start,
        source_end: end,
        text: line.text,
        time_seconds: Number.isFinite(line.time) ? line.time : null,
        timing: kind === "synced" ? "synced" : "duration_estimate",
        words,
      }));
    })
    .sort((a, b) => (a.time_seconds ?? Infinity) - (b.time_seconds ?? Infinity));
}

/**
 * Snapshot immediately, before retrieving audio or creating an archive.
 * @param {LyricExportTrack} track
 * @param {TrackLyrics} lyrics
 * @param {number} duration
 */
export function createLyricSnapshot(track, lyrics, duration) {
  if (!canExportLyrics(lyrics)) throw new Error("No lyrics are available to export.");
  if (lyrics.track_id !== track.id) throw new Error("Lyrics do not belong to the current track.");
  if (track.file_size && track.file_size > MAX_LYRIC_AUDIO_BYTES)
    throw new Error("Lyric export supports audio up to 512 MiB.");
  const original = JSON.parse(JSON.stringify(lyrics));
  const metadata = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration_seconds: duration > 0 && Number.isFinite(duration) ? duration : null,
    suffix: track.suffix,
    content_type: track.content_type,
    file_size:
      typeof track.file_size === "number" && Number.isFinite(track.file_size) && track.file_size > 0
        ? track.file_size
        : null,
  };
  const plain = exportLines(
    original.plain_lyrics ?? "",
    original.annotated_lyrics?.plain ?? [],
    "plain",
    duration,
  );
  const synced = exportLines(
    original.synced_lyrics ?? "",
    original.annotated_lyrics?.synced ?? [],
    "synced",
    duration,
  );
  return {
    schema: "iroh-fm.lyric-export",
    version: 1,
    track: metadata,
    lyrics: {
      provider: "LRCLIB",
      source_url: lyricsSourceUrl(original.source_url) ?? "https://lrclib.net/",
      sources: {
        plain: {
          text: original.plain_lyrics ?? null,
          annotations: original.annotated_lyrics?.plain ?? [],
        },
        synced: {
          text: original.synced_lyrics ?? null,
          annotations: original.annotated_lyrics?.synced ?? [],
        },
      },
      annotation_version: original.annotated_lyrics?.version ?? null,
      annotation_status: original.retry_after_seconds
        ? "incomplete"
        : original.annotated_lyrics
          ? "available"
          : "unavailable",
      annotation_note:
        "Automatic dictionary readings and senses, not a lyric translation. Missing meanings are unknown, not empty translations. Coverage and sung pronunciation may differ.",
      offset_unit: "UTF-16 code units; end exclusive, relative to the corresponding raw source",
      timing_unit: "seconds from original audio start; LRC offsets applied, no UI advance applied",
      display_source: synced.length ? "synced" : "plain",
      lines: synced.length ? synced : plain,
    },
  };
}

const guide = `LYRIC EXPORT (schema version 1)

audio.* is the complete original audio, unchanged. No clips are generated.
lyrics.txt and lyrics.lrc, when present, are the exact received strings encoded
as UTF-8 (including BOM, whitespace and original line endings).
lyrics.json contains track metadata, raw sources, annotations and display lines.
Word start/end and line source_start/source_end are UTF-16 offsets into the
matching raw source. End offsets are exclusive, not UTF-8 byte offsets.
All times are seconds from audio start, with LRC offsets applied. Repeated LRC
timestamps produce repeated lines. Plain-text timings are uniform duration
estimates, NOT suitable as precise cut boundaries. Null times are unknown.
The manual UI Offset adjustment is not applied.

Use the JSON in your own study/Anki or audio-cutting workflow. This is not an
Anki deck. Verify dictionary senses, sung readings and clip boundaries yourself.
Automatic senses are possible word meanings, not lyric translations.
The annotation_status can be incomplete or unavailable; empty word lists and
missing meanings mean no annotation was available at export time. The archive
is a click-time snapshot and does not update when later annotations arrive.

Export is local, with no third-party service requests. Uncached audio requires
the existing authorized server connection. The archive uses ZIP STORE to avoid
recompressing audio. Audio and the resulting Blob coexist in memory; audio over
512 MiB is rejected and smaller exports can still exceed a device's memory.
See ATTRIBUTION.txt. Song lyrics and audio can be copyrighted independently;
dictionary licenses do not grant permission to redistribute the song.
`;

/** @param {string | null} suffix */
function audioExtension(suffix) {
  const value = suffix?.replace(/^\./, "") ?? "";
  return /^[a-z0-9]{1,12}$/i.test(value) ? value.toLowerCase() : "bin";
}

/**
 * Stream STORE entries into Blob parts rather than concatenate full byte arrays.
 * Yield between chunks so local archive creation does not freeze the UI.
 * @param {ReturnType<typeof createLyricSnapshot>} snapshot
 * @param {Blob} audio
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function createLyricArchive(snapshot, audio, onProgress = () => {}) {
  if (!audio.size) throw new Error("The original audio is empty.");
  if (audio.size > MAX_LYRIC_AUDIO_BYTES)
    throw new Error("Lyric export supports audio up to 512 MiB.");
  if (snapshot.track.file_size && audio.size !== snapshot.track.file_size)
    throw new Error(
      "Original audio size does not match the track. Refresh the library or download the complete track again.",
    );
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const chunks = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(/** @type {Uint8Array<ArrayBuffer>} */ (chunk));
  });
  const audioName = `audio.${audioExtension(snapshot.track.suffix)}`;
  const manifest = {
    ...snapshot,
    audio: {
      filename: audioName,
      content_type: audio.type || snapshot.track.content_type,
      size_bytes: audio.size,
      original: true,
    },
  };
  const files = [
    [audioName, audio],
    ["lyrics.json", new Blob([JSON.stringify(manifest, null, 2) + "\n"])],
    ["GUIDE.txt", new Blob([guide])],
    ["ATTRIBUTION.txt", new Blob([lyricAttribution(snapshot.lyrics.source_url)])],
  ];
  if (snapshot.lyrics.sources.plain.text != null)
    files.push(["lyrics.txt", new Blob([snapshot.lyrics.sources.plain.text])]);
  if (snapshot.lyrics.sources.synced.text != null)
    files.push(["lyrics.lrc", new Blob([snapshot.lyrics.sources.synced.text])]);
  try {
    for (const [name, data] of /** @type {[string, Blob][]} */ (files)) {
      onProgress(`Preparing ${name}…`);
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      const reader = data.stream().getReader();
      try {
        let count = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          entry.push(value, false);
          if (++count % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        entry.push(new Uint8Array(), true);
      } finally {
        reader.releaseLock();
      }
    }
    zip.end();
    return {
      blob: new Blob(chunks, { type: "application/zip" }),
      filename: lyricFilename(`${snapshot.track.artist} - ${snapshot.track.title}`),
    };
  } finally {
    zip.terminate();
  }
}

/** @param {Blob} blob @param {string} filename */
export function downloadLyricArchive(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to start consuming the download before cleanup.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
