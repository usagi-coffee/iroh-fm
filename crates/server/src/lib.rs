pub mod config;
pub mod error;
mod furigana;
pub mod index;
pub mod iroh_rpc;
mod lyrics;
pub mod scanner;
pub mod server;
pub mod stream;

pub use config::ServerConfig;
pub use error::{Error, Result};
pub use index::{CoverArtSource, LibraryIndex};
pub use iroh_rpc::{
    IrohConfig, RemoteClient, ServerHandle, spawn_iroh_server, spawn_iroh_server_with_port,
};
pub use protocol::{
    Album, AlbumId, Artist, ArtistId, BackendRequest, BackendResponse, CoverArtBytes, CoverArtId,
    IROH_ALPN, LibrarySnapshot, LyricsStatus, Playlist, PlaylistId, ResolvedId, SearchQuery,
    StreamDescriptor, Track, TrackId, TrackLyrics,
};
pub use scanner::scan_music_dir;
pub use server::MusicServer;
pub use stream::read_file_prefix;
