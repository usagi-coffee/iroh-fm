/** @typedef {{ time: number, text: string }} LyricLine */
/**
 * LRC timestamps are minutes:seconds, with decimal (or colon) fractions.
 * Repeated timestamps create repeated lines. The last offset tag applies globally.
 * Positive LRC offsets advance lyrics; negative offsets delay them.
 * @param {string | null | undefined} text
 * @returns {LyricLine[]}
 */
export function parseLrc(text) {
  if (!text) return [];
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let offset = 0;
  for (const row of rows) {
    const match = row.match(/^\s*\[offset:\s*([+-]?\d+)\]\s*$/i);
    if (match) offset = Number(match[1]) / 1000;
  }
  const lines = [];
  for (const row of rows) {
    const timestamps = [...row.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]/g)];
    if (!timestamps.length) continue;
    const content = row
      .replace(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]/g, "")
      .replace(/<\d+:[0-5]?\d(?:[.:]\d+)?>/g, "")
      .trim();
    for (const match of timestamps) {
      const time =
        Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? "0"}`) - offset;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Plain text has no timing information. Uniform duration-based positions are
 * deliberately only an approximation, not inferred or authoritative timings.
 * @param {string | null | undefined} text
 * @param {number} duration
 * @returns {LyricLine[]}
 */
export function estimateLyrics(text, duration) {
  const rows = (text ?? "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return rows.map((text, index) => ({
    text,
    time: seconds ? (index * seconds) / rows.length : Infinity,
  }));
}

/** @param {LyricLine[]} lines @param {number} position */
export function activeLyricIndex(lines, position) {
  if (!Number.isFinite(position)) return -1;
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** @param {string | null | undefined} value */
export function lyricsSourceUrl(value) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
