const NATIVE_TIMEOUT_MS = 30_000;
const NATIVE_COVER_CONCURRENCY = 3;
/** @type {MessagePort | undefined} */
let port;
let nativeExpected = false;
/** @type {Promise<boolean> | undefined} */
let detection;
let sequence = 0;
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
    target.postMessage(JSON.stringify({ module: "native", id, action, payload }));
  });
}

/** @param {(state: any) => void} listener */
export function subscribeNativePlayerState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export class NativeMusicClient {
  /** @param {{handle: number, endpointId: string, remoteId: string}} connection */
  constructor(connection) {
    this.handle = connection.handle;
    this.endpointId = connection.endpointId;
    this.remoteId = connection.remoteId;
    this.native = true;
    this.info = { path_type: "unknown", address: "", received_bytes: 0 };
    this.infoPending = false;
    this.coverUrls = new Map();
    this.coverRequests = new Map();
    this.coverActive = 0;
    this.coverQueue = /** @type {Array<() => void>} */ ([]);
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static async connect(options) {
    return new NativeMusicClient(await nativeRequest("connect", options));
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

  setOfflineOnly() {}
  async cachedTrackIds() {
    return new Set();
  }
  async cacheStats() {
    return { tracks: { count: 0, size: 0 }, covers: { count: 0, size: 0 } };
  }
  async prefetchTrack() {
    return false;
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
  playNative(track, queue) {
    return nativeRequest("play", {
      handle: this.handle,
      trackId: track.id,
      queue: queue.map(({ id, title, artist, album }) => ({ id, title, artist, album })),
    });
  }

  /** @param {string} command @param {Record<string, any>} [payload] */
  playerCommand(command, payload = {}) {
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
