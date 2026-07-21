export class Track {
  id = $state("");
  title = $state("");
  artist = $state("");
  album = $state("");
  /** @type {string | null} */
  album_artist = $state(null);
  /** @type {number | null} */
  track_number = $state(null);
  /** @type {number | null} */
  disc_number = $state(null);
  /** @type {number | null} */
  duration_seconds = $state(null);
  /** @type {number | null} */
  bitrate = $state(null);
  /** @type {number | null} */
  sample_rate = $state(null);
  /** @type {number | null} */
  channels = $state(null);
  /** @type {string | null} */
  codec = $state(null);
  /** @type {string[]} */
  genres = $state([]);
  /** @type {string | null} */
  date = $state(null);
  /** @type {string | null} */
  musicbrainz_track_id = $state(null);
  /** @type {string | null} */
  musicbrainz_recording_id = $state(null);
  /** @type {string | null} */
  musicbrainz_album_id = $state(null);
  /** @type {string | null} */
  musicbrainz_release_group_id = $state(null);
  /** @type {string | null} */
  cover_art_id = $state(null);
  has_embedded_cover = $state(false);
  /** @type {string | null} */
  suffix = $state(null);
  relative_path = $state("");
  file_size = $state(0);
  /** @type {unknown} */
  modified_at = $state(null);
  content_type = $state("");
  cached = $state(false);
  downloading = $state(false);
  progress = $state(0);
  received = $state(0);
  total = $state(0);
  downloadGeneration = 0;

  /** @param {import('../types').TrackData} data @param {boolean} [cached] */
  constructor(data, cached = false) {
    this.updateMetadata(data);
    this.setCached(cached);
  }

  /** @param {import('../types').TrackData} data */
  updateMetadata(data) {
    // Library refreshes can return the same metadata repeatedly. Avoid touching
    // rune state for unchanged values: a large refresh otherwise invalidates
    // every visible row, cover, and player consumer.
    const next = {
      id: data.id,
      title: data.title,
      artist: data.artist,
      album: data.album,
      album_artist: data.album_artist,
      track_number: data.track_number,
      disc_number: data.disc_number,
      duration_seconds: data.duration_seconds,
      bitrate: data.bitrate,
      sample_rate: data.sample_rate,
      channels: data.channels,
      codec: data.codec,
      genres: data.genres,
      date: data.date,
      musicbrainz_track_id: data.musicbrainz_track_id,
      musicbrainz_recording_id: data.musicbrainz_recording_id,
      musicbrainz_album_id: data.musicbrainz_album_id,
      musicbrainz_release_group_id: data.musicbrainz_release_group_id,
      cover_art_id: data.cover_art_id,
      has_embedded_cover: data.has_embedded_cover ?? false,
      suffix: data.suffix,
      relative_path: data.relative_path ?? "",
      file_size: data.file_size,
      modified_at: data.modified_at,
      content_type: data.content_type,
    };
    const state = /** @type {Record<string, unknown>} */ (this);
    for (const [key, value] of Object.entries(next)) {
      if (!Object.is(state[key], value)) state[key] = value;
    }
  }

  startDownload() {
    const generation = ++this.downloadGeneration;
    this.received = 0;
    this.total = Number(this.file_size) || 0;
    this.progress = 0;
    this.downloading = true;
    return generation;
  }

  /** @param {number} received @param {number} total @param {number} [generation] */
  updateProgress(received, total, generation = this.downloadGeneration) {
    if (generation !== this.downloadGeneration) return;
    const knownTotal = Number(total) > 0 ? Number(total) : Number(this.file_size) || 0;
    // Native state polls can finish out of order. A transfer's byte count is
    // monotonic within one download generation, so never let a stale snapshot
    // move its UI backward.
    this.received = Math.max(this.received, Number(received) || 0);
    this.total = Math.max(this.total, knownTotal);
    this.progress = this.total > 0 ? Math.min(1, this.received / this.total) : 0;
    this.downloading = this.total <= 0 || this.received < this.total;
  }

  /** @param {number} [generation] */
  stopDownload(generation = this.downloadGeneration) {
    if (generation !== this.downloadGeneration) return;
    this.downloadGeneration += 1;
    this.downloading = false;
  }

  /** @param {boolean} cached */
  setCached(cached) {
    // Repeated cache scans are common while the app is connected. Preserve
    // progress and avoid invalidating the track when there is no state change.
    if (this.cached === cached && !(cached && this.downloading)) return;
    this.downloadGeneration += 1;
    this.cached = cached;
    if (!cached) {
      if (!this.downloading) {
        this.progress = 0;
        this.received = 0;
        this.total = Number(this.file_size) || 0;
      }
      return;
    }
    this.downloading = false;
    this.progress = 1;
    this.total = Number(this.file_size) || this.total;
    this.received = this.total;
  }
}
