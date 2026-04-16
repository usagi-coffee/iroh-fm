use iroh::endpoint::RecvStream;

#[derive(Debug)]
pub enum SubsonicResponse {
    Xml(String),
    Json(String),
    Binary {
        content_type: String,
        bytes: Vec<u8>,
    },
    Stream {
        content_type: String,
        content_length: Option<u64>,
        stream: RecvStream,
    },
}
