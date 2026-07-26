use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const IROH_ALPN: &[u8] = b"irohifi/1";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub struct ArtistId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub struct AlbumId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub struct TrackId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub struct PlaylistId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub struct CoverArtId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Artist {
    pub id: ArtistId,
    pub name: String,
    pub album_ids: Vec<AlbumId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Album {
    pub id: AlbumId,
    pub title: String,
    pub artist: String,
    pub album_artist: Option<String>,
    pub track_ids: Vec<TrackId>,
    pub date: Option<String>,
    pub original_date: Option<String>,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub labels: Vec<String>,
    pub catalog_number: Option<String>,
    pub comment: Option<String>,
    pub musicbrainz_album_id: Option<String>,
    pub musicbrainz_release_group_id: Option<String>,
    pub disc_count: Option<u32>,
    pub duration_seconds: Option<u32>,
    pub size_bytes: u64,
    pub cover_art_id: Option<CoverArtId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Track {
    pub id: TrackId,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub duration_seconds: Option<u32>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub codec: Option<String>,
    pub genres: Vec<String>,
    pub date: Option<String>,
    pub musicbrainz_track_id: Option<String>,
    pub musicbrainz_recording_id: Option<String>,
    pub musicbrainz_album_id: Option<String>,
    pub musicbrainz_release_group_id: Option<String>,
    pub cover_art_id: Option<CoverArtId>,
    #[serde(skip, default)]
    pub has_embedded_cover: bool,
    pub suffix: Option<String>,
    #[serde(skip, default)]
    pub relative_path: PathBuf,
    pub file_size: u64,
    #[ts(type = "{ secs_since_epoch: number; nanos_since_epoch: number }")]
    pub modified_at: SystemTime,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SearchQuery {
    pub term: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StarredSet {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Playlist {
    pub id: PlaylistId,
    pub name: String,
    pub comment: Option<String>,
    pub track_ids: Vec<TrackId>,
    pub created_unix: i64,
    pub changed_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StreamDescriptor {
    pub track_id: TrackId,
    #[serde(skip, default)]
    pub path: PathBuf,
    pub content_type: String,
    pub file_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CoverArtBytes {
    pub cover_art_id: CoverArtId,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub enum ResolvedId {
    Artist(Artist),
    Album(Album),
    Track(Track),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BackendRequest {
    GetLibrarySummary,
    ListArtists,
    ListAlbums,
    ListTracks,
    GetStarred,
    GetStarredWithKey {
        key: String,
    },
    SetStarred {
        id: String,
        starred: bool,
    },
    SetStarredWithKey {
        id: String,
        starred: bool,
        key: String,
    },
    ListPlaylists,
    GetPlaylist {
        playlist_id: PlaylistId,
    },
    CreatePlaylist {
        name: String,
        track_ids: Vec<TrackId>,
    },
    UpdatePlaylist {
        playlist_id: PlaylistId,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        comment: Option<String>,
        #[serde(default)]
        track_ids: Option<Vec<TrackId>>,
    },
    DeletePlaylist {
        playlist_id: PlaylistId,
    },
    ReorderPlaylists {
        playlist_ids: Vec<PlaylistId>,
    },
    GetArtist {
        artist_id: ArtistId,
    },
    GetAlbum {
        album_id: AlbumId,
    },
    GetAlbumTracks {
        album_id: AlbumId,
    },
    GetTrack {
        track_id: TrackId,
    },
    GetCoverArt {
        cover_art_id: CoverArtId,
        #[serde(default)]
        full_quality: bool,
    },
    ResolveId {
        id: String,
    },
    Search {
        query: SearchQuery,
    },
    OpenStream {
        track_id: TrackId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LibrarySummary {
    pub artist_count: usize,
    pub album_count: usize,
    pub track_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BackendResponse {
    Error {
        message: String,
    },
    LibrarySummary(LibrarySummary),
    Empty,
    Artists(Vec<Artist>),
    Albums(Vec<Album>),
    Starred(StarredSet),
    Playlists(Vec<Playlist>),
    Playlist(Playlist),
    Artist(Artist),
    Album(Album),
    Tracks(Vec<Track>),
    Track(Track),
    CoverArt(CoverArtBytes),
    ResolvedId(ResolvedId),
    SearchResults {
        artists: Vec<Artist>,
        albums: Vec<Album>,
        tracks: Vec<Track>,
    },
    Stream(StreamDescriptor),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_requests_without_quality_flag_default_to_thumbnail() {
        let request: BackendRequest = serde_json::from_value(serde_json::json!({
            "GetCoverArt": { "cover_art_id": "cover" }
        }))
        .unwrap();

        assert!(matches!(
            request,
            BackendRequest::GetCoverArt {
                full_quality: false,
                ..
            }
        ));
    }

    #[test]
    fn library_summary_keeps_its_wire_shape() {
        let response = BackendResponse::LibrarySummary(LibrarySummary {
            artist_count: 1,
            album_count: 2,
            track_count: 3,
        });

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "LibrarySummary": {
                    "artist_count": 1,
                    "album_count": 2,
                    "track_count": 3
                }
            })
        );
    }

    #[test]
    fn playlist_update_fields_may_be_absent() {
        let request: BackendRequest = serde_json::from_value(serde_json::json!({
            "UpdatePlaylist": { "playlist_id": "playlist-1" }
        }))
        .unwrap();
        assert!(matches!(
            request,
            BackendRequest::UpdatePlaylist {
                name: None,
                comment: None,
                track_ids: None,
                ..
            }
        ));
    }

    #[test]
    fn playlist_wire_shape_preserves_track_order() {
        let playlist = Playlist {
            id: PlaylistId("playlist-1".to_string()),
            name: "Mix".to_string(),
            comment: Some("Ordered".to_string()),
            track_ids: vec![
                TrackId("track-2".to_string()),
                TrackId("track-1".to_string()),
            ],
            created_unix: 10,
            changed_unix: 20,
        };
        assert_eq!(
            serde_json::to_value(BackendResponse::Playlist(playlist)).unwrap(),
            serde_json::json!({
                "Playlist": {
                    "id": "playlist-1",
                    "name": "Mix",
                    "comment": "Ordered",
                    "track_ids": ["track-2", "track-1"],
                    "created_unix": 10,
                    "changed_unix": 20
                }
            })
        );
    }
}
