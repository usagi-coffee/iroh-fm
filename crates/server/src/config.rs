use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub music_dir: PathBuf,
}

impl ServerConfig {
    pub fn new(music_dir: impl Into<PathBuf>) -> Self {
        Self {
            music_dir: music_dir.into(),
        }
    }
}
