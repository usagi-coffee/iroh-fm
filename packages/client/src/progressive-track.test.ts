import { afterEach, describe, expect, test } from "bun:test";
import { MusicClient } from "./index.js";

class FakeSourceBuffer extends EventTarget {
  buffered = { length: 0 };
  appended: Uint8Array[] = [];
  fail = false;

  appendBuffer(chunk: Uint8Array) {
    if (this.fail) throw new Error("append failed");
    this.appended.push(chunk);
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  readyState = "open";
  buffer = new FakeSourceBuffer();
  endings: (string | undefined)[] = [];

  addSourceBuffer() {
    return this.buffer;
  }
  endOfStream(error?: string) {
    this.endings.push(error);
    this.readyState = "ended";
  }
}

const savedMediaSource = Object.getOwnPropertyDescriptor(globalThis, "MediaSource");
const savedCreateURL = URL.createObjectURL;
const savedRevokeURL = URL.revokeObjectURL;
afterEach(() => {
  if (savedMediaSource) Object.defineProperty(globalThis, "MediaSource", savedMediaSource);
  else Reflect.deleteProperty(globalThis, "MediaSource");
  URL.createObjectURL = savedCreateURL;
  URL.revokeObjectURL = savedRevokeURL;
});

async function fixture({
  size = 8,
  chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7, 8])],
  failAt = -1,
  appendFail = false,
  progressFailAt = -1,
}: {
  size?: number;
  chunks?: Uint8Array[];
  failAt?: number;
  appendFail?: boolean;
  progressFailAt?: number;
} = {}) {
  Object.defineProperty(globalThis, "MediaSource", {
    configurable: true,
    value: FakeMediaSource,
  });
  const calls = { cancelled: 0, free: 0, revoked: [] as string[] };
  URL.createObjectURL = () => "blob:progressive-test";
  URL.revokeObjectURL = (url) => calls.revoked.push(url);
  const progress: number[][] = [];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === failAt) controller.error(new Error("transport failed"));
        else if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel() {
        calls.cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
  const client = new MusicClient({
    remoteId: "progressive-server",
    prioritizeAudio() {},
    async openTrack() {
      return {
        fileSize: size,
        contentType: "audio/mpeg",
        takeStream: () => stream,
        free() {
          calls.free += 1;
        },
      };
    },
  });
  const source = await client.trackSource("track", (received, total) => {
    if (received === progressFailAt) throw new Error("progress failed");
    progress.push([received, total]);
  });
  const mediaSource = source.mediaSource as FakeMediaSource;
  mediaSource.buffer.fail = appendFail;
  const mediaElement = Object.assign(new EventTarget(), { currentTime: 0 });
  return { client, source, mediaSource, mediaElement, calls, progress, stream };
}

function expectFailed(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.progress.some(([received, total]) => received === total)).toBe(false);
  expect(f.client.memoryTrackCache.get("track")).toBeNull();
  expect(f.client.activeAudioSources).toBe(0);
  expect(f.client.audioOpenRequests).toBe(0);
  expect(f.client.coverFetchPaused).toBe(false);
  expect(f.mediaSource.readyState).toBe("ended");
  expect(f.mediaSource.endings).toEqual(["network"]);
  expect(f.source.chunks).toEqual([]);
  expect(f.stream.locked).toBe(false);
  // Keep the attached URL and error visible to the player until it disposes.
  expect(f.source.disposed).toBe(false);
  f.source.dispose();
  f.source.dispose();
  expect(f.client.activeAudioSources).toBe(0);
  expect(f.calls.revoked).toEqual(["blob:progressive-test"]);
}

