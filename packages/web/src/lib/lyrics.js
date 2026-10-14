/** @typedef {import('@iroh-fm/client/types').LyricReading} LyricReading */
/** @typedef {{ text: string, reading: string | null, dictionary?: import('@iroh-fm/client/types').LyricDictionary }} LyricPart */
/** @typedef {{ time: number, text: string, parts?: LyricPart[] }} LyricLine */
/** @typedef {LyricReading & { order: number }} IndexedReading */

/**
 * Validate once and index by the original UTF-16 source position.
 * @param {string} source
 * @param {LyricReading[]} readings
 * @returns {IndexedReading[]}
 */
function indexReadings(source, readings) {
  /** @type {IndexedReading[]} */
  const index = [];
  for (const [order, span] of readings.entries()) {
    const { start, end, reading, dictionary } = span;
    if (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end <= source.length &&
      start < end &&
      reading
    )
      index.push({ start, end, reading, ...(dictionary ? { dictionary } : {}), order });
  }
  return index.sort((a, b) => a.start - b.start || a.order - b.order);
}

/**
 * Only visit spans beginning inside this retained range. Each source position
 * belongs to at most one range, so candidates are never scanned for other rows.
 * @param {IndexedReading[]} index
 * @param {number} start
 * @param {number} end
 */
function rangeReadings(index, start, end) {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index[middle].start < start) low = middle + 1;
    else high = middle;
  }
  const spans = [];
  for (; low < index.length && index[low].start < end; low++) {
    if (index[low].end <= end) spans.push(index[low]);
  }
  // Preserve input-order precedence for unsorted or overlapping annotations.
  return spans.sort((a, b) => a.order - b.order);
}

/**
 * Keep source indices while removing LRC tags. Spans are UTF-16 offsets, not
 * byte offsets or offsets into the stripped display text. Only complete words
 * inside a retained range can be ruby, never guesses for split words.
 * @param {string} row
 * @param {number} offset
 * @param {IndexedReading[]} readings
 * @param {boolean} synced
 * @returns {LyricPart[]}
 */
function rowParts(row, offset, readings, synced) {
  const tags = synced
    ? [...row.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]|<\d+:[0-5]?\d(?:[.:]\d+)?>/g)]
    : [];
  const ranges = [];
  let cursor = 0;
  for (const tag of tags) {
    ranges.push([cursor, tag.index]);
    cursor = tag.index + tag[0].length;
  }
  ranges.push([cursor, row.length]);
  /** @type {LyricPart[]} */
  const parts = [];
  for (const [start, end] of ranges) {
    let position = start;
    for (const span of rangeReadings(readings, offset + start, offset + end)) {
      if (span.start < offset + position) continue;
      const left = span.start - offset;
      const right = span.end - offset;
      if (left > position) parts.push({ text: row.slice(position, left), reading: null });
      parts.push({
        text: row.slice(left, right),
        reading: span.reading,
        ...(span.dictionary ? { dictionary: span.dictionary } : {}),
      });
      position = right;
    }
    if (position < end) parts.push({ text: row.slice(position, end), reading: null });
  }
  // Preserve the existing parser's display trimming without shifting spans.
  while (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    if (parts[0].text) break;
    parts.shift();
  }
  while (parts.length) {
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
    if (parts[parts.length - 1].text) break;
    parts.pop();
  }
  return parts;
}

/** @param {string} text */
function sourceRows(text) {
  let offset = text.startsWith("\uFEFF") ? 1 : 0;
  return text
    .slice(offset)
    .split(/\r?\n/)
    .map((row) => {
      const result = { row, offset };
      offset += row.length + (text[offset + row.length] === "\r" ? 2 : 1);
      return result;
    });
}

/**
 * LRC timestamps are minutes:seconds, with decimal (or colon) fractions.
 * Repeated timestamps create repeated lines. The last offset tag applies globally.
 * Positive LRC offsets advance lyrics; negative offsets delay them.
 * @param {string | null | undefined} text
 * @param {LyricReading[] | undefined} readings
 * @returns {LyricLine[]}
 */
export function parseLrc(text, readings = undefined) {
  if (!text) return [];
  const rows = sourceRows(text);
  const readingIndex = readings ? indexReadings(text, readings) : undefined;
  let offset = 0;
  for (const { row } of rows) {
    const match = row.match(/^\s*\[offset:\s*([+-]?\d+)\]\s*$/i);
    if (match) offset = Number(match[1]) / 1000;
  }
  const lines = [];
  for (const { row, offset: sourceOffset } of rows) {
    const timestamps = [...row.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]/g)];
    if (!timestamps.length) continue;
    const content = row
      .replace(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]/g, "")
      .replace(/<\d+:[0-5]?\d(?:[.:]\d+)?>/g, "")
      .trim();
    const parts = readingIndex ? rowParts(row, sourceOffset, readingIndex, true) : undefined;
    for (const match of timestamps) {
      const time =
        Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? "0"}`) - offset;
      if (Number.isFinite(time))
        lines.push({
          time: Math.max(0, time),
          text: content,
          ...(parts ? { parts } : {}),
        });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Plain text has no timing information. Uniform duration-based positions are
 * deliberately only an approximation, not inferred or authoritative timings.
 * @param {string | null | undefined} text
 * @param {number} duration
 * @param {LyricReading[] | undefined} readings
 * @returns {LyricLine[]}
 */
export function estimateLyrics(text, duration, readings = undefined) {
  const rows = sourceRows(text ?? "").filter(({ row }) => row.trim());
  const readingIndex = readings ? indexReadings(text ?? "", readings) : undefined;
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return rows.map(({ row, offset }, index) => ({
    text: row.trim(),
    time: seconds ? (index * seconds) / rows.length : Infinity,
    ...(readingIndex ? { parts: rowParts(row, offset, readingIndex, false) } : {}),
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

/**
 * A short dictionary gloss, never a claimed contextual translation. Full
 * bounded senses remain available in the title/accessibility description.
 * @param {LyricPart} part
 */
export function lyricGloss(part) {
  const dictionary = part.dictionary;
  if (!dictionary) return null;
  const first = dictionary.meanings[0]?.senses[0]?.glosses[0];
  if (!first) return null;
  const more =
    dictionary.truncated ||
    dictionary.meanings.length > 1 ||
    dictionary.meanings[0].senses.length > 1 ||
    dictionary.meanings[0].senses[0].glosses.length > 1;
  return `${first}${more ? " / …" : ""}`;
}

/** @param {LyricPart} part */
export function lyricDictionaryDescription(part) {
  const dictionary = part.dictionary;
  if (!dictionary) return "Dictionary meanings unavailable for this word.";
  if (!dictionary.meanings.length) return `No JMdict match for ${dictionary.lemma}.`;
  const senses = dictionary.meanings
    .map(
      (meaning) =>
        `${meaning.reading}: ${meaning.senses
          .map(
            (sense, index) =>
              `${index + 1}. ${sense.glosses.join("; ")}${sense.labels.length ? ` (${sense.labels.join(", ")})` : ""}`,
          )
          .join(" · ")}`,
    )
    .join(" | ");
  return `Dictionary meanings for ${dictionary.lemma}, not a lyric translation. ${senses}${dictionary.truncated ? " · More senses omitted." : ""}`;
}
