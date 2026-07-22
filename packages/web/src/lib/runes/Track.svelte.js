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
  genres = $state.raw([]);
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
  /** @type {string | null} */
  suffix = $state(null);
  file_size = $state(0);
  modified_at = $state({ secs_since_epoch: 0, nanos_since_epoch: 0 });
  content_type = $state("");
  cached = $state(false);
  memoryCached = $state(false);
  downloading = $state(false);
  progress = $state(0);
  received = $state(0);
  total = $state(0);
  downloadGeneration = 0;

  /**
   * @param {import('@iroh-fm/client/types').TrackData} data
   * @param {boolean} [cached]
   */
  constructor(data, cached = false) {
    this.updateMetadata(data);
    this.setCached(cached);
  }

  /** @param {import('@iroh-fm/client/types').TrackData} data */
  updateMetadata(data) {
    this.id = data.id;
    this.title = data.title;
    this.artist = data.artist;
    this.album = data.album;
    this.album_artist = data.album_artist;
    this.track_number = data.track_number;
    this.disc_number = data.disc_number;
    this.duration_seconds = data.duration_seconds;
    this.bitrate = data.bitrate;
    this.sample_rate = data.sample_rate;
    this.channels = data.channels;
    this.codec = data.codec;
    if (
      this.genres.length !== data.genres.length ||
      this.genres.some((genre, index) => genre !== data.genres[index])
    )
      this.genres = data.genres;
    this.date = data.date;
    this.musicbrainz_track_id = data.musicbrainz_track_id;
    this.musicbrainz_recording_id = data.musicbrainz_recording_id;
    this.musicbrainz_album_id = data.musicbrainz_album_id;
    this.musicbrainz_release_group_id = data.musicbrainz_release_group_id;
    this.cover_art_id = data.cover_art_id;
    this.suffix = data.suffix;
    this.file_size = data.file_size;
    this.modified_at = data.modified_at;
    this.content_type = data.content_type;
  }

  startDownload() {
    const generation = ++this.downloadGeneration;
    this.received = 0;
    this.total = Number(this.file_size) || 0;
    this.progress = 0;
    this.downloading = true;
    return generation;
  }

  /**
   * @param {number} received
   * @param {number} total
   * @param {number} [generation]
   */
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

  /** @param {boolean} cached */
  setMemoryCached(cached) {
    if (this.memoryCached === cached && !(cached && this.downloading)) return;
    this.memoryCached = cached;
    if (cached && !this.cached) {
      this.downloadGeneration += 1;
      this.downloading = false;
      this.progress = 1;
      this.total = Number(this.file_size) || this.total;
      this.received = this.total;
    } else if (!cached && !this.cached && !this.downloading) {
      this.progress = 0;
      this.received = 0;
      this.total = Number(this.file_size) || 0;
    }
  }
}
