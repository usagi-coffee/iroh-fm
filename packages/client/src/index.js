let modulePromise;

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
  }

  /** @param {string} ticket */
  static async connect(ticket) {
    const { IrohFmClient } = await loadWasm();
    return new MusicClient(await IrohFmClient.connect(ticket));
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

  async bootstrap() {
    const [summary, albums, artists, starred] = await Promise.all([
      this.request("GetLibrarySummary"),
      this.request("ListAlbums"),
      this.request("ListArtists"),
      this.request("GetStarred"),
    ]);
    return { summary, albums, artists, starred };
  }

  /** @param {string} id */
  coverUrl(id) {
    let pending = this.coverCache.get(id);
    if (!pending) {
      const created = this.inner.fetchCover(id).then((/** @type {any} */ media) => {
        try {
          return URL.createObjectURL(new Blob([media.bytes], { type: media.contentType }));
        } finally {
          media.free();
        }
      });
      this.coverCache.set(id, created);
      pending = created;
    }
    return pending;
  }

  /** @param {string} id */
  async trackSource(id) {
    const media = await this.inner.openTrack(id);
    let stream;
    let contentType;
    try {
      contentType = media.contentType;
      stream = media.takeStream();
    } finally {
      media.free();
    }

    if (canUseMediaSource(contentType)) {
      return new ProgressiveTrackSource(stream, contentType);
    }

    const blob = await new Response(stream, {
      headers: { "content-type": contentType },
    }).blob();
    return new BlobTrackSource(blob);
  }

  async close() {
    for (const pending of this.coverCache.values()) {
      pending.then(URL.revokeObjectURL).catch(() => {});
    }
    this.coverCache.clear();
    await this.inner.close();
    this.inner.free();
  }
}

class BlobTrackSource {
  /** @param {Blob} blob */
  constructor(blob) {
    this.url = URL.createObjectURL(blob);
    this.done = Promise.resolve();
    this.disposed = false;
  }

  async start() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    URL.revokeObjectURL(this.url);
  }
}

class ProgressiveTrackSource {
  /** @param {ReadableStream<Uint8Array>} stream @param {string} contentType */
  constructor(stream, contentType) {
    this.stream = stream;
    this.contentType = contentType;
    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    this.reader = stream.getReader();
    this.done = Promise.resolve();
    this.disposed = false;
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
