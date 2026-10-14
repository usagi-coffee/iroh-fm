import { MusicClient } from "./index.js";
import { NativeMusicClient } from "./native.js";
import { MAX_EXPORT_TRACK_BYTES } from "./track-export.js";

import { afterEach, describe, expect, test } from "bun:test";

const original = new Uint8Array([73, 68, 51, 0, 1, 255, 17, 42]);
const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
afterEach(() => {
  if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

function fixture({
  size = original.length,
  chunks = [original.subarray(0, 3), original.subarray(3)],
  fail = false,
  native = false,
  cachedIds = new Set<string>(),
}: {
  size?: number;
  chunks?: Uint8Array[];
  fail?: boolean;
  native?: boolean;
  cachedIds?: Set<string>;
} = {}) {
  const calls = { open: [] as string[], cancelled: 0, free: 0, playback: 0 };
  const client = new MusicClient({
    remoteId: "server-a",
    native,
    prioritizeAudio() {},
    async cachedTrackIds() {
      return cachedIds;
    },
    playNative() {
      calls.playback += 1;
      throw new Error("export must not play");
    },
    async openTrack(id: string) {
      calls.open.push(id);
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else if (fail) controller.error(new Error("transport failed"));
          else controller.close();
        },
        cancel() {
          calls.cancelled += 1;
        },
      });
      return {
        fileSize: size,
        contentType: "audio/flac",
        takeStream() {
          return stream;
        },
        free() {
          calls.free += 1;
        },
      };
    },
  });
  return { client, calls };
}

function diskCache(response: Response) {
  let deleted = 0;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      async open() {
        return {
          async match(request: Request) {
            expect(new URL(request.url).searchParams.get("server")).toBe("server-a");
            return response;
          },
          async delete() {
            deleted += 1;
            return true;
          },
        };
      },
    },
  });
  return { deleted: () => deleted };
}

