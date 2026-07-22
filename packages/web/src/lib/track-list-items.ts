import type { Album } from "@iroh-fm/client/types";

import type { Track } from "$lib/runes/Track.svelte.js";

function albumItem(
  albumKey: string,
  track: Track,
  album: Album | undefined,
  tracks: Track[],
  durationSeconds: number,
) {
  return {
    kind: "album" as const,
    key: `album:${albumKey}:${track.id}`,
    title: album?.title ?? track.album,
    artist: album?.album_artist ?? album?.artist ?? track.album_artist ?? track.artist,
    coverArtId: album?.cover_art_id ?? track.cover_art_id,
    durationSeconds,
    tracks,
    album,
  };
}

function trackItem(track: Track, trackIndex: number) {
  return {
    kind: "track" as const,
    key: `track:${track.id}`,
    track,
    trackIndex,
  };
}

export function createTrackListItems(
  filtered: Track[],
  offlineOnly: boolean,
  albumByTrackId: Map<string, Album>,
  tracksByAlbum: Map<string, Track[]>,
  cachedTracksByAlbum: Map<string, Track[]>,
) {
  let previousAlbumKey: string | undefined;
  return filtered.flatMap((track, trackIndex) => {
    const album = albumByTrackId.get(track.id);
    const albumKey = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
    const item = trackItem(track, trackIndex);
    if (albumKey === previousAlbumKey) return [item];

    previousAlbumKey = albumKey;
    const allAlbumTracks = tracksByAlbum.get(albumKey) ?? [track];
    const albumTracks = offlineOnly ? (cachedTracksByAlbum.get(albumKey) ?? []) : allAlbumTracks;
    const durationSeconds =
      (!offlineOnly ? album?.duration_seconds : null) ??
      albumTracks.reduce((total, candidate) => total + (candidate.duration_seconds ?? 0), 0);
    return [albumItem(albumKey, track, album, albumTracks, durationSeconds), item];
  });
}
