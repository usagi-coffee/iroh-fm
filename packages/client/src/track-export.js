/** Maximum original audio size accepted by the Blob export API. */
export const MAX_EXPORT_TRACK_BYTES = 512 * 1024 * 1024;

/** @param {{maxBytes?: number}} [options] */
export function exportMaxBytes({ maxBytes = MAX_EXPORT_TRACK_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_EXPORT_TRACK_BYTES)
    throw new Error("invalid track export size limit");
  return maxBytes;
}

/** @param {number} size @param {number} [maxBytes] */
export function validateTrackSize(size, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("invalid original track size");
  if (size > maxBytes) throw new Error("original track exceeds export size limit");
}

/**
 * Only successful, exact-length transfers may become complete cached originals.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} total
 * @param {(received: number, total: number) => void} onProgress
 * @param {number} [maxBytes]
 */
export function trackDownload(stream, total, onProgress, maxBytes = Number.MAX_SAFE_INTEGER) {
  const reader = stream.getReader();
  let received = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        validateTrackSize(total, maxBytes);
        const chunk = await reader.read();
        if (chunk.done) {
          if (received !== total) throw new Error("original track transfer is truncated");
          onProgress(received, total);
          reader.releaseLock();
          controller.close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > total || received > maxBytes)
          throw new Error("original track transfer exceeds declared size");
        onProgress(received, total);
        controller.enqueue(chunk.value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}
