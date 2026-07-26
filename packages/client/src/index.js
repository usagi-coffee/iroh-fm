import {
  bootstrap as bootstrapProtocol,
  createPlaylist as createPlaylistProtocol,
  decodeResponse,
  deletePlaylist as deletePlaylistProtocol,
  encodeRequest,
  getPlaylist as getPlaylistProtocol,
  reorderPlaylists as reorderPlaylistsProtocol,
  setStarred as setStarredProtocol,
  updatePlaylist as updatePlaylistProtocol,
} from "./protocol.js";

let modulePromise;
const COVER_CACHE_NAME = "iroh-fm-cover-art-v2";
const COVER_CACHE_ORIGIN = "https://cover-cache.iroh-fm.invalid";
const TRACK_CACHE_NAME = "iroh-fm-track-audio-v1";
const TRACK_CACHE_ORIGIN = "https://track-cache.iroh-fm.invalid";
const MAX_CONCURRENT_COVER_FETCHES = 3;
const MAX_COVER_FETCHES_DURING_AUDIO = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const MEMORY_CACHE_SIZE_KEY = "iroh-fm-memory-cache-size";
export const DEFAULT_MEMORY_CACHE_BYTES = 256 * 1024 * 1024;
export const ANDROID_DEFAULT_MEMORY_CACHE_BYTES = 64 * 1024 * 1024;
const MIN_MEMORY_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_MEMORY_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
export const ANDROID_MAX_MEMORY_CACHE_BYTES = 256 * 1024 * 1024;
const MEMORY_TRACK_CACHE_MAX_BYTES = DEFAULT_MEMORY_CACHE_BYTES;
const MAX_MEDIA_BUFFER_AHEAD_SECONDS = 90;
const RETAIN_MEDIA_BUFFER_BEHIND_SECONDS = 15;
const MEDIA_BUFFER_RETRY_MS = 250;

/**
 * @param {string} remoteId
 * @param {string} coverId
 */
function coverCacheRequest(remoteId, coverId) {
  const url = new URL("/cover", COVER_CACHE_ORIGIN);
  url.searchParams.set("server", String(remoteId));
  url.searchParams.set("id", coverId);
  return new Request(url);
}

/**
 * @param {string} remoteId
 * @param {string} trackId
 */
function trackCacheRequest(remoteId, trackId) {
  const url = new URL("/track", TRACK_CACHE_ORIGIN);
  url.searchParams.set("server", String(remoteId));
  url.searchParams.set("id", trackId);
  return new Request(url);
}

/**
 * @param {string} name
 * @param {string} [remoteId]
 */
async function cacheUsage(name, remoteId) {
  if (!("caches" in globalThis)) return { count: 0, size: 0 };
  try {
    const cache = await globalThis.caches.open(name);
    const requests = (await cache.keys()).filter(
      (request) =>
        remoteId === undefined ||
        new URL(request.url).searchParams.get("server") === String(remoteId),
    );
    let size = 0;
    for (const request of requests) {
      const response = await cache.match(request);
      if (response) size += (await response.blob()).size;
    }
    return { count: requests.length, size };
  } catch {
    return { count: 0, size: 0 };
  }
}

/**
 * @param {string} name
 * @param {string} remoteId
 */
async function clearCacheEntries(name, remoteId) {
  if (!("caches" in globalThis)) return;
  const cache = await globalThis.caches.open(name);
  const requests = (await cache.keys()).filter(
    (request) => new URL(request.url).searchParams.get("server") === String(remoteId),
  );
  await Promise.all(requests.map((request) => cache.delete(request)));
}

/** @param {'tracks' | 'covers'} kind */
function persistentCacheName(kind) {
  if (kind === "tracks") return TRACK_CACHE_NAME;
  if (kind === "covers") return COVER_CACHE_NAME;
  throw new Error(`unknown offline cache kind: ${kind}`);
}

export class TrackMemoryCache {
  /** @param {number} maxBytes */
  constructor(maxBytes = MEMORY_TRACK_CACHE_MAX_BYTES) {
    this.maxBytes = maxBytes;
    /** @type {Map<string, Blob>} */
    this.entries = new Map();
    this.bytes = 0;
  }

  /** @param {string} id */
  get(id) {
    const blob = this.entries.get(id);
    if (!blob) return null;
    this.entries.delete(id);
    this.entries.set(id, blob);
    return blob;
  }

