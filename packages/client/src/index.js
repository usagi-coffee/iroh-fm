let modulePromise;
const COVER_CACHE_NAME = "iroh-fm-cover-art-v1";
const COVER_CACHE_ORIGIN = "https://cover-cache.iroh-fm.invalid";
const MAX_CONCURRENT_COVER_FETCHES = 8;
const MAX_COVER_FETCHES_DURING_AUDIO = 1;
const CONNECT_TIMEOUT_MS = 10_000;

/** @param {string} remoteId @param {string} coverId */
function coverCacheRequest(remoteId, coverId) {
  const url = new URL("/cover", COVER_CACHE_ORIGIN);
  url.searchParams.set("server", String(remoteId));
  url.searchParams.set("id", coverId);
  return new Request(url);
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
    /** @type {Array<{id: string, resolve: (value: any) => void, reject: (reason?: any) => void}>} */
    this.coverFetchQueue = [];
    this.activeCoverFetches = 0;
    this.coverFetchPaused = false;
    this.audioOpenRequests = 0;
    this.activeAudioSources = 0;
    this.closed = false;
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

  get endpointId() {
    return this.inner.endpointId;
  }

  get remoteId() {
    return this.inner.remoteId;
  }

  /** @param {unknown} request */
  async request(request) {
    return JSON.parse(await this.inner.request(JSON.stringify(request)));
  }

  async bootstrap(starredKey = "") {
    const [summary, albums, artists, tracks, starred] = await Promise.all([
      this.request("GetLibrarySummary"),
      this.request("ListAlbums"),
      this.request("ListArtists"),
      this.request("ListTracks"),
      starredKey.trim()
        ? this.request({ GetStarredWithKey: { key: starredKey.trim() } })
        : this.request("GetStarred"),
    ]);
    return { summary, albums, artists, tracks, starred };
  }

  /** @param {string} id */
  coverUrl(id) {
    let pending = this.coverCache.get(id);
    if (!pending) {
      const created = this.loadCoverUrl(id);
      this.coverCache.set(id, created);
      created.catch(() => {
        if (this.coverCache.get(id) === created) this.coverCache.delete(id);
      });
      pending = created;
    }
    return pending;
  }

  /** @param {string} id */
  async loadCoverUrl(id) {
    let cache;
    let request;
    if ("caches" in globalThis) {
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

    const media = await this.enqueueCoverFetch(id);
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

  /** @param {string} id @returns {Promise<any>} */
  enqueueCoverFetch(id) {
    if (this.closed) return Promise.reject(new Error("music client is closed"));
    return new Promise((resolve, reject) => {
      this.coverFetchQueue.push({ id, resolve, reject });
      this.drainCoverFetchQueue();
    });
  }

  drainCoverFetchQueue() {
    const concurrency = this.activeAudioSources > 0
      ? MAX_COVER_FETCHES_DURING_AUDIO
      : MAX_CONCURRENT_COVER_FETCHES;
    while (
      !this.closed &&
      !this.coverFetchPaused &&
      this.activeCoverFetches < concurrency &&
      this.coverFetchQueue.length > 0
    ) {
      const job = this.coverFetchQueue.shift();
      if (!job) return;
      this.activeCoverFetches += 1;
      Promise.resolve()
        .then(() => this.inner.fetchCover(job.id))
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

  /** @param {string} id */
  async trackSource(id) {
    this.audioOpenRequests += 1;
    this.coverFetchPaused = true;
    this.inner.prioritizeAudio();
    try {
      const media = await this.inner.openTrack(id);
      let stream;
      let contentType;
      try {
        contentType = media.contentType;
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
        if (canUseMediaSource(contentType)) {
          return new ProgressiveTrackSource(stream, contentType, releaseAudioPriority);
        }

        const blob = await new Response(stream, {
          headers: { "content-type": contentType },
        }).blob();
        return new BlobTrackSource(blob, releaseAudioPriority);
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

  async close() {
    this.closed = true;
    const closeError = new Error("music client is closed");
    for (const job of this.coverFetchQueue.splice(0)) job.reject(closeError);
    for (const pending of this.coverCache.values()) {
      pending.then(URL.revokeObjectURL).catch(() => {});
    }
    this.coverCache.clear();
    await this.inner.close();
    this.inner.free();
  }
}

class BlobTrackSource {
  /** @param {Blob} blob @param {() => void} releaseAudioPriority */
  constructor(blob, releaseAudioPriority) {
    this.url = URL.createObjectURL(blob);
    this.done = Promise.resolve();
    this.disposed = false;
    this.releaseAudioPriority = releaseAudioPriority;
  }

  async start() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAudioPriority();
    URL.revokeObjectURL(this.url);
  }
}

class ProgressiveTrackSource {
  /** @param {ReadableStream<Uint8Array>} stream @param {string} contentType @param {() => void} releaseAudioPriority */
  constructor(stream, contentType, releaseAudioPriority) {
    this.stream = stream;
    this.contentType = contentType;
    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    this.reader = stream.getReader();
    this.done = Promise.resolve();
    this.disposed = false;
    this.releaseAudioPriority = releaseAudioPriority;
    /** @type {null | (() => void)} */
    this.cancelOpen = null;
  }

  async start() {
    if (this.disposed) throw new DOMException("Track was cancelled", "AbortError");
    await this.waitUntilOpen();
    if (this.disposed) throw new DOMException("Track was cancelled", "AbortError");

    const sourceBuffer = this.mediaSource.addSourceBuffer(this.contentType);
    const first = await this.reader.read();
    if (first.done) {
      this.finishMediaSource();
      return;
    }
    await appendBuffer(sourceBuffer, first.value);
    this.done = this.pump(sourceBuffer);
  }

  /** @param {SourceBuffer} sourceBuffer */
  async pump(sourceBuffer) {
    try {
      while (!this.disposed) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        await appendBuffer(sourceBuffer, chunk.value);
      }
      if (!this.disposed) this.finishMediaSource();
    } catch (error) {
      if (!this.disposed) throw error;
    }
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
    this.finishMediaSource();
    URL.revokeObjectURL(this.url);
  }
}

/** @param {string} contentType */
function canUseMediaSource(contentType) {
  return (
    typeof MediaSource !== "undefined" &&
    contentType.split(";", 1)[0].trim().toLowerCase() === "audio/mpeg" &&
    MediaSource.isTypeSupported(contentType)
  );
}

/** @param {SourceBuffer} sourceBuffer @param {Uint8Array} chunk @returns {Promise<void>} */
function appendBuffer(sourceBuffer, chunk) {
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
      sourceBuffer.appendBuffer(/** @type {BufferSource} */ (chunk));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
