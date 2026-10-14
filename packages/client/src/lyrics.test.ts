import { ClientCore } from "./core.js";
import { MusicClient } from "./index.js";
import { NativeMusicClient } from "./native.js";
import type { BackendRequest, TrackLyrics } from "./types.js";

import { describe, expect, test } from "bun:test";

const lyrics: TrackLyrics = {
  track_id: "track-1",
  status: "Pending",
  plain_lyrics: null,
  synced_lyrics: null,
  source_url: null,
  retry_after_seconds: 2,
};

const annotated: TrackLyrics = {
  ...lyrics,
  status: "Available",
  plain_lyrics: "日本語",
  retry_after_seconds: null,
  annotated_lyrics: {
    version: "test-v1",
    plain: [
      {
        start: 0,
        end: 3,
        reading: "にほんご",
        dictionary: {
          lemma: "日本語",
          meanings: [
            {
              entry_id: "1464530",
              reading: "にほんご",
              senses: [{ glosses: ["Japanese language"], labels: ["noun"] }],
            },
          ],
          truncated: false,
        },
      },
    ],
    synced: [],
  },
};

describe("lyrics host API", () => {
  test("ClientCore browser connections expose the payload through the JSON transport", async () => {
    const requests: string[] = [];
    const client = new MusicClient({
      async request(raw: string) {
        requests.push(raw);
        return JSON.stringify({ TrackLyrics: lyrics });
      },
    });
    const connect = MusicClient.connect;
    MusicClient.connect = async () => client;
    try {
      const connected = await ClientCore.connect({ ticket: "test-ticket" });
      expect(await connected.getTrackLyrics("track-1")).toEqual(lyrics);
      expect(requests).toEqual(['{"GetTrackLyrics":{"track_id":"track-1"}}']);
    } finally {
      MusicClient.connect = connect;
    }
  });

  test("Android clients expose the same getter using the generic protocol request", async () => {
    const requests: BackendRequest[] = [];
    const client = new NativeMusicClient({
      handle: 1,
      endpointId: "client-a",
      remoteId: "server-a",
    });
    client.request = async (request) => {
      requests.push(request);
      return { TrackLyrics: lyrics };
    };

    expect(await client.getTrackLyrics("track-1")).toBe(lyrics);
    expect(requests).toEqual([{ GetTrackLyrics: { track_id: "track-1" } }]);
  });

  test("optional annotations survive browser and native JSON bridges unchanged", async () => {
    const browser = new MusicClient({
      request: async () => JSON.stringify({ TrackLyrics: annotated }),
    });
    const native = new NativeMusicClient({
      handle: 1,
      endpointId: "client-a",
      remoteId: "server-a",
    });
    native.request = async () => ({ TrackLyrics: annotated });
    expect(await browser.getTrackLyrics("track-1")).toEqual(annotated);
    expect(await native.getTrackLyrics("track-1")).toEqual(annotated);
  });
});
