import { album, coverMedia, delay, NativeFixtureClient, TRACK_BYTES, tracks } from "../fixtures.js";

import { MusicClient } from "@iroh-fm/client";

class DesktopInner extends NativeFixtureClient {
  native = true;
  nativeCache = new Map();
  metrics = { downloads: {} };

  constructor() {
    super();
    globalThis.__IROH_FM_E2E_METRICS__ = this.metrics;
    globalThis.__IROH_FM_E2E_DESKTOP__ = this;
  }

  request(raw) {
    const request = JSON.parse(raw);
    let response;
    if (request === "GetLibrarySummary")
      response = {
        LibrarySummary: { artist_count: 2, album_count: 1, track_count: tracks.length },
      };
    else if (request === "ListAlbums") response = { Albums: [album] };
    else if (request === "ListArtists")
      response = {
        Artists: [
          { id: "artist-1", name: "Aurora Unit", album_ids: [album.id] },
          { id: "artist-2", name: "Coastal Signal", album_ids: [album.id] },
        ],
      };
    else if (request === "ListTracks") response = { Tracks: tracks };
    else response = { Starred: { artists: [], albums: [], tracks: [] } };
    return Promise.resolve(JSON.stringify(response));
  }

  connectionInfo() {
    return JSON.stringify(super.connectionInfo());
  }

  fetchCover() {
    return Promise.resolve(coverMedia());
  }

  cachedTrackIds() {
    return Promise.resolve(new Set(this.nativeCache.keys()));
  }

  async prefetchTrack(id, onProgress = () => {}) {
    if (this.nativeCache.has(id)) {
      onProgress(TRACK_BYTES, TRACK_BYTES);
      return true;
    }
    this.metrics.downloads[id] = (this.metrics.downloads[id] ?? 0) + 1;
    this.transfers[id] = { received: 0, total: TRACK_BYTES, active: true, cached: false };
    onProgress(0, TRACK_BYTES);
    await delay(40);
    this.transfers[id] = {
      received: TRACK_BYTES / 2,
      total: TRACK_BYTES,
      active: true,
      cached: false,
    };
    onProgress(TRACK_BYTES / 2, TRACK_BYTES);
    await delay(40);
    this.nativeCache.set(id, TRACK_BYTES);
    this.cached.add(id);
    this.transfers[id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: true,
    };
    onProgress(TRACK_BYTES, TRACK_BYTES);
    return true;
  }

  async playNative(track, queue) {
    this.queue = queue.map(({ id }) => id);
    this.currentIndex = this.queue.indexOf(track.id);
    this.trackId = track.id;
    this.position = 0;
    this.playing = true;
    await this.prefetchTrack(track.id);
    const state = this.snapshot();
    const next = this.queue[(this.currentIndex + 1) % this.queue.length];
    if (next && next !== track.id) void this.prefetchTrack(next);
    return state;
  }

  playerState(options) {
    const state = this.snapshot(options);
    delete state.timestamp;
    const wait = this.nextPlayerStateDelay ?? 0;
    this.nextPlayerStateDelay = 0;
    if (!wait) return Promise.resolve(state);
    this.metrics.delayedStateCaptured = (this.metrics.delayedStateCaptured ?? 0) + 1;
    return delay(wait).then(() => state);
  }

  setOfflineOnly() {}

  cacheStats() {
    const size = [...this.nativeCache.values()].reduce((total, bytes) => total + bytes, 0);
    return Promise.resolve({
      tracks: { count: this.nativeCache.size, size },
      covers: { count: 0, size: 0 },
    });
  }

  prioritizeAudio() {}
  free() {}
}

export class ClientCore {
  static prepare() {}
  static prepareCaches() {}
  static buildInfo() {
    return Promise.resolve({
      platform: "Desktop",
      epoch: __DESKTOP_EPOCH__,
      epochCommit: __DESKTOP_EPOCH_COMMIT__,
    });
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
    return Promise.resolve(new MusicClient(new DesktopInner()));
  }
  static cacheStats() {
    return Promise.resolve({ tracks: { count: 0, size: 0 }, covers: { count: 0, size: 0 } });
  }
}

export function subscribeNativePlayerState() {
  return () => {};
}
