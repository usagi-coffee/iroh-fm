import { bootstrap, getTrackLyrics } from "./protocol.js";
import type { BackendRequest, BackendResponse, LyricsStatus, TrackLyrics } from "./types.js";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

class MemoryStorage {
  entries = new Map<string, string>();
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  key(index: number) {
    return [...this.entries.keys()][index] ?? null;
  }
  get length() {
    return this.entries.size;
  }
}

const identity = { serverId: "server-a", clientId: "client-a" };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: MemoryStorage;

function library(title = "Track") {
  return {
    revision: `library-v1-${title}`,
    summary: { artist_count: 1, album_count: 1, track_count: 1 },
    artists: [{ id: "artist-1", name: "Artist", album_ids: ["album-1"] }],
    albums: [{ id: "album-1", title: "Album", track_ids: ["track-1"] }],
    tracks: [{ id: "track-1", title }],
  };
}

function stateResponse(request: BackendRequest, starredTitle = "Favorite"): BackendResponse {
  if (request === "GetStarred")
    return {
      Starred: { artists: [], albums: [], tracks: [{ id: "starred-1", title: starredTitle }] },
    } as BackendResponse;
  if (request === "ListPlaylists") return { Playlists: [] };
  throw new Error(`unexpected state request: ${JSON.stringify(request)}`);
}

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("library bootstrap cache", () => {
  test("validates a cached revision before reuse and independently refreshes state", async () => {
    const firstRequests: BackendRequest[] = [];
    const first = await bootstrap(
      async (request) => {
        firstRequests.push(request);
        if (typeof request === "object" && "GetLibrarySnapshot" in request)
          return { LibrarySnapshot: library() } as BackendResponse;
        return stateResponse(request);
      },
      "",
      identity,
    );
    expect(first.tracks[0]?.title).toBe("Track");
    expect(storage.length).toBe(1);

    const secondRequests: BackendRequest[] = [];
    const second = await bootstrap(
      async (request) => {
        secondRequests.push(request);
        if (typeof request === "object" && "GetLibrarySnapshot" in request) {
          expect(request.GetLibrarySnapshot.if_revision).toBe("library-v1-Track");
          return { LibraryNotModified: { revision: "library-v1-Track" } };
        }
        return stateResponse(request, "New favorite");
      },
      "",
      identity,
    );

    expect(second.tracks[0]?.title).toBe("Track");
    expect(second.starred.tracks[0]?.title).toBe("New favorite");
    expect(secondRequests).toContain("GetStarred");
    expect(secondRequests).toContain("ListPlaylists");
    expect(secondRequests).not.toContain("ListTracks");
  });

  test("scopes snapshots by server and client identity", async () => {
    await bootstrap(
      async (request) =>
        typeof request === "object" && "GetLibrarySnapshot" in request
          ? ({ LibrarySnapshot: library() } as BackendResponse)
          : stateResponse(request),
      "",
      identity,
    );

    await bootstrap(
      async (request) => {
        if (typeof request === "object" && "GetLibrarySnapshot" in request) {
          expect(request.GetLibrarySnapshot.if_revision).toBeNull();
          return { LibrarySnapshot: library("Other") } as BackendResponse;
        }
        return stateResponse(request);
      },
      "",
      { ...identity, clientId: "client-b" },
    );
    expect(storage.length).toBe(2);
  });

  test("ignores corrupt storage and falls back for older servers", async () => {
    storage.setItem("iroh-fm-library-v1:server-a:client-a", "{broken");
    const requests: BackendRequest[] = [];
    const result = await bootstrap(
      async (request) => {
        requests.push(request);
        if (typeof request === "object" && "GetLibrarySnapshot" in request)
          throw new Error("unknown variant GetLibrarySnapshot");
        if (request === "GetLibrarySummary") return { LibrarySummary: library("Legacy").summary };
        if (request === "ListArtists")
          return { Artists: library("Legacy").artists } as BackendResponse;
        if (request === "ListAlbums")
          return { Albums: library("Legacy").albums } as BackendResponse;
        if (request === "ListTracks")
          return { Tracks: library("Legacy").tracks } as BackendResponse;
        return stateResponse(request);
      },
      "",
      identity,
    );

    expect(result.tracks[0]?.title).toBe("Legacy");
    expect(requests).toContain("GetLibrarySummary");
    expect(requests).toContain("ListTracks");
  });

  test("continues without caching when persistent storage is unavailable", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    const result = await bootstrap(
      async (request) =>
        typeof request === "object" && "GetLibrarySnapshot" in request
          ? ({ LibrarySnapshot: library("Unstored") } as BackendResponse)
          : stateResponse(request),
      "",
      identity,
    );

    expect(result.tracks[0]?.title).toBe("Unstored");
  });
});

describe("track lyrics", () => {
  test.each<LyricsStatus>(["Pending", "Available", "NotFound", "Unavailable", "Instrumental"])(
    "returns %s immediately with one request and no status polling",
    async (status) => {
      const requests: BackendRequest[] = [];
      const lyrics: TrackLyrics = {
        track_id: "track-1",
        status,
        plain_lyrics: status === "Available" ? "First line\nSecond line" : null,
        synced_lyrics: status === "Available" ? "[00:01.00]First line" : null,
        source_url: status === "Available" ? "https://lyrics.example/track-1" : null,
        retry_after_seconds: status === "Pending" ? 2 : null,
      };
      const result = await getTrackLyrics(async (request) => {
        requests.push(request);
        return { TrackLyrics: lyrics };
      }, "track-1");

      expect(requests).toEqual([{ GetTrackLyrics: { track_id: "track-1" } }]);
      expect(result).toBe(lyrics);
    },
  );

  test("propagates backend and transport errors", async () => {
    await expect(
      getTrackLyrics(async () => ({ Error: { message: "track not found" } }), "missing"),
    ).rejects.toThrow("track not found");
    await expect(
      getTrackLyrics(async () => {
        throw new Error("connection closed");
      }, "track-1"),
    ).rejects.toThrow("connection closed");
  });

  test("rejects an unexpected response", async () => {
    await expect(getTrackLyrics(async () => "Empty", "track-1")).rejects.toThrow(
      "backend returned an unexpected response for TrackLyrics",
    );
  });
});
