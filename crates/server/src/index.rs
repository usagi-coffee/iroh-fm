use std::collections::BTreeMap;
use std::path::PathBuf;

use protocol::{
    Album, AlbumId, Artist, ArtistId, CoverArtId, LibrarySnapshot, LibrarySummary, Track, TrackId,
};

#[derive(Debug, Clone)]
pub struct LibraryIndex {
    pub artists: BTreeMap<ArtistId, Artist>,
    pub albums: BTreeMap<AlbumId, Album>,
    pub tracks: BTreeMap<TrackId, Track>,
    pub cover_arts: BTreeMap<CoverArtId, CoverArtSource>,
    revision: String,
}

impl LibraryIndex {
    pub fn new(
        artists: BTreeMap<ArtistId, Artist>,
        albums: BTreeMap<AlbumId, Album>,
        tracks: BTreeMap<TrackId, Track>,
        cover_arts: BTreeMap<CoverArtId, CoverArtSource>,
    ) -> Self {
        let mut library = Self {
            artists,
            albums,
            tracks,
            cover_arts,
            revision: String::new(),
        };
        library.revision = library.compute_revision();
        library
    }

    pub fn artist_count(&self) -> usize {
        self.artists.len()
    }

    pub fn album_count(&self) -> usize {
        self.albums.len()
    }

    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn snapshot(&self) -> LibrarySnapshot {
        LibrarySnapshot {
            revision: self.revision.clone(),
            summary: LibrarySummary {
                artist_count: self.artist_count(),
                album_count: self.album_count(),
                track_count: self.track_count(),
            },
            artists: self.artists.values().cloned().collect(),
            albums: self.albums.values().cloned().collect(),
            tracks: self.tracks.values().cloned().collect(),
        }
    }

    fn compute_revision(&self) -> String {
        let content = (
            LibrarySummary {
                artist_count: self.artist_count(),
                album_count: self.album_count(),
                track_count: self.track_count(),
            },
            self.artists.values().collect::<Vec<_>>(),
            self.albums.values().collect::<Vec<_>>(),
            self.tracks.values().collect::<Vec<_>>(),
        );
        let bytes = serde_json::to_vec(&content).expect("library metadata must serialize");
        format!("library-v1-{:x}", md5::compute(bytes))
    }
}

impl Default for LibraryIndex {
    fn default() -> Self {
        Self::new(
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
    }
}

#[derive(Debug, Clone)]
pub enum CoverArtSource {
    Sidecar {
        relative_path: PathBuf,
        content_type: String,
    },
    Embedded {
        track_id: TrackId,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library_with_artist(name: &str) -> LibraryIndex {
        let id = ArtistId("artist-1".to_string());
        LibraryIndex::new(
            BTreeMap::from([(
                id.clone(),
                Artist {
                    id,
                    name: name.to_string(),
                    album_ids: Vec::new(),
                },
            )]),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
    }

    #[test]
    fn revision_is_stable_and_changes_with_public_metadata() {
        let first = library_with_artist("First");
        let same = library_with_artist("First");
        let changed = library_with_artist("Changed");

        assert_eq!(first.revision(), same.revision());
        assert_ne!(first.revision(), changed.revision());
        assert!(first.revision().starts_with("library-v1-"));
    }
}
