import type { BackendRequest, BackendResponse } from "./types.js";

type ObjectResponse = Exclude<BackendResponse, string>;
type Keys<T> = T extends unknown ? keyof T : never;
type VariantName = Keys<ObjectResponse>;
type Variant<K extends VariantName> = Extract<ObjectResponse, Record<K, unknown>>[K];
type Request = (request: BackendRequest) => Promise<BackendResponse>;
type CacheIdentity = { serverId: string; clientId: string };

const LIBRARY_CACHE_FORMAT = 1;
const LIBRARY_CACHE_PREFIX = `iroh-fm-library-v${LIBRARY_CACHE_FORMAT}`;

type LibraryData = {
  summary: Variant<"LibrarySummary">;
  albums: Variant<"Albums">;
  artists: Variant<"Artists">;
  tracks: Variant<"Tracks">;
};

type CachedLibrary = LibraryData & {
  format: typeof LIBRARY_CACHE_FORMAT;
  revision: string;
};

export function encodeRequest(request: BackendRequest) {
  return JSON.stringify(request);
}

export function decodeResponse(response: string): BackendResponse {
  return JSON.parse(response) as BackendResponse;
}

export function protocolResponse(response: unknown): BackendResponse {
  return response as BackendResponse;
}

function variant<K extends VariantName>(response: BackendResponse, name: K): Variant<K> {
  if (typeof response === "object" && response !== null && name in response) {
    return response[name as keyof typeof response] as Variant<K>;
  }
  if (typeof response === "object" && response !== null && "Error" in response) {
    throw new Error(response.Error.message);
  }
  throw new Error(`backend returned an unexpected response for ${String(name)}`);
}

function empty(response: BackendResponse) {
  if (response === "Empty") return;
  if (typeof response === "object" && response !== null && "Error" in response) {
    throw new Error(response.Error.message);
  }
  throw new Error("backend returned an unexpected response for Empty");
}

function libraryCacheKey(identity: CacheIdentity) {
  return `${LIBRARY_CACHE_PREFIX}:${encodeURIComponent(identity.serverId)}:${encodeURIComponent(identity.clientId)}`;
}

function hasId(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function validLibrary(value: unknown): value is CachedLibrary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedLibrary>;
  const summary = candidate.summary;
  return (
    candidate.format === LIBRARY_CACHE_FORMAT &&
    typeof candidate.revision === "string" &&
    candidate.revision.length > 0 &&
    typeof summary === "object" &&
    summary !== null &&
    Number.isSafeInteger(summary.artist_count) &&
    Number.isSafeInteger(summary.album_count) &&
    Number.isSafeInteger(summary.track_count) &&
    Array.isArray(candidate.artists) &&
    candidate.artists.length === summary.artist_count &&
    candidate.artists.every(hasId) &&
    Array.isArray(candidate.albums) &&
    candidate.albums.length === summary.album_count &&
    candidate.albums.every(hasId) &&
    Array.isArray(candidate.tracks) &&
    candidate.tracks.length === summary.track_count &&
    candidate.tracks.every(hasId)
  );
}

function readCachedLibrary(identity?: CacheIdentity): CachedLibrary | null {
  if (!identity?.serverId || !identity.clientId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(libraryCacheKey(identity));
    if (!raw) return null;
    const cached: unknown = JSON.parse(raw);
    if (validLibrary(cached)) return cached;
    globalThis.localStorage?.removeItem(libraryCacheKey(identity));
  } catch {
    // Persistent storage can be unavailable or contain a partial/corrupt write.
  }
  return null;
}

function writeCachedLibrary(identity: CacheIdentity | undefined, library: CachedLibrary) {
  if (!identity?.serverId || !identity.clientId) return;
  try {
    globalThis.localStorage?.setItem(libraryCacheKey(identity), JSON.stringify(library));
  } catch {
    // Bootstrap remains usable when storage is unavailable or full.
  }
}

async function legacyLibrary(request: Request): Promise<LibraryData> {
  const [summary, albums, artists, tracks] = await Promise.all([
    request("GetLibrarySummary"),
    request("ListAlbums"),
    request("ListArtists"),
    request("ListTracks"),
  ]);
  return {
    summary: variant(summary, "LibrarySummary"),
    albums: variant(albums, "Albums"),
    artists: variant(artists, "Artists"),
    tracks: variant(tracks, "Tracks"),
  };
}

async function validatedLibrary(request: Request, identity?: CacheIdentity): Promise<LibraryData> {
  const cached = readCachedLibrary(identity);
  try {
    const response = await request({
      GetLibrarySnapshot: { if_revision: cached?.revision ?? null },
    });
    if (
      typeof response === "object" &&
      response !== null &&
      "LibraryNotModified" in response &&
      cached &&
      response.LibraryNotModified.revision === cached.revision
    ) {
      return cached;
    }
    const snapshot = variant(response, "LibrarySnapshot");
    const candidate: CachedLibrary = {
      format: LIBRARY_CACHE_FORMAT,
      revision: snapshot.revision,
      summary: snapshot.summary,
      albums: snapshot.albums,
      artists: snapshot.artists,
      tracks: snapshot.tracks,
    };
    if (!validLibrary(candidate)) throw new Error("backend returned an invalid library snapshot");
    writeCachedLibrary(identity, candidate);
    return candidate;
  } catch {
    // Servers predating GetLibrarySnapshot reject the request. Preserve
    // compatibility by using the original requests and do not trust cache.
    return legacyLibrary(request);
  }
}

export async function bootstrap(request: Request, starredKey = "", cacheIdentity?: CacheIdentity) {
  const [library, starred, playlists] = await Promise.all([
    validatedLibrary(request, cacheIdentity),
    request(starredKey.trim() ? { GetStarredWithKey: { key: starredKey.trim() } } : "GetStarred"),
    request("ListPlaylists"),
  ]);
  return {
    ...library,
    starred: variant(starred, "Starred"),
    playlists: variant(playlists, "Playlists"),
  };
}

export async function getPlaylist(request: Request, playlistId: string) {
  return variant(await request({ GetPlaylist: { playlist_id: playlistId } }), "Playlist");
}

export async function createPlaylist(request: Request, name: string, trackIds: string[] = []) {
  return variant(await request({ CreatePlaylist: { name, track_ids: trackIds } }), "Playlist");
}

export async function updatePlaylist(
  request: Request,
  playlistId: string,
  fields: { name?: string; comment?: string; trackIds?: string[] },
) {
  return variant(
    await request({
      UpdatePlaylist: {
        playlist_id: playlistId,
        name: fields.name ?? null,
        comment: fields.comment ?? null,
        track_ids: fields.trackIds ?? null,
      },
    }),
    "Playlist",
  );
}

export async function deletePlaylist(request: Request, playlistId: string) {
  empty(await request({ DeletePlaylist: { playlist_id: playlistId } }));
}

export async function reorderPlaylists(request: Request, playlistIds: string[]) {
  empty(await request({ ReorderPlaylists: { playlist_ids: playlistIds } }));
}

export async function setStarred(request: Request, id: string, starred: boolean, key = "") {
  const response = await request(
    key.trim()
      ? { SetStarredWithKey: { id, starred, key: key.trim() } }
      : { SetStarred: { id, starred } },
  );
  empty(response);
}
