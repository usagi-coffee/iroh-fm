use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub music_dir: PathBuf,
    /// Allow track metadata to be sent to LRCLIB for demand lyrics requests.
    pub lyrics_enabled: bool,
    /// Fetch lyrics for idle library tracks, in addition to demand requests.
    pub lyrics_warm: bool,
}

impl ServerConfig {
    pub fn new(music_dir: impl Into<PathBuf>) -> Self {
        Self {
            music_dir: music_dir.into(),
            lyrics_enabled: true,
            lyrics_warm: false,
        }
    }
}
