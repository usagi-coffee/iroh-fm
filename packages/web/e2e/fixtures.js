export const TRACK_BYTES = 320_044;
export const TRACK_SECONDS = 20;
const COVER_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%23cba6f7'/%3E%3C/svg%3E";
const COVER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='#cba6f7'/></svg>";

export const tracks = [
  track("track-1", "First Light", "Aurora Unit", 1),
  track("track-2", "Nebula Drift", "Aurora Unit", 2),
  track("track-3", "Quiet Harbor", "Coastal Signal", 3),
];

export const album = {
  id: "album-1",
  title: "Test Signals",
  artist: "Aurora Unit",
  album_artist: "Aurora Unit",
  track_ids: tracks.map(({ id }) => id),
  date: "2026",
  original_date: null,
  year: 2026,
  genres: ["Electronic"],
  labels: [],
  catalog_number: null,
  comment: null,
  musicbrainz_album_id: null,
  musicbrainz_release_group_id: null,
  disc_count: 1,
  duration_seconds: TRACK_SECONDS * tracks.length,
  size_bytes: TRACK_BYTES * tracks.length,
  cover_art_id: "cover-1",
};

function fixtureLibrary() {
  const requestedAlbums = Number.parseInt(
    localStorage.getItem("iroh-fm-e2e-album-count") ?? "",
    10,
  );
  if (!Number.isFinite(requestedAlbums) || requestedAlbums <= 1) return { albums: [album], tracks };

  const albumCount = Math.min(500, requestedAlbums);
  const generatedAlbums = [];
  const generatedTracks = [];
  for (let index = 1; index <= albumCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const albumId = `album-${index}`;
    const trackId = `track-${index}`;
    const albumTitle = `Test Album ${suffix}`;
    const generatedTrack = track(trackId, `Track ${suffix}`, "Fixture Artist", 1);
    generatedTrack.album = albumTitle;
    generatedTrack.album_artist = "Fixture Artist";
    generatedTrack.cover_art_id = `cover-${index}`;
    generatedTracks.push(generatedTrack);
    generatedAlbums.push({
      ...album,
      id: albumId,
      title: albumTitle,
      artist: "Fixture Artist",
      album_artist: "Fixture Artist",
      track_ids: [trackId],
      duration_seconds: TRACK_SECONDS,
      size_bytes: TRACK_BYTES,
      cover_art_id: `cover-${index}`,
    });
  }
  return { albums: generatedAlbums, tracks: generatedTracks };
}

function track(id, title, artist, trackNumber) {
  return {
    id,
    title,
    artist,
    album: "Test Signals",
    album_artist: "Aurora Unit",
    track_number: trackNumber,
    disc_number: 1,
    duration_seconds: TRACK_SECONDS,
    bitrate: 128_000,
    sample_rate: 8_000,
    channels: 1,
    codec: "pcm_s16le",
    genres: ["Electronic"],
    date: "2026",
    musicbrainz_track_id: null,
    musicbrainz_recording_id: null,
    musicbrainz_album_id: null,
    musicbrainz_release_group_id: null,
    cover_art_id: null,
    suffix: "wav",
    relative_path: `${title}.wav`,
    file_size: TRACK_BYTES,
    modified_at: null,
    content_type: "audio/wav",
  };
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function coverMedia() {
  return {
    contentType: "image/svg+xml",
    bytes: new TextEncoder().encode(COVER_SVG),
    free() {},
  };
}

export function silentWav() {
  const sampleRate = 8_000;
  const dataLength = sampleRate * TRACK_SECONDS * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataLength, true);
  return new Blob([bytes], { type: "audio/wav" });
}

export class FixtureClient {
  endpointId = "e2e-client";
  remoteId = "e2e-server";
  cached = new Set();
  memoryCached = new Set();
  receivedBytes = 0;
  playlists = [];

  bootstrap() {
    const bootstrapError = localStorage.getItem("iroh-fm-e2e-bootstrap-error");
    if (bootstrapError) throw new Error(bootstrapError);
    const library = fixtureLibrary();
    return Promise.resolve({
      summary: {
        artist_count: 1,
        album_count: library.albums.length,
        track_count: library.tracks.length,
      },
      albums: library.albums,
      artists: [
        {
          id: "artist-1",
          name: "Fixture Artist",
          album_ids: library.albums.map(({ id }) => id),
        },
      ],
      tracks: library.tracks,
      starred: { artists: [], albums: [], tracks: [] },
      playlists: this.playlists.map((playlist) => ({ ...playlist, track_ids: [...playlist.track_ids] })),
    });
  }

  cachedTrackIds() {
    return Promise.resolve(new Set(this.cached));
  }

  setOfflineOnly() {}

  setMemoryCacheSize() {
    return Promise.resolve();
  }

  connectionInfo() {
    return { path_type: "direct", address: "e2e", received_bytes: this.receivedBytes };
  }

  async prefetchTrack(id, onProgress = () => {}) {
    onProgress(0, TRACK_BYTES);
    await delay(40);
    onProgress(TRACK_BYTES / 2, TRACK_BYTES);
    await delay(40);
    this.memoryCached.add(id);
    onProgress(TRACK_BYTES, TRACK_BYTES);
    await delay(80);
    return { cached: true, persistent: false };
  }

  async cacheTrack(id, onProgress = () => {}) {
    const result = await this.prefetchTrack(id, onProgress);
    this.cached.add(id);
    return Boolean(result.cached);
  }