async function bytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("complete original track exports", () => {
  test("network exports retain every original byte, MIME type and byte progress without playback", async () => {
    const { client, calls } = fixture();
    const progress: number[][] = [];
    const blob = await client.exportTrackBlob("track-a", (received, total) => {
      progress.push([received, total]);
    });
    expect(await bytes(blob)).toEqual(original);
    expect(blob.type).toBe("audio/flac");
    expect(progress).toEqual([
      [0, 8],
      [3, 8],
      [8, 8],
      [8, 8],
    ]);
    expect(calls.open).toEqual(["track-a"]);
    expect(calls.free).toBe(1);
    expect(calls.playback).toBe(0);
    expect(client.activeAudioSources).toBe(0);
    expect(client.audioOpenRequests).toBe(0);
    expect(client.activeTrackRequests.size).toBe(0);
    expect(client.memoryTrackCache.get("track-a")).toBeNull();
  });

  test("complete in-memory originals export offline without a transport or playback call", async () => {
    const { client, calls } = fixture();
    const cached = new Blob([original], { type: "audio/mpeg" });
    await client.rememberTrackBlob("track-a", cached);
    client.setOfflineOnly(true);
    const progress: number[][] = [];
    expect(await client.exportTrackBlob("track-a", (r, t) => progress.push([r, t]))).toBe(cached);
    expect(progress).toEqual([[8, 8]]);
    expect(calls.open).toEqual([]);
    expect(calls.playback).toBe(0);
  });

  test("complete persistent originals export offline with validated length", async () => {
    const { client, calls } = fixture();
    diskCache(
      new Response(original, {
        headers: { "content-length": "8", "content-type": "audio/ogg" },
      }),
    );
    client.setOfflineOnly(true);
    const blob = await client.exportTrackBlob("track-a");
    expect(await bytes(blob)).toEqual(original);
    expect(blob.type).toBe("audio/ogg");
    expect(calls.open).toEqual([]);
  });

  test("offline misses never open a network track", async () => {
    const { client, calls } = fixture();
    client.setOfflineOnly(true);
    await expect(client.exportTrackBlob("track-a")).rejects.toThrow("not available offline");
    expect(calls.open).toEqual([]);
  });

  test("Desktop native playback cache cannot bypass the offline export guard", async () => {
    const { client, calls } = fixture({ native: true, cachedIds: new Set(["track-a"]) });
    client.setOfflineOnly(true);
    await expect(client.exportTrackBlob("track-a")).rejects.toThrow("not available offline");
    expect(calls.open).toEqual([]);
    expect(calls.playback).toBe(0);
    await expect(client.exportTrackBlob("missing")).rejects.toThrow("not available offline");
    expect(calls.open).toEqual([]);
  });

  for (const [name, response] of [
    [
      "truncated",
      () => new Response(original.subarray(0, 3), { headers: { "content-length": "8" } }),
    ],
    ["overlong", () => new Response(original, { headers: { "content-length": "3" } })],
    ["unvalidated", () => new Response(original)],
    ["partial", () => new Response(original, { status: 206, headers: { "content-length": "8" } })],
    [
      "range",
      () =>
        new Response(original, {
          headers: { "content-length": "8", "content-range": "bytes 0-7/20" },
        }),
    ],
  ] as const) {
    test(`${name} persistent cache is evicted, not exported offline`, async () => {
      const { client, calls } = fixture();
      const cache = diskCache(response());
      client.setOfflineOnly(true);
      await expect(client.exportTrackBlob("track-a")).rejects.toThrow("not available offline");
      expect(cache.deleted()).toBe(1);
      expect(calls.open).toEqual([]);
    });
  }

  test("invalid persistent cache falls back to the complete original network stream online", async () => {
    const { client, calls } = fixture();
    const cache = diskCache(
      new Response(original.subarray(0, 3), {
        headers: { "content-length": "8" },
      }),
    );
    expect(await bytes(await client.exportTrackBlob("track-a"))).toEqual(original);
    expect(cache.deleted()).toBe(1);
    expect(calls.open).toEqual(["track-a"]);
  });

  test("truncated network audio rejects instead of completing progress or caching partial bytes", async () => {
    const { client } = fixture({ chunks: [original.subarray(0, 3)] });
    const progress: number[][] = [];
    await expect(
      client.exportTrackBlob("track-a", (r, t) => progress.push([r, t])),
    ).rejects.toThrow("truncated");
    expect(progress).toEqual([
      [0, 8],
      [3, 8],
    ]);
    expect(client.memoryTrackCache.get("track-a")).toBeNull();
    expect(client.activeAudioSources).toBe(0);
  });

  test("overlong streams are cancelled and rejected before their excess chunk enters the Blob", async () => {
    const { client, calls } = fixture({ size: 2, chunks: [original, original] });
    const progress: number[][] = [];
    await expect(
      client.exportTrackBlob("track-a", (r, t) => progress.push([r, t])),
    ).rejects.toThrow("exceeds declared size");
    expect(calls.cancelled).toBe(1);
    expect(progress).toEqual([[0, 2]]);
  });

  test("transport errors propagate and leave playback/download state alone", async () => {
    const { client, calls } = fixture({ fail: true });
    await expect(client.exportTrackBlob("track-a")).rejects.toThrow("transport failed");
    expect(calls.playback).toBe(0);
    expect(client.audioOpenRequests).toBe(0);
    expect(client.activeAudioSources).toBe(0);
    expect(client.coverFetchPaused).toBe(false);
  });

  test("progress callback errors close the opened stream", async () => {
    const { client, calls } = fixture();
    await expect(
      client.exportTrackBlob("track-a", () => {
        throw new Error("progress failed");
      }),
    ).rejects.toThrow("progress failed");
    expect(calls.cancelled).toBe(1);
    expect(client.activeAudioSources).toBe(0);
  });

  test("authoritative network size is capped upfront and the stream is cancelled", async () => {
    const { client, calls } = fixture({ size: MAX_EXPORT_TRACK_BYTES + 1 });
    await expect(client.exportTrackBlob("track-a")).rejects.toThrow("size limit");
    expect(calls.cancelled).toBe(1);
    expect(calls.free).toBe(1);
  });

  test("custom maxBytes applies to streams and complete memory cache hits", async () => {
    const { client, calls } = fixture();
    await expect(client.exportTrackBlob("track-a", undefined, { maxBytes: 7 })).rejects.toThrow(
      "size limit",
    );
    await client.rememberTrackBlob("track-a", new Blob([original]));
    await expect(client.exportTrackBlob("track-a", undefined, { maxBytes: 7 })).rejects.toThrow(
      "size limit",
    );
    expect(calls.open).toEqual(["track-a"]);
  });

  test("oversized persistent audio is rejected before reading its body", async () => {
    const { client, calls } = fixture();
    const response = new Response(original, { headers: { "content-length": "8" } });
    diskCache(response);
    await expect(client.exportTrackBlob("track-a", undefined, { maxBytes: 7 })).rejects.toThrow(
      "size limit",
    );
    expect(response.bodyUsed).toBe(false);
    expect(calls.open).toEqual([]);
  });

  for (const size of [0, -1, NaN, Infinity, 1.5]) {
    test(`invalid authoritative size ${size} is rejected`, async () => {
      const { client, calls } = fixture({ size });
      await expect(client.exportTrackBlob("track-a")).rejects.toThrow(
        "invalid original track size",
      );
      expect(calls.cancelled).toBe(1);
    });
  }

  test("invalid limits reject before any transport/cache work", async () => {
    const { client, calls } = fixture();
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5, MAX_EXPORT_TRACK_BYTES + 1])
      await expect(client.exportTrackBlob("track-a", undefined, { maxBytes })).rejects.toThrow(
        "invalid track export size limit",
      );
    expect(calls.open).toEqual([]);
  });

  test("Android does not advertise an unsupported export API", () => {
    const client = new NativeMusicClient({ handle: 1, endpointId: "client", remoteId: "server" });
    expect("exportTrackBlob" in client).toBe(false);
  });
});