  /**
   * @param {string} id
   * @param {Blob} blob
   */
  set(id, blob) {
    if (blob.size <= 0 || blob.size > this.maxBytes) return false;
    const previous = this.entries.get(id);
    if (previous) this.bytes -= previous.size;
    this.entries.delete(id);
    while (this.bytes + blob.size > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.bytes -= evicted.size;
    }
    this.entries.set(id, blob);
    this.bytes += blob.size;
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  /** @param {number} maxBytes */
  resize(maxBytes) {
    this.maxBytes = maxBytes;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.bytes -= evicted.size;
    }
  }
}

/**
 * @param {number} bytes
 * @param {number} defaultBytes
 * @param {number} maxBytes
 */
function normalizeMemoryCacheBytes(bytes, defaultBytes, maxBytes) {
  if (!Number.isFinite(bytes)) return defaultBytes;
  return Math.min(maxBytes, Math.max(MIN_MEMORY_CACHE_BYTES, Math.round(bytes)));
}

/** @param {Promise<any>} pending */
async function connectionWithTimeout(pending) {
  let timeoutId;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("connection timed out after 10 seconds")),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    pending
      .then(async (inner) => {
        try {
          await inner.close();
        } finally {
          inner.free();
        }
      })
      .catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadWasm() {
  modulePromise ??= import("./wasm/iroh_fm_web_wasm.js").then(async (module) => {
    await module.default();
    return module;
  });
  return modulePromise;
}

export class MusicClient {
  /** @param {any} inner */
  constructor(inner) {
    this.inner = inner;
    /** @type {Map<string, Promise<string>>} */
    this.coverCache = new Map();
    /** @type {Map<string, Promise<Blob>>} */
    this.activeTrackRequests = new Map();
    this.memoryTrackCache = new TrackMemoryCache(MusicClient.memoryCacheSize());
    if (typeof this.inner.setMemoryCacheSize === "function")
      void this.inner.setMemoryCacheSize(this.memoryTrackCache.maxBytes);
    /** @type {Map<string, {received: number, total: number, listeners: Set<(received: number, total: number) => void>}>} */
    this.trackProgress = new Map();
    /** @type {Array<{id: string, fullQuality: boolean, resolve: (value: any) => void, reject: (reason?: any) => void}>} */
    this.coverFetchQueue = [];
    this.activeCoverFetches = 0;
    this.coverFetchPaused = false;
    this.audioOpenRequests = 0;
    this.activeAudioSources = 0;
    this.offlineOnly = false;
    this.closed = false;
  }

  static async prepare() {
    await loadWasm();
  }

  static memoryCacheSize(
    maxBytes = MAX_MEMORY_CACHE_BYTES,
    defaultBytes = DEFAULT_MEMORY_CACHE_BYTES,
  ) {
    if (typeof localStorage === "undefined") return defaultBytes;
    const configured = localStorage.getItem(MEMORY_CACHE_SIZE_KEY);
    if (configured === null) return defaultBytes;
    return normalizeMemoryCacheBytes(Number(configured) * 1024 * 1024, defaultBytes, maxBytes);
  }

  /**
   * @param {number} megabytes
   * @param {number} [maxBytes]
   * @param {number} [defaultBytes]
   */
  static setMemoryCacheSize(
    megabytes,
    maxBytes = MAX_MEMORY_CACHE_BYTES,
    defaultBytes = DEFAULT_MEMORY_CACHE_BYTES,
  ) {
    const bytes = normalizeMemoryCacheBytes(
      Number(megabytes) * 1024 * 1024,
      defaultBytes,
      maxBytes,
    );
    if (typeof localStorage !== "undefined")
      localStorage.setItem(MEMORY_CACHE_SIZE_KEY, String(Math.round(bytes / 1024 / 1024)));
    return bytes;
  }

  static async prepareCaches() {
    if (!("caches" in globalThis)) return;
    try {
      await Promise.all([
        globalThis.caches.open(TRACK_CACHE_NAME),
        globalThis.caches.open(COVER_CACHE_NAME),
      ]);
    } catch {
      // Cache Storage can be unavailable in private browsing contexts.
    }
  }

  /**
   * @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} connection
   */
  static async connect({ ticket = "", endpoint = "", relays = [], secret = "" }) {
    const { IrohFmClient } = await loadWasm();
    const identity = secret.trim() || undefined;
    const pending = endpoint.trim()
      ? IrohFmClient.connectAdvanced(endpoint.trim(), JSON.stringify(relays), identity)
      : IrohFmClient.connect(ticket.trim(), identity);
    const inner = await connectionWithTimeout(pending);
    return new MusicClient(inner);
  }

  /** @param {string} ticket */
  static async parseTicket(ticket) {
    const { parseEndpointTicket } = await loadWasm();
    return JSON.parse(parseEndpointTicket(ticket));
  }

