import { MusicClient } from "./index.js";

const STREAM_CHUNK_BYTES = 1024 * 1024;
const STREAM_READ_AHEAD_CHUNKS = 4;

export function isDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** @param {string} command @param {Record<string, any>} [payload] @returns {Promise<any>} */
async function invoke(command, payload = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload);
}

/** @param {string} command @param {Uint8Array} payload @param {Record<string, string>} headers */
async function invokeRaw(command, payload, headers) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload, { headers });
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
    this.nativePlayback = true;
    // WebKitGTK advertises MP3 MediaSource support, but incremental appends can
    // repeatedly underrun its GStreamer pipeline. Download into a Blob first;
    // the normal web cache and next-track prefetch still apply afterwards.
    this.supportsProgressivePlayback = false;
    this.info = { path_type: "unknown", address: "", received_bytes: 0 };
    this.infoPending = false;
    this.closed = false;
    /** @type {string[]} */
    this.nativeQueueIds = [];
    this.nativeGeneration = 0;
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

  /** @param {string} id @param {boolean} fullQuality */
  async fetchCover(id, fullQuality) {
    const cover = await invoke("desktop_cover_art", {
      handle: this.handle,
      coverArtId: id,
      fullQuality,
    });
    const binary = atob(cover.bytesBase64);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    return {
      contentType: cover.contentType,
      bytes: data,
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

  /** @param {{id: string}} track @param {Array<{id: string}>} queue @param {Uint8Array} data */
  async playNativeBytes(track, queue, data) {
    const prepared = await invoke("desktop_prepare_play", {
      handle: this.handle,
      trackId: track.id,
      queue: queue.map(({ id }) => id),
    });
    this.nativeQueueIds = queue.map(({ id }) => id);
    this.nativeGeneration = prepared.generation;
    return invokeRaw("desktop_play_uploaded", data, {
      "x-iroh-handle": String(this.handle),
      "x-iroh-generation": String(prepared.generation),
      "x-iroh-index": String(prepared.selected),
    });
  }

  /** @param {string} trackId @param {Uint8Array} data */
  queueNativeBytes(trackId, data) {
    const index = this.nativeQueueIds.indexOf(trackId);
    if (index < 0) return Promise.resolve(false);
    return invokeRaw("desktop_queue_uploaded", data, {
      "x-iroh-handle": String(this.handle),
      "x-iroh-generation": String(this.nativeGeneration),
      "x-iroh-index": String(index),
    });
  }

  /** @param {string} command @param {Record<string, any>} [payload] */
  playerCommand(command, payload = {}) {
    return invoke("desktop_player_command", { handle: this.handle, command, payload });
  }

  playerState() {
    return invoke("desktop_player_state", { handle: this.handle });
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
