import { delay, fixtureCore, NativeFixtureClient, TRACK_BYTES } from "../fixtures.js";

const stateListeners = new Set();

class AndroidMusicClient extends NativeFixtureClient {
  native = true;

  async playNative(track, queue, onProgress) {
    const state = await super.playNative(track, queue, onProgress);
    const nextId = this.queue[(this.currentIndex + 1) % this.queue.length];
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
    this.cached.add(id);
    this.transfers[id] = {
      received: TRACK_BYTES,
      total: TRACK_BYTES,
      active: false,
      cached: true,
    };
    this.notify();
  }

  notify() {
    const state = this.snapshot();
    for (const listener of stateListeners) listener(state);
  }
}

export const ClientCore = fixtureCore(AndroidMusicClient);

export function subscribeNativePlayerState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}