  static async generateIdentity() {
    const { generateIdentity } = await loadWasm();
    const identity = generateIdentity();
    try {
      return { secret: identity.secret, endpointId: identity.endpointId };
    } finally {
      identity.free();
    }
  }

  /** @param {string} secret */
  static async endpointIdForSecret(secret) {
    const { endpointIdForSecret } = await loadWasm();
    return endpointIdForSecret(secret);
  }

  static async cacheStats() {
    const [tracks, covers] = await Promise.all([
      cacheUsage(TRACK_CACHE_NAME),
      cacheUsage(COVER_CACHE_NAME),
    ]);
    return { tracks, covers };
  }

  async cacheStats() {
    if (typeof this.inner.cacheStats === "function") return this.inner.cacheStats();
    const [tracks, covers] = await Promise.all([
      cacheUsage(TRACK_CACHE_NAME, this.remoteId),
      cacheUsage(COVER_CACHE_NAME, this.remoteId),
    ]);
    return { tracks, covers };
  }

  /** @param {'tracks' | 'covers'} kind */
  async clearCache(kind) {
    const cacheName = persistentCacheName(kind);
    if (kind === "covers") {
      const pendingUrls = [...this.coverCache.values()];
      this.coverCache.clear();
      for (const result of await Promise.allSettled(pendingUrls)) {
        if (result.status === "fulfilled") URL.revokeObjectURL(result.value);
      }
    }
    if (typeof this.inner.clearCache === "function") {
      await this.inner.clearCache(kind);
      return;
    }
    await clearCacheEntries(cacheName, this.remoteId);
  }

  get endpointId() {
    return this.inner.endpointId;
  }

  get remoteId() {
    return this.inner.remoteId;
  }

  connectionInfo() {
    return JSON.parse(this.inner.connectionInfo());
  }

  get nativePlayback() {
    return Boolean(this.inner.nativePlayback);
  }

  get native() {
    return Boolean(this.inner.native);
  }

  /**
   * @param {{id: string}} track
   * @param {Array<{id: string}>} queue
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async playNative(track, queue, onProgress = () => {}) {
    if (typeof this.inner.playNativeBytes !== "function")
      return this.inner.playNative(track, queue);
    const cached = await this.cachedTrack(track.id);
    const blob = cached?.blob ?? (await this.downloadTrackBlob(track.id, onProgress));
    if (!cached) await this.rememberTrackBlob(track.id, blob);
    onProgress(blob.size, blob.size);
    const state = await this.inner.playNativeBytes(
      track,
      queue,
      new Uint8Array(await blob.arrayBuffer()),
    );
    state.transfers = {
      ...state.transfers,
      [track.id]: {
        received: blob.size,
        total: blob.size,
        active: false,
        cached: false,
        memoryCached: true,
      },
    };
    return state;
  }

  /**
   * @param {string} command
   * @param {Record<string, any>} [payload]
   */
  playerCommand(command, payload = {}) {
    return this.inner.playerCommand(command, payload);
  }

  /** @param {{includeQueue?: boolean}} [options] */
  playerState(options) {
    return this.inner.playerState(options);
  }

  /** @param {boolean} offlineOnly */
  setOfflineOnly(offlineOnly) {
    this.offlineOnly = Boolean(offlineOnly);
    if (!this.offlineOnly) this.drainCoverFetchQueue();
    if (typeof this.inner.setOfflineOnly === "function")
      return this.inner.setOfflineOnly(this.offlineOnly);
  }

