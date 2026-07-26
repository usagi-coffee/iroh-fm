use client::{Client, Error, Result};
use iroh::endpoint::RecvStream;
use protocol::{
    BackendRequest, BackendResponse, CoverArtId, PlaylistId, SearchQuery, StreamDescriptor, TrackId,
};

#[allow(async_fn_in_trait)]
pub trait Backend {
    async fn summary(&self) -> Result<BackendResponse>;
    async fn artists(&self) -> Result<BackendResponse>;
    async fn albums(&self) -> Result<BackendResponse>;
    async fn starred(&self) -> Result<BackendResponse>;
    async fn set_starred(&self, id: &str, starred: bool) -> Result<BackendResponse>;
    async fn playlists(&self) -> Result<BackendResponse> {
        Err(Error::InvalidRequest(
            "playlists are unavailable".to_string(),
        ))
    }
    async fn playlist(&self, _playlist_id: &str) -> Result<BackendResponse> {
        Err(Error::InvalidRequest(
            "playlists are unavailable".to_string(),
        ))
    }
    async fn create_playlist(
        &self,
        _name: &str,
        _track_ids: Vec<TrackId>,
    ) -> Result<BackendResponse> {
        Err(Error::InvalidRequest(
            "playlists are unavailable".to_string(),
        ))
    }
    async fn update_playlist(
        &self,
        _playlist_id: &str,
        _name: Option<String>,
        _comment: Option<String>,
        _track_ids: Option<Vec<TrackId>>,
    ) -> Result<BackendResponse> {
        Err(Error::InvalidRequest(
            "playlists are unavailable".to_string(),
        ))
    }
    async fn delete_playlist(&self, _playlist_id: &str) -> Result<BackendResponse> {
        Err(Error::InvalidRequest(
            "playlists are unavailable".to_string(),
        ))
    }
    async fn artist(&self, artist_id: &str) -> Result<BackendResponse>;
    async fn album(&self, album_id: &str) -> Result<BackendResponse>;
    async fn album_tracks(&self, album_id: &str) -> Result<BackendResponse>;
    async fn track(&self, track_id: &str) -> Result<BackendResponse>;
    async fn resolve_id(&self, id: &str) -> Result<BackendResponse>;
    async fn cover_art(&self, cover_art_id: &str) -> Result<BackendResponse>;
    async fn search(&self, term: &str, limit: usize) -> Result<BackendResponse>;
    async fn stream(&self, track_id: &str) -> Result<(StreamDescriptor, RecvStream)>;
}

pub type RemoteBackend = Client;

impl Backend for Client {
    async fn summary(&self) -> Result<BackendResponse> {
        self.request(BackendRequest::GetLibrarySummary).await
    }

    async fn artists(&self) -> Result<BackendResponse> {
        self.request(BackendRequest::ListArtists).await
    }

    async fn albums(&self) -> Result<BackendResponse> {
        self.request(BackendRequest::ListAlbums).await
    }

    async fn starred(&self) -> Result<BackendResponse> {
        self.request(BackendRequest::GetStarred).await
    }

    async fn set_starred(&self, id: &str, starred: bool) -> Result<BackendResponse> {
        self.request(BackendRequest::SetStarred {
            id: id.to_string(),
            starred,
        })
        .await
    }

    async fn playlists(&self) -> Result<BackendResponse> {
        self.request(BackendRequest::ListPlaylists).await
    }

    async fn playlist(&self, playlist_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetPlaylist {
            playlist_id: PlaylistId(playlist_id.to_string()),
        })
        .await
    }

    async fn create_playlist(
        &self,
        name: &str,
        track_ids: Vec<TrackId>,
    ) -> Result<BackendResponse> {
        self.request(BackendRequest::CreatePlaylist {
            name: name.to_string(),
            track_ids,
        })
        .await
    }

    async fn update_playlist(
        &self,
        playlist_id: &str,
        name: Option<String>,
        comment: Option<String>,
        track_ids: Option<Vec<TrackId>>,
    ) -> Result<BackendResponse> {
        self.request(BackendRequest::UpdatePlaylist {
            playlist_id: PlaylistId(playlist_id.to_string()),
            name,
            comment,
            track_ids,
        })
        .await
    }

    async fn delete_playlist(&self, playlist_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::DeletePlaylist {
            playlist_id: PlaylistId(playlist_id.to_string()),
        })
        .await
    }

    async fn artist(&self, artist_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetArtist {
            artist_id: protocol::ArtistId(artist_id.to_string()),
        })
        .await
    }

    async fn album(&self, album_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetAlbum {
            album_id: protocol::AlbumId(album_id.to_string()),
        })
        .await
    }

    async fn album_tracks(&self, album_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetAlbumTracks {
            album_id: protocol::AlbumId(album_id.to_string()),
        })
        .await
    }

    async fn track(&self, track_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetTrack {
            track_id: TrackId(track_id.to_string()),
        })
        .await
    }

    async fn resolve_id(&self, id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::ResolveId { id: id.to_string() })
            .await
    }

    async fn cover_art(&self, cover_art_id: &str) -> Result<BackendResponse> {
        self.request(BackendRequest::GetCoverArt {
            cover_art_id: CoverArtId(cover_art_id.to_string()),
            full_quality: true,
        })
        .await
    }

    async fn search(&self, term: &str, limit: usize) -> Result<BackendResponse> {
        if term.trim().is_empty() {
            return Err(Error::InvalidRequest(
                "search term must not be empty".to_string(),
            ));
        }

        self.request(BackendRequest::Search {
            query: SearchQuery {
                term: term.to_string(),
                limit,
            },
        })
        .await
    }

    async fn stream(&self, track_id: &str) -> Result<(StreamDescriptor, RecvStream)> {
        self.stream_open(TrackId(track_id.to_string())).await
    }
}