describe("progressive track transfers", () => {
  test("truncated EOF rejects without false completion and finalizes playback", async () => {
    const f = await fixture({ chunks: [new Uint8Array([1, 2, 3])] });
    await f.source.start(f.mediaElement);
    await expect(f.source.done).rejects.toThrow("incomplete");
    expect(f.progress).toEqual([[0, 8], [3, 8]]);
    expectFailed(f);
  });

  test("empty first read rejects and finalizes the source", async () => {
    const f = await fixture({ chunks: [] });
    await expect(f.source.start(f.mediaElement)).rejects.toThrow("incomplete");
    expectFailed(f);
  });

  for (const chunks of [
    [new Uint8Array(9)],
    [new Uint8Array(3), new Uint8Array(6)],
    [new Uint8Array(8), new Uint8Array(1)],
  ]) {
    test(`overrun after ${chunks[0].length} bytes is rejected before accumulation or append`, async () => {
      const f = await fixture({ chunks });
      if (chunks[0].length > 8) {
        await expect(f.source.start(f.mediaElement)).rejects.toThrow("exceeds declared size");
        expect(f.mediaSource.buffer.appended).toEqual([]);
      } else {
        await f.source.start(f.mediaElement);
        await expect(f.source.done).rejects.toThrow("exceeds declared size");
        expect(f.mediaSource.buffer.appended).toEqual([chunks[0]]);
      }
      expect(f.calls.cancelled).toBe(1);
      expectFailed(f);
    });
  }

  for (const failAt of [0, 1, 2]) {
    test(`transport failure at chunk ${failAt} finalizes without claiming completion`, async () => {
      const f = await fixture({ failAt });
      if (failAt === 0) {
        await expect(f.source.start(f.mediaElement)).rejects.toThrow("transport failed");
      } else {
        await f.source.start(f.mediaElement);
        await expect(f.source.done).rejects.toThrow("transport failed");
      }
      expectFailed(f);
    });
  }

  test("append failure cancels the reader and releases audio priority", async () => {
    const f = await fixture({ appendFail: true });
    await expect(f.source.start(f.mediaElement)).rejects.toThrow("append failed");
    expect(f.calls.cancelled).toBe(1);
    expectFailed(f);
  });

  test("progress callback failure cannot strand an active source", async () => {
    const f = await fixture({ progressFailAt: 3 });
    await expect(f.source.start(f.mediaElement)).rejects.toThrow("progress failed");
    expect(f.calls.cancelled).toBe(1);
    expectFailed(f);
  });

  test("zero declared length is not a successful empty transfer", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const client = new MusicClient({
      remoteId: "progressive-server",
      prioritizeAudio() {},
      async openTrack() {
        return {
          fileSize: 0,
          contentType: "audio/mpeg",
          takeStream: () => stream,
          free() {},
        };
      },
    });
    const progress: number[][] = [];
    await expect(
      client.trackSource("track", (received, total) => progress.push([received, total])),
    ).rejects.toThrow("invalid original track size");
    expect(progress).toEqual([]);
    expect(cancelled).toBe(true);
    expect(client.activeAudioSources).toBe(0);
    expect(client.audioOpenRequests).toBe(0);
  });

  for (const chunks of [
    [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7, 8])],
    [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
  ]) {
    test(`successful ${chunks.length}-chunk transfer retains playback until explicit disposal`, async () => {
      const f = await fixture({ chunks });
      await f.source.start(f.mediaElement);
      expect(await f.source.done).toBe("memory");
      const blob = f.client.memoryTrackCache.get("track");
      expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      );
      expect(blob!.type).toBe("audio/mpeg");
      expect(f.progress.filter(([received, total]) => received === total)).toEqual([[8, 8]]);
      expect(f.mediaSource.endings).toEqual([undefined]);
      expect(f.source.disposed).toBe(false);
      expect(f.client.activeAudioSources).toBe(1);
      expect(f.calls.revoked).toEqual([]);
      expect(f.stream.locked).toBe(false);
      f.source.dispose();
      f.source.dispose();
      expect(f.client.activeAudioSources).toBe(0);
      expect(f.calls.revoked).toEqual(["blob:progressive-test"]);
    });
  }
});