  async cachedTrackIds() {
    if (typeof this.inner.cachedTrackIds === "function") return this.inner.cachedTrackIds();
    const ids = new Set();
    if (!("caches" in globalThis)) return ids;
    try {
      const cache = await globalThis.caches.open(TRACK_CACHE_NAME);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.searchParams.get("server") === String(this.remoteId)) {
          const id = url.searchParams.get("id");
          if (id) ids.add(id);
        }
      }
    } catch {
      // Cache Storage can be unavailable in private browsing contexts.
    }
    return ids;
  }

  /** Explicitly download a track into persistent storage. */
  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async cacheTrack(id, onProgress = () => {}) {
    if (typeof this.inner.cacheTrack === "function")
      return Boolean(await this.inner.cacheTrack(id, onProgress));
    if (await this.isTrackCached(id)) return true;

    const cached = await this.cachedTrack(id);
    let blob = cached?.blob;
    if (!blob) {
      const existing = this.activeTrackRequests.get(id);
      if (existing) blob = await existing;
      else {
        const pending = this.downloadTrackBlob(id, (received, total) => {
          onProgress(received, total);
          this.notifyTrackProgress(id, received, total);
        });
        this.activeTrackRequests.set(id, pending);
        pending
          .finally(() => {
            if (this.activeTrackRequests.get(id) === pending) this.activeTrackRequests.delete(id);
          })
          .catch(() => {});
        try {
          blob = await pending;
        } finally {
          if (this.activeTrackRequests.get(id) === pending) this.activeTrackRequests.delete(id);
        }
        await this.rememberTrackBlob(id, blob);
      }
    }
    return blob ? this.persistTrackBlob(id, blob) : false;
  }

  /** @param {number} bytes */
  setMemoryCacheSize(bytes) {
    const size = normalizeMemoryCacheBytes(
      bytes,
      DEFAULT_MEMORY_CACHE_BYTES,
      MAX_MEMORY_CACHE_BYTES,
    );
    this.memoryTrackCache.resize(size);
    if (typeof this.inner.setMemoryCacheSize === "function")
      return this.inner.setMemoryCacheSize(size);
    return Promise.resolve();
  }

  /** @param {import('./types.ts').BackendRequest} request */
  async request(request) {
    return decodeResponse(await this.inner.request(encodeRequest(request)));
  }

  async bootstrap(starredKey = "") {
    return bootstrapProtocol(this.request.bind(this), starredKey);
  }

  /**
   * @param {string} id
   * @param {boolean} starred
   * @param {string} [key]
   */
  setStarred(id, starred, key = "") {
    return setStarredProtocol(this.request.bind(this), id, starred, key);
  }

  /** @param {string} id */
  getPlaylist(id) {
    return getPlaylistProtocol(this.request.bind(this), id);
  }

  /** @param {string} name @param {string[]} [trackIds] */
  createPlaylist(name, trackIds = []) {
    return createPlaylistProtocol(this.request.bind(this), name, trackIds);
  }

  /** @param {string} id @param {{name?: string, comment?: string, trackIds?: string[]}} fields */
  updatePlaylist(id, fields) {
    return updatePlaylistProtocol(this.request.bind(this), id, fields);
  }

  /** @param {string} id */
  deletePlaylist(id) {
    return deletePlaylistProtocol(this.request.bind(this), id);
  }

  /** @param {string[]} ids */
  reorderPlaylists(ids) {
    return reorderPlaylistsProtocol(this.request.bind(this), ids);
  }

  /**
   * @param {string} id
   * @param {{ fullQuality?: boolean }} [options]
   */
  coverUrl(id, { fullQuality = false } = {}) {
    const key = `${id}\u0000${fullQuality ? "full" : "thumbnail"}`;
    let pending = this.coverCache.get(key);
    if (!pending) {
      const created = this.loadCoverUrl(id, fullQuality);
      this.coverCache.set(key, created);
      created.catch(() => {
        if (this.coverCache.get(key) === created) this.coverCache.delete(key);
      });
      pending = created;
    }
    return pending;
  }

  /**
   * @param {string} id
   * @param {boolean} fullQuality
   */
  async loadCoverUrl(id, fullQuality) {
    let cache;
    let request;
    if (!this.inner.native && !fullQuality && "caches" in globalThis) {
      try {
        cache = await globalThis.caches.open(COVER_CACHE_NAME);
        request = coverCacheRequest(this.remoteId, id);
        const cached = await cache.match(request);
        if (cached) {
          const blob = await cached.blob();
          if (blob.size > 0) return URL.createObjectURL(blob);
          await cache.delete(request);
        }
      } catch {
        cache = undefined;
        request = undefined;
      }
    }

    if (this.offlineOnly && !this.inner.native) throw new Error("cover is not available offline");

    const media = await this.enqueueCoverFetch(id, fullQuality);
    let blob;
    try {
      blob = new Blob([media.bytes], { type: media.contentType });
    } finally {
      media.free();
    }

    if (cache && request) {
      try {
        await cache.put(
          request,
          new Response(blob, {
            headers: {
              "content-type": blob.type || "application/octet-stream",
              "x-iroh-fm-cover-id": id,
            },
          }),
        );
      } catch {
        // Private browsing and storage quotas may make Cache Storage unavailable.
      }
    }

    return URL.createObjectURL(blob);
  }

  /**
   * @param {string} id
   * @param {boolean} fullQuality
   * @returns {Promise<any>}
   */
  enqueueCoverFetch(id, fullQuality) {
    if (this.closed) return Promise.reject(new Error("music client is closed"));
    if (this.offlineOnly) return Promise.reject(new Error("cover is not available offline"));
    return new Promise((resolve, reject) => {
      this.coverFetchQueue.push({ id, fullQuality, resolve, reject });
      this.drainCoverFetchQueue();
    });
  }

  drainCoverFetchQueue() {
    const concurrency =
      this.activeAudioSources > 0 ? MAX_COVER_FETCHES_DURING_AUDIO : MAX_CONCURRENT_COVER_FETCHES;
    while (
      !this.closed &&
      !this.offlineOnly &&
      !this.coverFetchPaused &&
      this.activeCoverFetches < concurrency &&
      this.coverFetchQueue.length > 0
    ) {
      const job = this.coverFetchQueue.shift();
      if (!job) return;
      this.activeCoverFetches += 1;
      Promise.resolve()
        .then(() => this.inner.fetchCover(job.id, job.fullQuality))
        .then(job.resolve, (error) => {
          if (this.coverFetchPaused && !this.closed) this.coverFetchQueue.unshift(job);
          else job.reject(error);
        })
        .finally(() => {
          this.activeCoverFetches -= 1;
          this.drainCoverFetchQueue();
        });
    }
  }

  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async trackSource(id, onProgress = () => {}) {
    const active = this.activeTrackRequests.get(id);
    const unsubscribe = active ? this.subscribeTrackProgress(id, onProgress) : () => {};
    const cached = await this.cachedTrack(id);
    if (cached) {
      unsubscribe();
      onProgress(cached.blob.size, cached.blob.size);
      const cacheReady = Promise.resolve(cached.persistent ? "disk" : "memory");
      return new BlobTrackSource(cached.blob, () => {}, cacheReady);
    }
    unsubscribe();
    if (this.offlineOnly) throw new Error("track is not available offline");

    this.audioOpenRequests += 1;
    this.coverFetchPaused = true;
    this.inner.prioritizeAudio();
    try {
      const media = await this.inner.openTrack(id);
      let stream;
      let contentType;
      let fileSize;
      try {
        contentType = media.contentType;
        fileSize = Number(media.fileSize);
        stream = media.takeStream();
      } finally {
        media.free();
      }

      this.activeAudioSources += 1;
      let released = false;
      const releaseAudioPriority = () => {
        if (released) return;
        released = true;
        this.activeAudioSources = Math.max(0, this.activeAudioSources - 1);
        queueMicrotask(() => this.drainCoverFetchQueue());
      };

      try {
        /**
         * @param {number} received
         * @param {number} total
         */
        const reportProgress = (received, total) => {
          onProgress(received, total);
          this.notifyTrackProgress(id, received, total);
        };
        reportProgress(0, fileSize);
        if (this.inner.supportsProgressivePlayback !== false && canUseMediaSource(contentType)) {
          return new ProgressiveTrackSource(
            stream,
            contentType,
            fileSize,
            reportProgress,
            releaseAudioPriority,
            (blob) => this.rememberTrackBlob(id, blob),
          );
        }

        const blob = await new Response(trackDownload(stream, fileSize, reportProgress), {
          headers: { "content-type": contentType },
        }).blob();
        return new BlobTrackSource(blob, releaseAudioPriority, this.rememberTrackBlob(id, blob));
      } catch (error) {
        releaseAudioPriority();
        throw error;
      }
    } finally {
      this.audioOpenRequests -= 1;
      if (this.audioOpenRequests === 0) {
        this.coverFetchPaused = false;
        this.drainCoverFetchQueue();
      }
    }
  }

  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  prefetchTrack(id, onProgress = () => {}) {
    const unsubscribe = this.subscribeTrackProgress(id, onProgress);
    const known = this.cachedTrack(id);
    const existing = this.activeTrackRequests.get(id);
    if (existing)
      return existing.finally(unsubscribe).then(async (blob) => {
        this.queueNativeTrack(id, blob);
        return { cached: true, persistent: await this.isTrackCached(id) };
      });

    const pending = known.then(async (cached) => {
      if (cached) {
        this.notifyTrackProgress(id, cached.blob.size, cached.blob.size);
        return cached.blob;
      }
      if (this.offlineOnly) throw new Error("track is not available offline");
      const blob = await this.downloadTrackBlob(id, (received, total) =>
        this.notifyTrackProgress(id, received, total),
      );
      await this.rememberTrackBlob(id, blob);
      return blob;
    });
    this.activeTrackRequests.set(id, pending);
    pending
      .finally(() => {
        if (this.activeTrackRequests.get(id) === pending) this.activeTrackRequests.delete(id);
      })
      .catch(() => {});
    return pending.finally(unsubscribe).then(async (blob) => {
      this.queueNativeTrack(id, blob);
      return { cached: true, persistent: await this.isTrackCached(id) };
    });
  }

  /**
   * Native playback queueing is independent from the persistent-cache result.
   * @param {string} id
   * @param {Blob} blob
   */
  queueNativeTrack(id, blob) {
    if (typeof this.inner.queueNativeBytes !== "function") return;
    void blob
      .arrayBuffer()
      .then((data) => this.inner.queueNativeBytes(id, new Uint8Array(data)))
      .catch((error) => console.warn("[player] native queue upload failed", error));
  }

  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} listener
   */
  subscribeTrackProgress(id, listener) {
    let state = this.trackProgress.get(id);
    if (!state) {
      state = { received: 0, total: 0, listeners: new Set() };
      this.trackProgress.set(id, state);
    }
    state.listeners.add(listener);
    listener(state.received, state.total);
    return () => state.listeners.delete(listener);
  }

  /**
   * @param {string} id
   * @param {number} received
   * @param {number} total
   */
  notifyTrackProgress(id, received, total) {
    let state = this.trackProgress.get(id);
    if (!state) {
      state = { received: 0, total: 0, listeners: new Set() };
      this.trackProgress.set(id, state);
    }
    state.received = received;
    state.total = total;
    for (const listener of state.listeners) listener(received, total);
  }

  /** @param {string} id */
  async cachedTrack(id) {
    const existing = this.activeTrackRequests.get(id);
    if (existing) {
      try {
        const blob = await existing;
        return { blob, persistent: await this.isTrackCached(id) };
      } catch {
        if (this.activeTrackRequests.get(id) === existing) this.activeTrackRequests.delete(id);
      }
    }

    const memory = this.memoryTrackCache.get(id);
    if (memory) return { blob: memory, persistent: false };
    const blob = await this.readPersistentTrackBlob(id);
    if (blob) this.memoryTrackCache.set(id, blob);
    return blob ? { blob, persistent: true } : null;
  }

  /** @param {string} id */
  async isTrackCached(id) {
    if (!("caches" in globalThis)) return false;
    try {
      const cache = await globalThis.caches.open(TRACK_CACHE_NAME);
      const response = await cache.match(trackCacheRequest(this.remoteId, id));
      if (!response) return false;
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) return Number(declaredLength) > 0;
      return (await response.blob()).size > 0;
    } catch {
      return false;
    }
  }

  /** @param {string} id */
  async readPersistentTrackBlob(id) {
    if (!("caches" in globalThis)) return null;
    try {
      const cache = await globalThis.caches.open(TRACK_CACHE_NAME);
      const request = trackCacheRequest(this.remoteId, id);
      const response = await cache.match(request);
      if (!response) return null;
      const blob = await response.blob();
      if (blob.size > 0) return blob;
      await cache.delete(request);
    } catch {
      // Cache Storage can be unavailable in private browsing contexts.
    }
    return null;
  }

  /**
   * @param {string} id
   * @param {Blob} blob
   * @returns {Promise<string | false>}
   */
  rememberTrackBlob(id, blob) {
    return Promise.resolve(this.memoryTrackCache.set(id, blob) ? "memory" : false);
  }

  /**
   * @param {string} id
   * @param {Blob} blob
   */
  async persistTrackBlob(id, blob) {
    if (!("caches" in globalThis) || blob.size === 0) return false;
    try {
      const cache = await globalThis.caches.open(TRACK_CACHE_NAME);
      await cache.put(
        trackCacheRequest(this.remoteId, id),
        new Response(blob, {
          headers: {
            "content-type": blob.type || "application/octet-stream",
            "content-length": String(blob.size),
            "x-iroh-fm-track-id": id,
          },
        }),
      );
      return true;
    } catch {
      // Storage quotas and private browsing can reject persistent writes.
      return false;
    }
  }

  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async downloadTrackBlob(id, onProgress = () => {}) {
    this.audioOpenRequests += 1;
    this.coverFetchPaused = true;
    this.inner.prioritizeAudio();
    try {
      const media = await this.inner.openTrack(id);
      let stream;
      let contentType;
      let fileSize;
      try {
        contentType = media.contentType;
        fileSize = Number(media.fileSize);
        stream = media.takeStream();
      } finally {
        media.free();
      }

      this.activeAudioSources += 1;
      try {
        onProgress(0, fileSize);
        return await new Response(trackDownload(stream, fileSize, onProgress), {
          headers: { "content-type": contentType },
        }).blob();
      } finally {
        this.activeAudioSources = Math.max(0, this.activeAudioSources - 1);
        queueMicrotask(() => this.drainCoverFetchQueue());
      }
    } finally {
      this.audioOpenRequests -= 1;
      if (this.audioOpenRequests === 0) {
        this.coverFetchPaused = false;
        this.drainCoverFetchQueue();
      }
    }
  }

  async close() {
    this.closed = true;
    const closeError = new Error("music client is closed");
    for (const job of this.coverFetchQueue.splice(0)) job.reject(closeError);
    for (const pending of this.coverCache.values()) {
      pending.then(URL.revokeObjectURL).catch(() => {});
    }
    this.coverCache.clear();
    this.activeTrackRequests.clear();
    this.memoryTrackCache.clear();
    this.trackProgress.clear();
    await this.inner.close();
    this.inner.free();
  }
}

