export interface LibrarySummary {
  artist_count: number;
  album_count: number;
  track_count: number;
}

export interface ArtistData {
  id: string;
  name: string;
  album_ids: string[];
}

export interface AlbumData {
  id: string;
  title: string;
  artist: string;
  album_artist: string | null;
  track_ids: string[];
  date: string | null;
  original_date: string | null;
  year: number | null;
  genres: string[];
  labels: string[];
  catalog_number: string | null;
  comment: string | null;
  musicbrainz_album_id: string | null;
  musicbrainz_release_group_id: string | null;
  disc_count: number | null;
  duration_seconds: number | null;
  size_bytes: number;
  cover_art_id: string | null;
}

export interface TrackData {
  id: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string | null;
  track_number: number | null;
  disc_number: number | null;
  duration_seconds: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
  genres: string[];
  date: string | null;
  musicbrainz_track_id: string | null;
  musicbrainz_recording_id: string | null;
  musicbrainz_album_id: string | null;
  musicbrainz_release_group_id: string | null;
  cover_art_id: string | null;
  has_embedded_cover?: boolean;
  suffix: string | null;
  relative_path?: string;
  file_size: number;
  modified_at: unknown;
  content_type: string;
}

export interface StarredSet {
  artists: ArtistData[];
  albums: AlbumData[];
  tracks: TrackData[];
}

export interface ConnectionInfo {
  path_type: string;
  address: string;
  received_bytes: number;
}

export type TrackListItem =
  | {
      kind: "album";
      key: string;
      title: string;
      artist: string;
      coverArtId: string | null;
      durationSeconds: number;
      tracks: Track[];
      album?: AlbumData;
    }
  | {
      kind: "track";
      key: string;
      track: Track;
      trackIndex: number;
    };
import type { Track } from "./runes/Track.svelte.js";
