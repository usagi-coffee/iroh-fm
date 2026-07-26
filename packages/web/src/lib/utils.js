import { toHiragana, toKatakana } from "wanakana";

/** @type {WeakMap<object, { source: string, variants: string[] }>} */
const trackSearchMetadata = new WeakMap();

/** @param {import('@iroh-fm/client/types').TrackData} track */
function trackMetadataVariants(track) {
  const source = `${track.artist}\n${track.title}\n${track.album}`;
  const cached = trackSearchMetadata.get(track);
  if (cached?.source === source) return cached.variants;
  const metadata = source.toLocaleLowerCase();
  const variants = [
    ...new Set([
      metadata,
      toHiragana(metadata).toLocaleLowerCase(),
      toKatakana(metadata).toLocaleLowerCase(),
    ]),
  ];
  trackSearchMetadata.set(track, { source, variants });
  return variants;
}

/** @param {import('@iroh-fm/client/types').TrackData[]} tracks */
export function indexTracksForSearch(tracks) {
  for (const track of tracks) trackMetadataVariants(track);
}

/** @param {string[]} values */
export function cleanRelays(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * @template {import('@iroh-fm/client/types').TrackData} T
 * @param {T[]} list
 * @param {string} term
 * @returns {T[]}
 */
export function filterTracks(list, term) {
  const needle = term.trim().toLocaleLowerCase();
  const needles = [
    ...new Set([
      needle,
      toHiragana(needle).toLocaleLowerCase(),
      toKatakana(needle).toLocaleLowerCase(),
    ]),
  ];
  return list.filter((track) => {
    if (!needle) return true;
    return trackMetadataVariants(track).some((metadata) =>
      needles.some((candidate) => metadata.includes(candidate)),
    );
  });
}

/**
 * @param {import('@iroh-fm/client/types').TrackData} left
 * @param {import('@iroh-fm/client/types').TrackData} right
 */
export function trackSort(left, right) {
  return (
    left.album.localeCompare(right.album, undefined, { numeric: true }) ||
    (left.disc_number || 0) - (right.disc_number || 0) ||
    (left.track_number || 0) - (right.track_number || 0) ||
    left.artist.localeCompare(right.artist, undefined, { numeric: true }) ||
    left.title.localeCompare(right.title, undefined, { numeric: true })
  );
}

/**
 * @param {import('@iroh-fm/client/types').Album} left
 * @param {import('@iroh-fm/client/types').Album} right
 */
export function albumSort(left, right) {
  return (
    left.title.localeCompare(right.title, undefined, { numeric: true }) ||
    (left.album_artist || left.artist).localeCompare(
      right.album_artist || right.artist,
      undefined,
      { numeric: true },
    )
  );
}

/** @param {number | null | undefined} seconds */
export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

/** @param {number | null | undefined} bytes */
export function formatBytes(bytes) {
  const count = Number(bytes);
  if (!Number.isFinite(count) || count <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(count) / Math.log(1024)));
  const value = count / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * @param {unknown} error
 * @param {string} fallback
 */
export function friendlyError(error, fallback) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.replace(/^Error:\s*/i, "") || fallback;
}

/** @param {unknown} error */
export function isProtocolVersionMismatch(error) {
  const message = friendlyError(error, "");
  return /\bunknown variant\b[\s\S]*\bexpected\b/i.test(message);
}

/** @param {import('@iroh-fm/client/types').ConnectionInfo} info */
export function connectionAddressLabel(info) {
  if (!info.address) return "CONNECTING";
  if (info.path_type !== "relay") return info.path_type.toUpperCase();
  try {
    return new URL(info.address).host;
  } catch {
    return info.address;
  }
}
