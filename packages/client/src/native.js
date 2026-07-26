import {
  bootstrap as bootstrapProtocol,
  createPlaylist as createPlaylistProtocol,
  deletePlaylist as deletePlaylistProtocol,
  getPlaylist as getPlaylistProtocol,
  protocolResponse,
  reorderPlaylists as reorderPlaylistsProtocol,
  setStarred as setStarredProtocol,
  updatePlaylist as updatePlaylistProtocol,
} from "./protocol.js";

const NATIVE_TIMEOUT_MS = 30_000;
const NATIVE_CACHE_TIMEOUT_MS = 60 * 60 * 1_000;
const NATIVE_CACHE_PROGRESS_MS = 250;
const NATIVE_COVER_CONCURRENCY = 3;
const NATIVE_REQUEST_CHUNK_CHARS = 24 * 1024;
const NATIVE_QUEUE_DURATION_SECONDS = 4 * 60 * 60;
const NATIVE_QUEUE_LOOKBEHIND_SECONDS = 30 * 60;
const NATIVE_QUEUE_MAX_TRACKS = 256;
const NATIVE_QUEUE_MAX_LOOKBEHIND_TRACKS = 32;
/** @typedef {{id: string, title: string, artist: string, album: string, duration_seconds?: number | null}} NativeQueueTrack */

/** @param {{duration_seconds?: number | null}} track */
function trackDuration(track) {
  const duration = Number(track.duration_seconds);
  return Number.isFinite(duration) && duration > 0 ? duration : 3 * 60;
}

/**
 * @param {NativeQueueTrack} selected
 * @param {NativeQueueTrack[]} queue
 */
function nativeQueueWindow(selected, queue) {
  const selectedIndex = queue.findIndex((track) => track.id === selected.id);
  if (selectedIndex < 0 || queue.length < 2) return [selected];

  const before = [];
  let behindSeconds = 0;
  for (
    let offset = 1;
    offset < queue.length &&
    before.length < NATIVE_QUEUE_MAX_LOOKBEHIND_TRACKS &&
    behindSeconds < NATIVE_QUEUE_LOOKBEHIND_SECONDS;
    offset += 1
  ) {
    const track = queue[(selectedIndex - offset + queue.length) % queue.length];
    before.unshift(track);
    behindSeconds += trackDuration(track);
  }

  const window = [...before, selected];
  let durationSeconds = behindSeconds + trackDuration(selected);
  for (
    let offset = 1;
    offset < queue.length &&
    window.length < NATIVE_QUEUE_MAX_TRACKS &&
    durationSeconds < NATIVE_QUEUE_DURATION_SECONDS;
    offset += 1
  ) {
    const track = queue[(selectedIndex + offset) % queue.length];
    window.push(track);
    durationSeconds += trackDuration(track);
  }
  return window;
}

/** @type {MessagePort | undefined} */
let port;
let nativeExpected = false;
/** @type {Promise<boolean> | undefined} */
let detection;
let sequence = 0;
let requestChunksSupported = false;
/** @type {Map<string, {action: string, resolve: (value: any) => void, reject: (reason?: any) => void, timer: ReturnType<typeof setTimeout>}>} */
const pending = new Map();
/** @type {Map<string, {parts: string[], received: number, total: number, timer: ReturnType<typeof setTimeout>}>} */
const incomingTransfers = new Map();
/** @type {Set<(state: any) => void>} */
const stateListeners = new Set();

/** @param {MessagePort} nextPort */
function installPort(nextPort) {
  if (port) return;
  port = nextPort;
  port.addEventListener("message", receive);
  port.start();
}

if (typeof window !== "undefined") {
  const injected = /** @type {Window & {__irohFmNative?: MessagePort}} */ (window).__irohFmNative;
  nativeExpected =
    Boolean(injected) ||
    new URL(window.location.href).searchParams.get("iroh-native") === "1" ||
    document.referrer.startsWith("android-app://") ||
    sessionStorage.getItem("iroh-fm-native") === "1";
  if (nativeExpected) sessionStorage.setItem("iroh-fm-native", "1");
  if (injected) installPort(injected);
  window.addEventListener("message", (event) => {
    if (!event.origin.startsWith("android-app") || !event.ports[0]) return;
    installPort(event.ports[0]);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !port) return;
    void nativeRequest("playerState")
      .then(dispatchPlayerState)
      .catch(() => {});
  });
}

