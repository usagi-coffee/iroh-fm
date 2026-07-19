const NATIVE_TIMEOUT_MS = 30_000;
const NATIVE_CACHE_TIMEOUT_MS = 60 * 60 * 1_000;
const NATIVE_CACHE_PROGRESS_MS = 250;
const NATIVE_COVER_CONCURRENCY = 3;
const NATIVE_REQUEST_CHUNK_CHARS = 24 * 1024;
/** @type {MessagePort | undefined} */
let port;
let nativeExpected = false;
/** @type {Promise<boolean> | undefined} */
let detection;
let sequence = 0;
let requestChunksSupported = false;
/** @type {Map<string, {resolve: (value: any) => void, reject: (reason?: any) => void, timer: ReturnType<typeof setTimeout>}>} */
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
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
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

/** @param {string} action @param {Record<string, any>} [payload] @param {number} [timeout] */
export function nativeRequest(action, payload = {}, timeout = NATIVE_TIMEOUT_MS) {
  const target = port;
  if (!target) return Promise.reject(new Error("Android native bridge is unavailable"));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native ${action} request timed out`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      const raw = JSON.stringify({ module: "native", id, action, payload });
      if (!requestChunksSupported || raw.length <= NATIVE_REQUEST_CHUNK_CHARS) {
        target.postMessage(raw);
        return;
      }
      const total = Math.ceil(raw.length / NATIVE_REQUEST_CHUNK_CHARS);
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
    this.infoPending = false;
    this.coverUrls = new Map();
    this.coverRequests = new Map();
    this.coverActive = 0;
    this.coverQueue = /** @type {Array<() => void>} */ ([]);
    this.offlineOnly = false;
    this.nativeQueueIds = /** @type {string[]} */ ([]);
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static async connect(options) {
    const connection = await nativeRequest("connect", options);
    requestChunksSupported = Boolean(connection.requestChunks);
    return new NativeMusicClient(connection);
  }

  /** @param {any} request */
  async request(request) {
    return nativeRequest("request", { handle: this.handle, request });
  }

  async bootstrap(starredKey = "") {
    const [summary, albums, artists, tracks, starred] = await Promise.all([
      this.request("GetLibrarySummary"),
      this.request("ListAlbums"),
      this.request("ListArtists"),
      this.request("ListTracks"),
      this.request(
        starredKey.trim() ? { GetStarredWithKey: { key: starredKey.trim() } } : "GetStarred",
      ),
    ]);
    return { summary, albums, artists, tracks, starred };
  }

  connectionInfo() {
    if (!this.infoPending) {
      this.infoPending = true;
      void nativeRequest("connectionInfo", { handle: this.handle })
        .then((info) => (this.info = info))
        .catch(() => {})
        .finally(() => (this.infoPending = false));
    }
    return this.info;
  }

  /** @param {boolean} offlineOnly */
  setOfflineOnly(offlineOnly) {
    this.offlineOnly = Boolean(offlineOnly);
    void nativeRequest("setOfflineOnly", { enabled: this.offlineOnly }).catch(() => {});
  }

  async cachedTrackIds() {
    const ids = await nativeRequest("cachedTrackIds", { remoteId: this.remoteId });
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  }

  async cacheStats() {
    return nativeRequest("cacheStats");
  }

  /** @param {string} id @param {(received: number, total: number) => void} [onProgress] */
  async prefetchTrack(id, onProgress = () => {}) {
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
        "cacheTrack",
        { handle: this.handle, remoteId: this.remoteId, trackId: id },
        NATIVE_CACHE_TIMEOUT_MS,
      );
      await reportProgress();
      return Boolean(result.cached);
    } finally {
      clearInterval(timer);
    }
  }

  /** @param {string} id */
  async coverUrl(id) {
    if (!id) return "";
    if (this.coverUrls.has(id)) return this.coverUrls.get(id);
    if (this.coverRequests.has(id)) return this.coverRequests.get(id);
    const request = this.withCoverSlot(async () => {
      const cover = await nativeRequest("coverArt", { handle: this.handle, coverArtId: id });
      const binary = atob(cover.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: cover.contentType }));
      this.coverUrls.set(id, url);
      return url;
    }).finally(() => this.coverRequests.delete(id));
    this.coverRequests.set(id, request);
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

  /** @param {{id: string}} track @param {Array<{id: string, title: string, artist: string, album: string}>} queue */
  async playNative(track, queue) {
    const queueIds = queue.map(({ id }) => id);
    const queueChanged =
      queueIds.length !== this.nativeQueueIds.length ||
      queueIds.some((id, index) => id !== this.nativeQueueIds[index]);
    const payload = {
      handle: this.handle,
      trackId: track.id,
      ...(queueChanged
        ? {
            queue: this.compactQueue
              ? queueIds
              : queue.map(({ id, title, artist, album }) => ({ id, title, artist, album })),
          }
        : {}),
    };
    try {
      const state = await nativeRequest("play", payload);
      if (queueChanged) this.nativeQueueIds = queueIds;
      return state;
    } catch (error) {
      if (queueChanged) throw error;
      // The Android service may have been recreated while this web client stayed alive.
      const state = await nativeRequest("play", {
        ...payload,
        queue: this.compactQueue
          ? queueIds
          : queue.map(({ id, title, artist, album }) => ({ id, title, artist, album })),
      });
      this.nativeQueueIds = queueIds;
      return state;
    }
  }

  /** @param {string} command @param {Record<string, any>} [payload] */
  playerCommand(command, payload = {}) {
    if (command === "stop") this.nativeQueueIds = [];
    return nativeRequest("playerCommand", { command, ...payload });
  }

  playerState() {
    return nativeRequest("playerState");
  }

  async close() {
    for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
    this.coverUrls.clear();
    await nativeRequest("close", { handle: this.handle });
  }
}