class BlobTrackSource {
  /**
   * @param {Blob} blob
   * @param {() => void} releaseAudioPriority
   * @param {Promise<string | false>} cacheReady
   */
  constructor(blob, releaseAudioPriority, cacheReady) {
    this.url = URL.createObjectURL(blob);
    this.done = cacheReady;
    this.disposed = false;
    this.releaseAudioPriority = releaseAudioPriority;
  }

  /** @param {HTMLMediaElement} _mediaElement */
  async start(_mediaElement) {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAudioPriority();
    URL.revokeObjectURL(this.url);
  }
}

class ProgressiveTrackSource {
  /**
   * @param {ReadableStream<Uint8Array>} stream
   * @param {string} contentType
   * @param {number} fileSize
   * @param {(received: number, total: number) => void} onProgress
   * @param {() => void} releaseAudioPriority
   * @param {(blob: Blob) => Promise<string | false>} onComplete
   */
  constructor(stream, contentType, fileSize, onProgress, releaseAudioPriority, onComplete) {
    this.stream = stream;
    this.contentType = contentType;
    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    this.reader = stream.getReader();
    this.fileSize = fileSize;
    this.received = 0;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.done = /** @type {Promise<string | false>} */ (Promise.resolve(false));
    this.disposed = false;
    this.releaseAudioPriority = releaseAudioPriority;
    /** @type {null | (() => void)} */
    this.cancelOpen = null;
  }

