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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum LyricsStatus {
    Pending,
    Available,
    NotFound,
    Unavailable,
    Instrumental,
}

/// Automatic word-level ruby. Offsets are UTF-16 code units into the unchanged
/// plain/LRC source, matching JavaScript string indices, with an exclusive end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LyricReading {
    pub start: u32,
    pub end: u32,
    pub reading: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AnnotatedLyrics {
    // Identifies dictionary, tokenizer and annotation rules for cache upgrades.
    pub version: String,
    pub plain: Vec<LyricReading>,
    pub synced: Vec<LyricReading>,
}

/// On Available lyrics, a positive retry_after_seconds hint means automatic
/// annotations are still being prepared. Show original text while polling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TrackLyrics {
    pub track_id: TrackId,
    pub status: LyricsStatus,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotated_lyrics: Option<AnnotatedLyrics>,
    pub source_url: Option<String>,
    pub retry_after_seconds: Option<u32>,
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
    GetLibrarySnapshot {
        #[serde(default)]
        if_revision: Option<String>,
    },
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
    GetTrackLyrics {
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
pub struct LibrarySnapshot {
    pub revision: String,
    pub summary: LibrarySummary,
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BackendResponse {
    Error {
        message: String,
    },
    LibrarySummary(LibrarySummary),
    LibrarySnapshot(LibrarySnapshot),
    LibraryNotModified {
        revision: String,
    },
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
    TrackLyrics(TrackLyrics),
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
    fn track_lyrics_request_keeps_its_wire_shape() {
        let wire = serde_json::json!({
            "GetTrackLyrics": { "track_id": "track-1" }
        });
        let request = BackendRequest::GetTrackLyrics {
            track_id: TrackId("track-1".to_string()),
        };
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
        assert!(matches!(
            serde_json::from_value(wire).unwrap(),
            BackendRequest::GetTrackLyrics { track_id } if track_id.0 == "track-1"
        ));
    }

    #[test]
    fn available_track_lyrics_preserves_text_and_source() {
        let lyrics = TrackLyrics {
            track_id: TrackId("track-1".to_string()),
            status: LyricsStatus::Available,
            plain_lyrics: Some("First line\nSecond line".to_string()),
            synced_lyrics: Some("[00:01.00]First line\n[00:02.00]Second line".to_string()),
            annotated_lyrics: None,
            source_url: Some("https://lyrics.example/track-1".to_string()),
            retry_after_seconds: None,
        };
        let wire = serde_json::json!({
            "TrackLyrics": {
                "track_id": "track-1",
                "status": "Available",
                "plain_lyrics": "First line\nSecond line",
                "synced_lyrics": "[00:01.00]First line\n[00:02.00]Second line",
                "source_url": "https://lyrics.example/track-1",
                "retry_after_seconds": null
            }
        });
        assert_eq!(
            serde_json::to_value(BackendResponse::TrackLyrics(lyrics.clone())).unwrap(),
            wire
        );
        let response: BackendResponse = serde_json::from_value(wire).unwrap();
        assert!(matches!(response, BackendResponse::TrackLyrics(value) if value == lyrics));
    }

    #[test]
    fn track_lyrics_statuses_and_nullable_fields_keep_their_wire_shape() {
        for (status, name, retry_after_seconds) in [
            (LyricsStatus::Pending, "Pending", Some(2)),
            (LyricsStatus::Available, "Available", None),
            (LyricsStatus::NotFound, "NotFound", None),
            (LyricsStatus::Unavailable, "Unavailable", Some(60)),
            (LyricsStatus::Instrumental, "Instrumental", None),
        ] {
            let lyrics = TrackLyrics {
                track_id: TrackId("track-1".to_string()),
                status,
                plain_lyrics: None,
                synced_lyrics: None,
                annotated_lyrics: None,
                source_url: None,
                retry_after_seconds,
            };
            let wire = serde_json::json!({
                "TrackLyrics": {
                    "track_id": "track-1",
                    "status": name,
                    "plain_lyrics": null,
                    "synced_lyrics": null,
                    "source_url": null,
                    "retry_after_seconds": retry_after_seconds
                }
            });
            assert_eq!(
                serde_json::to_value(BackendResponse::TrackLyrics(lyrics.clone())).unwrap(),
                wire
            );
            let response: BackendResponse = serde_json::from_value(wire).unwrap();
            assert!(matches!(response, BackendResponse::TrackLyrics(value) if value == lyrics));
        }
    }

    #[test]
    fn annotations_are_additive_and_roundtrip_exact_sources() {
        let wire = serde_json::json!({
            "track_id": "track-1", "status": "Available",
            "plain_lyrics": "😀海！", "synced_lyrics": "[00:01.20]😀海！",
            "source_url": null, "retry_after_seconds": null,
            "annotated_lyrics": {
                "version": "test-v1",
                "plain": [{"start": 2, "end": 3, "reading": "うみ"}],
                "synced": [{"start": 12, "end": 13, "reading": "うみ"}]
            }
        });
        let lyrics: TrackLyrics = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(lyrics).unwrap(), wire);
        // Older consumers ignore the additive field; the original source and
        // status still deserialize independently of annotation support.
        #[derive(Deserialize)]
        struct OlderLyrics {
            plain_lyrics: String,
            synced_lyrics: String,
            status: LyricsStatus,
        }
        let old: OlderLyrics = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(old.plain_lyrics, "😀海！");
        assert_eq!(old.synced_lyrics, "[00:01.20]😀海！");
        assert_eq!(old.status, LyricsStatus::Available);
        let mut old_wire = wire;
        old_wire.as_object_mut().unwrap().remove("annotated_lyrics");
        assert!(
            serde_json::from_value::<TrackLyrics>(old_wire)
                .unwrap()
                .annotated_lyrics
                .is_none()
        );
    }

    #[test]
    fn available_annotation_pending_hint_roundtrips_without_hiding_source() {
        let wire = serde_json::json!({
            "track_id": "track-1", "status": "Available",
            "plain_lyrics": "海", "synced_lyrics": null,
            "source_url": null, "retry_after_seconds": 5
        });
        let lyrics: TrackLyrics = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(lyrics.status, LyricsStatus::Available);
        assert_eq!(lyrics.plain_lyrics.as_deref(), Some("海"));
        assert_eq!(lyrics.retry_after_seconds, Some(5));
        assert!(lyrics.annotated_lyrics.is_none());
        assert_eq!(serde_json::to_value(lyrics).unwrap(), wire);
    }

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
    fn conditional_library_snapshot_keeps_its_wire_shape() {
        let request: BackendRequest = serde_json::from_value(serde_json::json!({
            "GetLibrarySnapshot": { "if_revision": "library-v1-deadbeef" }
        }))
        .unwrap();
        assert!(matches!(
            request,
            BackendRequest::GetLibrarySnapshot {
                if_revision: Some(revision)
            } if revision == "library-v1-deadbeef"
        ));

        let response = BackendResponse::LibraryNotModified {
            revision: "library-v1-deadbeef".to_string(),
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "LibraryNotModified": {
                    "revision": "library-v1-deadbeef"
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
