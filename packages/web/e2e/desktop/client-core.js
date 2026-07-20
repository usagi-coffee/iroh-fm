import { album, delay, NativeFixtureClient, silentWav, TRACK_BYTES, tracks } from "../fixtures.js";

import { MusicClient } from "@iroh-fm/client";

class DesktopInner extends NativeFixtureClient {
  native = false;
  nativeCache = new Map();
  queued = new Set();
  metrics = { downloads: {} };

  constructor() {
    super();
    globalThis.__IROH_FM_E2E_METRICS__ = this.metrics;
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

  cachedTrackIds() {
    return Promise.resolve(new Set(this.nativeCache.keys()));
  }

  cachedTrackBlob(id) {
    return Promise.resolve(this.nativeCache.get(id) ?? null);
  }

  async prefetchTrack(id, onProgress = () => {}) {
    const existing = this.nativeCache.get(id);
    if (existing) {
      onProgress(existing.size, existing.size);
      void this.queueCached(id, existing);
      return true;
    }
    this.metrics.downloads[id] = (this.metrics.downloads[id] ?? 0) + 1;
    onProgress(0, TRACK_BYTES);
    await delay(40);
    onProgress(TRACK_BYTES / 2, TRACK_BYTES);
    await delay(40);
    const blob = silentWav();
    this.nativeCache.set(id, blob);
    this.cached.add(id);
    onProgress(blob.size, blob.size);
    void this.queueCached(id, blob);
    return true;
  }

  async queueCached(id, blob) {
    await blob.arrayBuffer();
    return this.queueNativeBytes(id);
  }

  async playNativeBytes(track, queue) {
    this.queue = queue.map(({ id }) => id);
    this.currentIndex = this.queue.indexOf(track.id);
    this.trackId = track.id;
    this.position = 0;
    this.playing = true;
    this.queued = new Set([track.id]);
    this.transfers[track.id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: true,
    };
    return this.snapshot();
  }

  queueNativeBytes(id) {
    if (!this.queue.includes(id)) return Promise.resolve(false);
    this.queued.add(id);
    return Promise.resolve(true);
  }

  setOfflineOnly() {}

  cacheStats() {
    const size = [...this.nativeCache.values()].reduce((total, blob) => total + blob.size, 0);
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
    return Promise.resolve(new MusicClient(new DesktopInner()));
  }
  static cacheStats() {
    return Promise.resolve({ tracks: { count: 0, size: 0 }, covers: { count: 0, size: 0 } });
  }
}

export function subscribeNativePlayerState() {
  return () => {};
}