  /** @param {HTMLMediaElement} mediaElement */
  async start(mediaElement) {
    if (this.disposed) throw new DOMException("Track was cancelled", "AbortError");
    await this.waitUntilOpen();
    if (this.disposed) throw new DOMException("Track was cancelled", "AbortError");

    const sourceBuffer = this.mediaSource.addSourceBuffer(this.contentType);
    const first = await this.reader.read();
    if (first.done) {
      this.onProgress(this.fileSize, this.fileSize);
      this.done = this.completeCache();
      this.finishMediaSource();
      return;
    }
    this.reportChunk(first.value);
    await appendMediaBuffer(sourceBuffer, first.value, mediaElement, () => this.disposed);
    this.done = this.pump(sourceBuffer, mediaElement);
  }

  /**
   * @param {SourceBuffer} sourceBuffer
   * @param {HTMLMediaElement} mediaElement
   */
  async pump(sourceBuffer, mediaElement) {
    try {
      while (!this.disposed) {
        await waitForMediaBufferRoom(sourceBuffer, mediaElement, () => this.disposed);
        if (this.disposed) return false;
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.reportChunk(chunk.value);
        await appendMediaBuffer(sourceBuffer, chunk.value, mediaElement, () => this.disposed);
      }
      if (!this.disposed) {
        this.onProgress(this.fileSize, this.fileSize);
        const cacheReady = this.completeCache();
        this.finishMediaSource();
        return await cacheReady;
      }
      return false;
    } catch (error) {
      if (!this.disposed) throw error;
      return false;
    }
  }

