import { delay, FixtureClient, fixtureCore, silentWav } from "../fixtures.js";

class WebMusicClient extends FixtureClient {
  native = false;
  nativePlayback = false;

  async exportTrackBlob(id, onProgress = () => {}, { maxBytes = 512 * 1024 * 1024 } = {}) {
    const blob = silentWav();
    if (blob.size > maxBytes) throw new Error("Original audio is too large to export.");
    onProgress(0, blob.size);
    await delay(Number(localStorage.getItem("iroh-fm-e2e-export-delay")) || 0);
    const error = localStorage.getItem("iroh-fm-e2e-export-error");
    if (error) throw new Error(error);
    onProgress(blob.size, blob.size);
    return blob;
  }

  async trackSource(id, onProgress = () => {}) {
    const blob = silentWav();
    this.receivedBytes += blob.size;
    onProgress(blob.size, blob.size);
    let disposed = false;
    const url = URL.createObjectURL(blob);
    const done = delay(80).then(() => {
      if (disposed) return false;
      this.memoryCached.add(id);
      return "memory";
    });
    return {
      url,
      done,
      disposed,
      async start() {},
      dispose() {
        disposed = true;
        this.disposed = true;
        URL.revokeObjectURL(url);
      },
    };
  }
}

export const ClientCore = fixtureCore(WebMusicClient);

export function subscribeNativePlayerState() {
  return () => {};
}
