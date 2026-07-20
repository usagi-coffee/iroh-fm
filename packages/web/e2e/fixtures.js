export const TRACK_BYTES = 320_044;
export const TRACK_SECONDS = 20;

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
  cover_art_id: null,
};

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
  receivedBytes = 0;

  bootstrap() {
    return Promise.resolve({
      summary: {
        LibrarySummary: { artist_count: 2, album_count: 1, track_count: tracks.length },
      },
      albums: { Albums: [album] },
      artists: {
        Artists: [
          { id: "artist-1", name: "Aurora Unit", album_ids: [album.id] },
          { id: "artist-2", name: "Coastal Signal", album_ids: [album.id] },
        ],
      },
      tracks: { Tracks: tracks },
      starred: { Starred: { artists: [], albums: [], tracks: [] } },
    });
  }

  cachedTrackIds() {
    return Promise.resolve(new Set(this.cached));
  }

  setOfflineOnly() {}

  connectionInfo() {
    return { path_type: "direct", address: "e2e", received_bytes: this.receivedBytes };
  }

  async prefetchTrack(id, onProgress = () => {}) {
    onProgress(0, TRACK_BYTES);
    await delay(40);
    onProgress(TRACK_BYTES / 2, TRACK_BYTES);
    await delay(40);
    this.cached.add(id);
    onProgress(TRACK_BYTES, TRACK_BYTES);
    await delay(80);
    return true;
  }

  request() {
    return Promise.resolve({});
  }

  coverUrl() {
    return Promise.resolve("");
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
    this.cached.add(track.id);
    onProgress(TRACK_BYTES, TRACK_BYTES);
    this.transfers[track.id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: true,
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