  /** @param {Uint8Array} chunk */
  reportChunk(chunk) {
    this.received += chunk.byteLength;
    this.chunks.push(chunk);
    this.onProgress(this.received, this.fileSize);
  }

  completeCache() {
    const chunks = this.chunks;
    this.chunks = [];
    return this.onComplete(
      new Blob(
        chunks.map((chunk) => Uint8Array.from(chunk).buffer),
        { type: this.contentType },
      ),
    );
  }

  /** @returns {Promise<void>} */
  waitUntilOpen() {
    if (this.mediaSource.readyState === "open") return Promise.resolve();
    /** @type {(resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: any) => void) => void} */
    const executor = (resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve(undefined);
      };
      const cleanup = () => {
        this.mediaSource.removeEventListener("sourceopen", opened);
        this.cancelOpen = null;
      };
      this.cancelOpen = () => {
        cleanup();
        reject(new DOMException("Track was cancelled", "AbortError"));
      };
      this.mediaSource.addEventListener("sourceopen", opened, { once: true });
    };
    return new Promise(executor);
  }

  finishMediaSource() {
    if (this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // The element may have been detached while the final chunk arrived.
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAudioPriority();
    this.cancelOpen?.();
    this.reader.cancel().catch(() => {});
    this.chunks = [];
    this.finishMediaSource();
    URL.revokeObjectURL(this.url);
  }
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} total
 * @param {(received: number, total: number) => void} onProgress
 */
