import type { BackendRequest, BackendResponse } from "./types.js";

type ObjectResponse = Exclude<BackendResponse, string>;
type Keys<T> = T extends unknown ? keyof T : never;
type VariantName = Keys<ObjectResponse>;
type Variant<K extends VariantName> = Extract<ObjectResponse, Record<K, unknown>>[K];
type Request = (request: BackendRequest) => Promise<BackendResponse>;

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

export async function bootstrap(request: Request, starredKey = "") {
  const [summary, albums, artists, tracks, starred] = await Promise.all([
    request("GetLibrarySummary"),
    request("ListAlbums"),
    request("ListArtists"),
    request("ListTracks"),
    request(starredKey.trim() ? { GetStarredWithKey: { key: starredKey.trim() } } : "GetStarred"),
  ]);
  return {
    summary: variant(summary, "LibrarySummary"),
    albums: variant(albums, "Albums"),
    artists: variant(artists, "Artists"),
    tracks: variant(tracks, "Tracks"),
    starred: variant(starred, "Starred"),
  };
}

export async function setStarred(request: Request, id: string, starred: boolean, key = "") {
  const response = await request(
    key.trim()
      ? { SetStarredWithKey: { id, starred, key: key.trim() } }
      : { SetStarred: { id, starred } },
  );
  empty(response);
}