  cacheStats() {
    const configuredTrackCount = localStorage.getItem("iroh-fm-e2e-track-cache-count");
    const trackCount =
      configuredTrackCount === null ? this.cached.size : Number(configuredTrackCount) || 0;
    const coverCount = Number(localStorage.getItem("iroh-fm-e2e-cover-cache-count")) || 0;
    return Promise.resolve({
      tracks: { count: trackCount, size: trackCount * TRACK_BYTES },
      covers: { count: coverCount, size: coverCount * 1_024 },
    });
  }

  /** @param {'tracks' | 'covers'} kind */
  clearCache(kind) {
    localStorage.setItem(`iroh-fm-e2e-${kind === "tracks" ? "track" : "cover"}-cache-count`, "0");
    if (kind === "tracks") this.cached.clear();
    return Promise.resolve();
  }

  request() {
    return Promise.resolve({});
  }

  setStarred() {
    return Promise.resolve();
  }

  getPlaylist(id) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) return Promise.reject(new Error("playlist not found"));
    return Promise.resolve({ ...playlist, track_ids: [...playlist.track_ids] });
  }

  createPlaylist(name, trackIds = []) {
    const now = Math.floor(Date.now() / 1000);
    const playlist = {
      id: `playlist-${this.playlists.length + 1}`,
      name: name.trim(),
      comment: null,
      track_ids: [...new Set(trackIds)],
      created_unix: now,
      changed_unix: now,
    };
    this.playlists.push(playlist);
    return Promise.resolve({ ...playlist, track_ids: [...playlist.track_ids] });
  }

  updatePlaylist(id, fields) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) return Promise.reject(new Error("playlist not found"));
    if (fields.name !== undefined) playlist.name = fields.name.trim();
    if (fields.comment !== undefined) playlist.comment = fields.comment || null;
    if (fields.trackIds !== undefined) playlist.track_ids = [...new Set(fields.trackIds)];
    playlist.changed_unix = Math.floor(Date.now() / 1000);
    return Promise.resolve({ ...playlist, track_ids: [...playlist.track_ids] });
  }

  deletePlaylist(id) {
    this.playlists = this.playlists.filter((item) => item.id !== id);
    return Promise.resolve();
  }

  reorderPlaylists(ids) {
    const byId = new Map(this.playlists.map((playlist) => [playlist.id, playlist]));
    this.playlists = ids.map((id) => byId.get(id)).filter(Boolean);
    return Promise.resolve();
  }

  async coverUrl() {
    await delay(40);
    return COVER_URL;
  }

  close() {
    return Promise.resolve();
  }
}

export function fixtureCore(Client) {
  return class {
    static prepare() {}
    static prepareCaches() {}
    static buildInfo() {
      return Promise.resolve(null);
    }
    static parseTicket() {
      return Promise.resolve({ endpointId: "e2e-server", relays: [] });
    }
    static generateIdentity() {
      return Promise.resolve({ secret: "e2e-secret", endpointId: "e2e-client" });
    }
    static endpointIdForSecret() {
      return Promise.resolve("e2e-client");
    }
    static connect() {
      return Promise.resolve(new Client());
    }
    static cacheStats() {
      return Promise.resolve({ tracks: { count: 0, size: 0 }, covers: { count: 0, size: 0 } });
    }
    static memoryCacheSize() {
      return 256 * 1024 * 1024;
    }
    static memoryCacheMaxSize() {
      return 5 * 1024 * 1024 * 1024;
    }
    static setMemoryCacheSize(megabytes) {
      return Number(megabytes) * 1024 * 1024;
    }
  };
}

export class NativeFixtureClient extends FixtureClient {
  nativePlayback = true;
  queue = [];
  currentIndex = 0;
  trackId = null;
  playing = false;
  loading = false;
  position = 0;
  repeat = false;
  shuffle = false;
  volume = 0.5;
  transfers = {};

  snapshot({ includeQueue = true } = {}) {
    const state = {
      timestamp: Date.now(),
      trackId: this.trackId,
      playing: this.playing,
      loading: this.loading,
      position: this.position,
      duration: this.trackId ? TRACK_SECONDS : 0,
      repeat: this.repeat,
      shuffle: this.shuffle,
      volume: this.volume,
      transfers: { ...this.transfers },
    };
    if (includeQueue) {
      state.queue = [...this.queue];
      state.currentIndex = this.currentIndex;
    }
    return state;
  }

  async playNative(track, queue, onProgress = () => {}) {
    this.queue = queue.map(({ id }) => id);
    this.currentIndex = this.queue.indexOf(track.id);
    this.trackId = track.id;
    this.position = 0;
    this.playing = true;
    onProgress(0, TRACK_BYTES);
    await delay(30);
    this.memoryCached.add(track.id);
    onProgress(TRACK_BYTES, TRACK_BYTES);
    this.transfers[track.id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: false,
      memoryCached: true,
    };
    return this.snapshot();
  }

  playerState(options) {
    return Promise.resolve(this.snapshot(options));
  }

  playerCommand(command, payload = {}) {
    if (command === "toggle") this.playing = !this.playing;
    else if (command === "next" || command === "previous") {
      const direction = command === "next" ? 1 : -1;
      this.currentIndex = (this.currentIndex + direction + this.queue.length) % this.queue.length;
      this.trackId = this.queue[this.currentIndex] ?? null;
      this.position = 0;
      this.playing = Boolean(this.trackId);
    } else if (command === "seek") this.position = Number(payload.seconds) || 0;
    else if (command === "repeat") this.repeat = Boolean(payload.enabled);
    else if (command === "shuffle") this.shuffle = Boolean(payload.enabled);
    else if (command === "volume") this.volume = Number(payload.value) || 0;
    else if (command === "stop") {
      this.trackId = null;
      this.queue = [];
      this.currentIndex = 0;
      this.position = 0;
      this.playing = false;
    }
    return Promise.resolve(this.snapshot());
  }
}