function trackDownload(stream, total, onProgress) {
  const reader = stream.getReader();
  let received = 0;
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        onProgress(total, total);
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      onProgress(received, total);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** @param {string} contentType */
function canUseMediaSource(contentType) {
  return (
    typeof MediaSource !== "undefined" &&
    contentType.split(";", 1)[0].trim().toLowerCase() === "audio/mpeg" &&
    MediaSource.isTypeSupported(contentType)
  );
}

/**
 * @param {SourceBuffer} sourceBuffer
 * @param {Uint8Array} chunk
 * @param {HTMLMediaElement} mediaElement
 * @param {() => boolean} disposed
 */
async function appendMediaBuffer(sourceBuffer, chunk, mediaElement, disposed) {
  while (!disposed()) {
    await waitForMediaBufferRoom(sourceBuffer, mediaElement, disposed);
    if (disposed()) break;
    try {
      await updateSourceBuffer(sourceBuffer, () => {
        sourceBuffer.appendBuffer(/** @type {BufferSource} */ (chunk));
      });
      return;
    } catch (error) {
      if (!isSourceBufferQuotaError(error)) throw error;
      if (!(await evictPlayedMediaBuffer(sourceBuffer, mediaElement))) {
        await waitForMediaProgress(mediaElement);
      }
    }
  }
  throw new DOMException("Track was cancelled", "AbortError");
}

/**
 * @param {SourceBuffer} sourceBuffer
 * @param {HTMLMediaElement} mediaElement
 * @param {() => boolean} disposed
 */
async function waitForMediaBufferRoom(sourceBuffer, mediaElement, disposed) {
  while (
    !disposed() &&
    mediaBufferAhead(sourceBuffer, mediaElement) > MAX_MEDIA_BUFFER_AHEAD_SECONDS
  ) {
    await waitForMediaProgress(mediaElement);
  }
}

/**
 * @param {SourceBuffer} sourceBuffer
 * @param {HTMLMediaElement} mediaElement
 */
function mediaBufferAhead(sourceBuffer, mediaElement) {
  try {
    const ranges = sourceBuffer.buffered;
    if (!ranges.length) return 0;
    return Math.max(0, ranges.end(ranges.length - 1) - mediaElement.currentTime);
  } catch {
    return 0;
  }
}

/** @param {HTMLMediaElement} mediaElement */
function waitForMediaProgress(mediaElement) {
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timeout);
      mediaElement.removeEventListener("timeupdate", complete);
      mediaElement.removeEventListener("seeking", complete);
      resolve(undefined);
    };
    const timeout = setTimeout(complete, MEDIA_BUFFER_RETRY_MS);
    mediaElement.addEventListener("timeupdate", complete, { once: true });
    mediaElement.addEventListener("seeking", complete, { once: true });
  });
}

/**
 * @param {SourceBuffer} sourceBuffer
 * @param {HTMLMediaElement} mediaElement
 */
async function evictPlayedMediaBuffer(sourceBuffer, mediaElement) {
  const cutoff = mediaElement.currentTime - RETAIN_MEDIA_BUFFER_BEHIND_SECONDS;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return false;
  try {
    const ranges = sourceBuffer.buffered;
    if (!ranges.length || ranges.start(0) >= cutoff) return false;
    await updateSourceBuffer(sourceBuffer, () => sourceBuffer.remove(0, cutoff));
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} error */
function isSourceBufferQuotaError(error) {
  return (
    (error instanceof DOMException && error.name === "QuotaExceededError") ||
    /sourcebuffer is full|quota/i.test(String(error))
  );
}

/**
 * @param {SourceBuffer} sourceBuffer
 * @param {() => void} update
 * @returns {Promise<void>}
 */
function updateSourceBuffer(sourceBuffer, update) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", updated);
      sourceBuffer.removeEventListener("error", failed);
    };
    const updated = () => {
      cleanup();
      resolve(undefined);
    };
    const failed = () => {
      cleanup();
      reject(new Error("The browser could not append this audio stream."));
    };
    sourceBuffer.addEventListener("updateend", updated, { once: true });
    sourceBuffer.addEventListener("error", failed, { once: true });
    try {
      update();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
