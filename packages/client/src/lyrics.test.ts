import { describe, expect, test } from "bun:test";
import { ClientCore } from "./core.js";
import { MusicClient } from "./index.js";
import { NativeMusicClient } from "./native.js";
import type { BackendRequest, TrackLyrics } from "./types.js";

const lyrics: TrackLyrics = {
  track_id: "track-1",
  status: "Pending",
  plain_lyrics: null,
  synced_lyrics: null,
  source_url: null,
  retry_after_seconds: 2,
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
});
