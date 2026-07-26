import { MusicClient } from "./index.js";

const STREAM_CHUNK_BYTES = 1024 * 1024;
const STREAM_READ_AHEAD_CHUNKS = 4;

export function isDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * @param {string} command
 * @param {Record<string, any>} [payload]
 * @returns {Promise<any>}
 */
async function invoke(command, payload = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload);
}

/** @param {unknown} value */
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(/** @type {ArrayLike<number>} */ (value));
}

/** @param {number} streamHandle */
function readableNativeStream(streamHandle) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void invoke("desktop_close_stream", { streamHandle }).catch(() => {});
  };
  return new ReadableStream(
    {
      async pull(controller) {
        if (closed) return;
        try {
          const chunk = bytes(
            await invoke("desktop_read_stream", {
              streamHandle,
              length: STREAM_CHUNK_BYTES,
            }),
          );
          if (chunk.byteLength === 0) {
            closed = true;
            controller.close();
          } else controller.enqueue(chunk);
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    },
    // Keep native Iroh reads running ahead of MediaSource so a path probe or a
    // short IPC/network pause does not immediately underrun audio playback.
    { highWaterMark: STREAM_READ_AHEAD_CHUNKS },
  );
}

class DesktopInner {
  /** @param {{handle: number, endpointId: string, remoteId: string}} connection */
  constructor(connection) {
    this.handle = connection.handle;
    this.endpointId = connection.endpointId;
    this.remoteId = connection.remoteId;
    this.native = true;
    this.nativePlayback = true;
    this.info = { path_type: "unknown", address: "", received_bytes: 0 };
    this.infoPending = false;
    this.closed = false;
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static async connect(options) {
    return new DesktopInner(await invoke("desktop_connect", { options }));
  }

  /** Matches the WASM client's JSON boundary so MusicClient stays host-agnostic. @param {string} raw */
  async request(raw) {
    const response = await invoke("desktop_request", {
      handle: this.handle,
      request: JSON.parse(raw),
    });
    return JSON.stringify(response);
  }

  connectionInfo() {
    if (!this.infoPending && !this.closed) {
      this.infoPending = true;
      void invoke("desktop_connection_info", { handle: this.handle })
        .then((info) => (this.info = info))
        .catch(() => {})
        .finally(() => (this.infoPending = false));
    }
    return JSON.stringify(this.info);
  }

  /**
   * @param {string} id
   * @param {boolean} fullQuality
   */
  async fetchCover(id, fullQuality) {
    const data = bytes(
      await invoke("desktop_cover_art", {
        handle: this.handle,
        coverArtId: id,
        fullQuality,
      }),
    );
    if (data.byteLength < 3) throw new Error("desktop cover response is incomplete");
    const contentTypeLength = (data[0] << 8) | data[1];
    const imageOffset = 2 + contentTypeLength;
    if (imageOffset >= data.byteLength) throw new Error("desktop cover response is invalid");
    return {
      contentType: new TextDecoder().decode(data.subarray(2, imageOffset)),
      bytes: data.subarray(imageOffset),
      free() {},
    };
  }

  prioritizeAudio() {}

  /** @param {string} id */
  async openTrack(id) {
    const opened = await invoke("desktop_open_stream", {
      handle: this.handle,
      trackId: id,
    });
    const stream = readableNativeStream(opened.handle);
    return {
      contentType: opened.contentType,
      fileSize: opened.fileSize,
      takeStream() {
        return stream;
      },
      free() {},
    };
  }

  /**
   * @param {{id: string}} track
   * @param {Array<{id: string}>} queue
   */
  playNative(track, queue) {
    return invoke("desktop_play", {
      handle: this.handle,
      trackId: track.id,
      queue: queue.map(({ id }) => id),
    });
  }

  /**
   * @param {string} command
   * @param {Record<string, any>} [payload]
   */
  playerCommand(command, payload = {}) {
    return invoke("desktop_player_command", { handle: this.handle, command, payload });
  }

  /** @param {{includeQueue?: boolean}} [options] */
  playerState({ includeQueue = false } = {}) {
    return invoke("desktop_player_state", { handle: this.handle, includeQueue });
  }

  async cachedTrackIds() {
    return new Set(await invoke("desktop_cached_track_ids", { handle: this.handle }));
  }

  /** Explicitly download a track into the persistent Desktop cache. */
  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  async cacheTrack(id, onProgress = () => {}) {
    let polling = false;
    const report = async () => {
      if (polling) return;
      polling = true;
      try {
        const progress = await invoke("desktop_cache_progress", { trackId: id });
        onProgress(Number(progress.received) || 0, Number(progress.total) || 0);
      } finally {
        polling = false;
      }
    };
    await report();
    const timer = setInterval(report, 200);
    try {
      const result = await invoke("desktop_cache_track", { handle: this.handle, trackId: id });
      await report();
      return Boolean(result.cached);
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * @param {string} id
   * @param {(received: number, total: number) => void} [onProgress]
   */
  prefetchTrack(id, onProgress = () => {}) {
    return this.cacheTrack(id, onProgress);
  }

  /** @param {boolean} enabled */
  setOfflineOnly(enabled) {
    return invoke("desktop_set_offline_only", { enabled: Boolean(enabled) });
  }

  cacheStats() {
    return invoke("desktop_cache_stats", { handle: this.handle });
  }

  /** @param {'tracks' | 'covers'} kind */
  clearCache(kind) {
    return invoke("desktop_clear_cache", { handle: this.handle, kind });
  }

  /** @param {number} bytes */
  setMemoryCacheSize(bytes) {
    return invoke("desktop_set_memory_cache_size", { handle: this.handle, bytes });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await invoke("desktop_close", { handle: this.handle });
  }

  free() {}
}

/** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
export async function connectDesktop(options) {
  return new MusicClient(await DesktopInner.connect(options));
}

/** @param {string} ticket */
export function parseDesktopTicket(ticket) {
  return invoke("desktop_parse_ticket", { ticket });
}

export function generateDesktopIdentity() {
  return invoke("desktop_generate_identity");
}

/** @param {string} secret */
export function desktopEndpointIdForSecret(secret) {
  return invoke("desktop_endpoint_id_for_secret", { secret });
}

export function desktopBuildInfo() {
  return invoke("desktop_build_info");
}