/** @param {any} state */
function dispatchPlayerState(state) {
  for (const listener of stateListeners) listener(state);
}

/** @param {MessageEvent} event */
function receive(event) {
  let message;
  try {
    message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }
  receiveMessage(message);
}

/** @param {any} message */
function receiveMessage(message) {
  if (message?.module !== "native") return;
  if (message.event === "chunk") {
    const transferId = String(message.transferId ?? "");
    const index = Number(message.index);
    const total = Number(message.total);
    if (
      !transferId ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      index < 0 ||
      total < 1 ||
      index >= total ||
      typeof message.data !== "string"
    )
      return;
    let transfer = incomingTransfers.get(transferId);
    if (!transfer) {
      const timer = setTimeout(() => incomingTransfers.delete(transferId), NATIVE_TIMEOUT_MS);
      transfer = { parts: Array(total), received: 0, total, timer };
      incomingTransfers.set(transferId, transfer);
    }
    if (transfer.total !== total || transfer.parts[index] !== undefined) return;
    transfer.parts[index] = message.data;
    transfer.received += 1;
    if (transfer.received !== transfer.total) return;
    clearTimeout(transfer.timer);
    incomingTransfers.delete(transferId);
    try {
      receiveMessage(JSON.parse(transfer.parts.join("")));
    } catch {
      // Ignore malformed or incomplete native transfers.
    }
    return;
  }
  if (message.event === "ready" || message.event === "state") {
    if (message.state) dispatchPlayerState(message.state);
    return;
  }
  const request = pending.get(message.id);
  if (!request) {
    if (message.id)
      console.warn(`[native bridge] response has no pending request: id=${message.id}`);
    return;
  }
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (request.action === "play")
    console.info(`[native bridge] response received: action=play id=${message.id}`);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.result);
}

export function detectNative(timeout = 1_500) {
  if (port) return Promise.resolve(true);
  if (!nativeExpected) return Promise.resolve(false);
  detection ??= new Promise((resolve) => {
    const started = performance.now();
    const poll = () => {
      if (port) resolve(true);
      else if (performance.now() - started >= timeout) resolve(false);
      else setTimeout(poll, 25);
    };
    poll();
  });
  return detection;
}

export function isNative() {
  return Boolean(port);
}

/**
 * @param {string} action
 * @param {Record<string, any>} [payload]
 * @param {number} [timeout]
 */
