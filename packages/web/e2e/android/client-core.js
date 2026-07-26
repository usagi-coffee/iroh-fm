import { delay, fixtureCore, NativeFixtureClient, TRACK_BYTES } from "../fixtures.js";

const stateListeners = new Set();

class AndroidMusicClient extends NativeFixtureClient {
  native = true;
  nativePlayback = false;

  async bootstrap(...args) {
    if (localStorage.getItem("e2e-slow-native-startup")) await delay(1_400);
    return super.bootstrap(...args);
  }

  async connectionInfo() {
    await delay(20);
    if (localStorage.getItem("e2e-slow-native-startup")) this.receivedBytes += 128 * 1024;
    return super.connectionInfo();
  }

  async playNative(track, queue, onProgress) {
    const state = await super.playNative(track, queue, onProgress);
    const nextId = this.queue[(this.currentIndex + 1) % this.queue.length];
    if (nextId && localStorage.getItem("e2e-stale-native-state")) {
      const staleState = {
        ...this.snapshot(),
        timestamp: Date.now() - 1_000,
        trackId: nextId,
        currentIndex: (this.currentIndex + 1) % this.queue.length,
        position: 19,
      };
      setTimeout(() => {
        for (const listener of stateListeners) listener(staleState);
      }, 50);
    }
    if (nextId && nextId !== track.id) void this.prefetchNativeNext(nextId);
    return state;
  }

  async prefetchNativeNext(id) {
    this.transfers[id] = { received: 0, total: TRACK_BYTES, active: true, cached: false };
    this.notify();
    await delay(50);
    this.transfers[id] = {
      received: TRACK_BYTES / 2,
      total: TRACK_BYTES,
      active: true,
      cached: false,
    };
    this.notify();
    await delay(50);
    this.memoryCached.add(id);
    this.transfers[id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: false,
      memoryCached: true,
    };
    if (localStorage.getItem("e2e-native-memory-eviction") && this.memoryCached.size > 2) {
      this.notify();
      await delay(250);
      const evictedId = this.memoryCached.values().next().value;
      this.memoryCached.delete(evictedId);
      this.transfers[evictedId] = {
        received: 0,
        total: TRACK_BYTES,
        active: false,
        cached: false,
        memoryCached: false,
      };
      this.notify();
      return;
    }
    this.notify();
  }

  notify() {
    const state = this.snapshot();
    for (const listener of stateListeners) listener(state);
  }
}

export class ClientCore extends fixtureCore(AndroidMusicClient) {
  static memoryCacheMaxSize() {
    return 256 * 1024 * 1024;
  }

  static buildInfo() {
    return Promise.resolve({
      platform: "Android",
      commit: __BUILD_COMMIT__,
      epoch: __ANDROID_EPOCH__,
      epochCommit: __ANDROID_EPOCH_COMMIT__,
    });
  }
}

export function subscribeNativePlayerState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}
