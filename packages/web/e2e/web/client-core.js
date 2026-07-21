import { delay, FixtureClient, fixtureCore, silentWav } from "../fixtures.js";

class WebMusicClient extends FixtureClient {
  native = false;
  nativePlayback = false;

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