export function nativeRequest(action, payload = {}, timeout = NATIVE_TIMEOUT_MS) {
  const target = port;
  if (!target) {
    console.error(`[native bridge] request rejected before send: action=${action} port=missing`);
    return Promise.reject(new Error("Android native bridge is unavailable"));
  }
  const id = String(++sequence);
  if (action === "play") console.info(`[native bridge] request created: action=play id=${id}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.error(`[native bridge] request timed out: action=${action} id=${id}`);
      reject(new Error(`Native ${action} request timed out`));
    }, timeout);
    pending.set(id, { action, resolve, reject, timer });
    try {
      const raw = JSON.stringify({ module: "native", id, action, payload });
      if (!requestChunksSupported || raw.length <= NATIVE_REQUEST_CHUNK_CHARS) {
        target.postMessage(raw);
        if (action === "play")
          console.info(`[native bridge] request posted: action=play id=${id} chars=${raw.length}`);
        return;
      }
      const total = Math.ceil(raw.length / NATIVE_REQUEST_CHUNK_CHARS);
      if (action === "play")
        console.info(
          `[native bridge] posting chunked request: action=play id=${id} chunks=${total}`,
        );
      for (let index = 0; index < total; index += 1) {
        target.postMessage(
          JSON.stringify({
            module: "native",
            event: "requestChunk",
            transferId: `request-${id}`,
            index,
            total,
            data: raw.slice(
              index * NATIVE_REQUEST_CHUNK_CHARS,
              (index + 1) * NATIVE_REQUEST_CHUNK_CHARS,
            ),
          }),
        );
      }
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      console.error(`[native bridge] postMessage threw: action=${action} id=${id}`, error);
      reject(error);
    }
  });
}

/** @param {(state: any) => void} listener */
export function subscribeNativePlayerState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export class NativeMusicClient {
  /** @param {{handle: number, endpointId: string, remoteId: string, compactQueue?: boolean, requestChunks?: boolean}} connection */
  constructor(connection) {
    this.handle = connection.handle;
    this.endpointId = connection.endpointId;
    this.remoteId = connection.remoteId;
    this.compactQueue = Boolean(connection.compactQueue);
    this.native = true;
    this.info = { path_type: "unknown", address: "", received_bytes: 0 };
    /** @type {Promise<any> | null} */
    this.infoPending = null;
    this.coverUrls = new Map();
    this.coverRequests = new Map();
    this.coverActive = 0;
    this.coverQueue = /** @type {Array<() => void>} */ ([]);
    this.offlineOnly = false;
    this.nativeQueueIds = /** @type {string[]} */ ([]);
    /** @type {NativeQueueTrack[] | null} */
    this.nativeQueueSource = null;
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static async connect(options) {
    const connection = await nativeRequest("connect", options);
    requestChunksSupported = Boolean(connection.requestChunks);
    return new NativeMusicClient(connection);
  }

  /** @param {import('./types.ts').BackendRequest} request */
  async request(request) {
    return protocolResponse(await nativeRequest("request", { handle: this.handle, request }));
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

  connectionInfo() {
    if (this.infoPending) return this.infoPending;
    const request = nativeRequest("connectionInfo", { handle: this.handle })
      .then((info) => (this.info = info))
      .finally(() => {
        if (this.infoPending === request) this.infoPending = null;
      });
    this.infoPending = request;
    return request;
  }

  /** @param {boolean} offlineOnly */
  async setOfflineOnly(offlineOnly) {
    const enabled = Boolean(offlineOnly);
    await nativeRequest("setOfflineOnly", { enabled });
    this.offlineOnly = enabled;
    this.nativeQueueIds = [];
    this.nativeQueueSource = null;
  }

  async cachedTrackIds() {
    const ids = await nativeRequest("cachedTrackIds", { remoteId: this.remoteId });
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  }

  async cacheStats() {
    return nativeRequest("cacheStats");
  }

  /** @param {'tracks' | 'covers'} kind */
  async clearCache(kind) {
    if (kind !== "tracks" && kind !== "covers")
      throw new Error(`unknown offline cache kind: ${kind}`);
    if (kind === "covers") {
      await Promise.allSettled(this.coverRequests.values());
      for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
      this.coverUrls.clear();
    }
    await nativeRequest("clearCache", { kind });
  }

  /** @param {number} bytes */
  setMemoryCacheSize(bytes) {
    return nativeRequest("setMemoryCacheSize", { bytes });
  }

  /** Explicitly download a track into the persistent Android cache. */
  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async cacheTrack(id, onProgress = () => {}) {
    const result = await this.transferTrack("cacheTrack", id, onProgress);
    return Boolean(result.cached);
  }

  /** Download a track into Android's in-memory LRU without writing to disk. */
  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async prefetchTrack(id, onProgress = () => {}) {
    const result = await this.transferTrack("prefetchTrack", id, onProgress);
    return { cached: Boolean(result.cached), persistent: false };
  }

  /**
   * @param {"cacheTrack" | "prefetchTrack"} action
   * @param {string} id
   * @param {(received: number, total: number) => void} onProgress
   */
  async transferTrack(action, id, onProgress) {
    if (this.offlineOnly) throw new Error("track is not available offline");
    let polling = false;
    const reportProgress = async () => {
      if (polling) return;
      polling = true;
      try {
        const progress = await nativeRequest("cacheProgress", { trackId: id }, 5_000);
        onProgress(Number(progress.received) || 0, Number(progress.total) || 0);
      } catch {
        // The final cache request carries the authoritative success result.
      } finally {
        polling = false;
      }
    };
    await reportProgress();
    const timer = setInterval(reportProgress, NATIVE_CACHE_PROGRESS_MS);
    try {
      const result = await nativeRequest(
        action,
        { handle: this.handle, remoteId: this.remoteId, trackId: id },
        NATIVE_CACHE_TIMEOUT_MS,
      );
      await reportProgress();
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * @param {string} id
   * @param {{ fullQuality?: boolean }} [options]
   */
  async coverUrl(id, { fullQuality = false } = {}) {
    if (!id) return "";
    const key = `${id}\u0000${fullQuality ? "full" : "thumbnail"}`;
    if (this.coverUrls.has(key)) return this.coverUrls.get(key);
    if (this.offlineOnly) throw new Error("cover is not available in Android offline mode");
    if (this.coverRequests.has(key)) return this.coverRequests.get(key);
    const request = this.withCoverSlot(async () => {
      const cover = await nativeRequest("coverArt", {
        handle: this.handle,
        coverArtId: id,
        fullQuality,
      });
      const binary = atob(cover.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: cover.contentType }));
      this.coverUrls.set(key, url);
      return url;
    }).finally(() => this.coverRequests.delete(key));
    this.coverRequests.set(key, request);
    return request;
  }

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  async withCoverSlot(task) {
    if (this.coverActive >= NATIVE_COVER_CONCURRENCY)
      await new Promise((resolve) => this.coverQueue.push(() => resolve(undefined)));
    this.coverActive += 1;
    try {
      return await task();
    } finally {
      this.coverActive -= 1;
      this.coverQueue.shift()?.();
    }
  }

  /**
   * @param {NativeQueueTrack} track
   * @param {NativeQueueTrack[]} queue
   * @param {(received: number, total: number) => void} [_onProgress]
   */
  async playNative(track, queue, _onProgress = () => {}) {
    const reuseQueue = queue === this.nativeQueueSource && this.nativeQueueIds.includes(track.id);
    const nativeQueue = reuseQueue ? [] : nativeQueueWindow(track, queue);
    const queueIds = reuseQueue ? this.nativeQueueIds : nativeQueue.map(({ id }) => id);
    const queueChanged = !reuseQueue;
    const payload = {
      handle: this.handle,
      trackId: track.id,
      ...(queueChanged
        ? {
            queue: this.compactQueue
              ? queueIds
              : nativeQueue.map(({ id, title, artist, album }) => ({ id, title, artist, album })),
          }
        : {}),
    };
    try {
      const state = await nativeRequest("play", payload);
      if (queueChanged) {
        this.nativeQueueIds = queueIds;
        this.nativeQueueSource = queue;
      }
      return state;
    } catch (error) {
      if (queueChanged) throw error;
      // The Android service may have been recreated while this web client stayed alive.
      const recoveryQueue = nativeQueueWindow(track, queue);
      const recoveryQueueIds = recoveryQueue.map(({ id }) => id);
      const state = await nativeRequest("play", {
        ...payload,
        queue: this.compactQueue
          ? recoveryQueueIds
          : recoveryQueue.map(({ id, title, artist, album }) => ({ id, title, artist, album })),
      });
      this.nativeQueueIds = recoveryQueueIds;
      this.nativeQueueSource = queue;
      return state;
    }
  }

  /**
   * @param {string} command
   * @param {Record<string, any>} [payload]
   */
  playerCommand(command, payload = {}) {
    if (command === "stop") {
      this.nativeQueueIds = [];
      this.nativeQueueSource = null;
    }
    return nativeRequest("playerCommand", { command, ...payload });
  }

  /** @param {{includeQueue?: boolean}} [options] */
  playerState({ includeQueue = false } = {}) {
    return nativeRequest("playerState", { includeQueue });
  }

  async close() {
    for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
    this.coverUrls.clear();
    await nativeRequest("close", { handle: this.handle });
  }
}
