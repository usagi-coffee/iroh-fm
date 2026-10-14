//! Demand-driven LRCLIB access. Only the worker performs HTTP; audio never waits
//! for the cache, a provider timer, or a network request.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use protocol::{LyricsStatus, Track, TrackId, TrackLyrics};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::{Error, LibraryIndex, Result, ServerConfig};

const REQUEST_GAP: Duration = Duration::from_secs(5);
const NEGATIVE_TTL: u64 = 30 * 24 * 60 * 60;
const MAX_QUEUE: usize = 256;
const MAX_BODY: usize = 1024 * 1024;
const BACKOFF_BASE: u64 = 60;
const BACKOFF_MAX: u64 = 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Metadata {
    id: TrackId,
    title: String,
    artist: String,
    album: String,
    duration: Option<u32>,
}

impl Metadata {
    fn from_track(track: &Track) -> Self {
        Self {
            id: track.id.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration: track.duration_seconds,
        }
    }

    fn fingerprint(&self) -> String {
        let bytes = serde_json::to_vec(&(
            "lrclib-v1",
            &self.title,
            &self.artist,
            &self.album,
            self.duration,
        ))
        .expect("lyrics metadata serializes");
        format!("{:x}", md5::compute(bytes))
    }

    fn usable(&self) -> bool {
        !self.title.trim().is_empty()
            && !self.artist.trim().is_empty()
            && self.duration.is_some_and(|d| d > 0)
    }
}

#[derive(Clone, Debug)]
struct Job {
    metadata: Metadata,
    search: bool,
}

#[derive(Default)]
struct Schedule {
    demand: VecDeque<Job>,
    active: Option<Job>,
}

impl Schedule {
    fn enqueue(&mut self, metadata: Metadata) -> bool {
        if let Some(active) = &self.active
            && active.metadata == metadata
        {
            return true;
        }
        if let Some(job) = self
            .demand
            .iter_mut()
            .find(|j| j.metadata.id == metadata.id)
        {
            if job.metadata != metadata {
                job.metadata = metadata;
                job.search = false;
            }
            return true;
        }
        // Reserve room for the in-flight lookup's search fallback.
        if self.demand.len() + usize::from(self.active.is_some()) >= MAX_QUEUE {
            return false;
        }
        self.demand.push_back(Job {
            metadata,
            search: false,
        });
        true
    }

    fn take(&mut self) -> Option<Job> {
        let job = self.demand.pop_front()?;
        self.active = Some(job.clone());
        Some(job)
    }

    fn finish(&mut self, fallback: bool) {
        if let Some(mut job) = self.active.take()
            && fallback
        {
            job.search = true;
            self.demand.push_back(job);
        }
    }
}

struct Cache {
    db: Mutex<Connection>,
}

impl Cache {
    fn open(path: &std::path::Path) -> Result<Self> {
        let db = Connection::open(path)?;
        // Lyrics uses its own connection, never the audio or playlist lock.
        db.busy_timeout(Duration::from_millis(100))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS track_lyrics (
                track_id TEXT PRIMARY KEY NOT NULL,
                fingerprint TEXT NOT NULL,
                result_json TEXT NOT NULL,
                expires_unix INTEGER
             );
             CREATE TABLE IF NOT EXISTS lyrics_provider (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                not_before_unix INTEGER NOT NULL,
                failures INTEGER NOT NULL
             );",
        )?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn get(&self, metadata: &Metadata, now: u64) -> Result<Option<TrackLyrics>> {
        let db = self.db.lock().expect("lyrics cache lock poisoned");
        let row = db
            .query_row(
                "SELECT result_json, expires_unix FROM track_lyrics
             WHERE track_id = ?1 AND fingerprint = ?2",
                params![metadata.id.0, metadata.fingerprint()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()?;
        let Some((json, expiry)) = row else {
            return Ok(None);
        };
        let expiry = expiry.map(|value| value.max(0) as u64);
        if expiry.is_some_and(|expiry| expiry <= now) {
            return Ok(None);
        }
        let mut result: TrackLyrics = serde_json::from_str(&json)?;
        result.retry_after_seconds =
            expiry.map(|expiry| expiry.saturating_sub(now).min(u32::MAX as u64) as u32);
        Ok(Some(result))
    }

    fn put(&self, metadata: &Metadata, result: &TrackLyrics, now: u64) -> Result<()> {
        let expiry = match result.status {
            LyricsStatus::NotFound => Some(now + NEGATIVE_TTL),
            LyricsStatus::Unavailable => {
                Some(now + result.retry_after_seconds.unwrap_or(60) as u64)
            }
            LyricsStatus::Available | LyricsStatus::Instrumental => None,
            LyricsStatus::Pending => return Ok(()),
        };
        self.db
            .lock()
            .expect("lyrics cache lock poisoned")
            .execute(
                "INSERT INTO track_lyrics (track_id, fingerprint, result_json, expires_unix)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(track_id) DO UPDATE SET fingerprint = excluded.fingerprint,
                result_json = excluded.result_json, expires_unix = excluded.expires_unix",
                params![
                    metadata.id.0,
                    metadata.fingerprint(),
                    serde_json::to_string(result)?,
                    expiry.map(|n| n.min(i64::MAX as u64) as i64)
                ],
            )?;
        Ok(())
    }

    fn throttle(&self) -> Result<(u64, u32)> {
        Ok(self
            .db
            .lock()
            .expect("lyrics cache lock poisoned")
            .query_row(
                "SELECT not_before_unix, failures FROM lyrics_provider WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?.max(0) as u64, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0)))
    }

    fn save_throttle(&self, deadline: u64, failures: u32) -> Result<()> {
        self.db
            .lock()
            .expect("lyrics cache lock poisoned")
            .execute(
                "INSERT INTO lyrics_provider VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET not_before_unix = excluded.not_before_unix,
                failures = excluded.failures",
                params![deadline.min(i64::MAX as u64) as i64, failures],
            )?;
        Ok(())
    }
}

struct Shared {
    schedule: Mutex<Schedule>,
    notify: Notify,
    cache: Cache,
}

pub(crate) struct LyricsService {
    shared: Arc<Shared>,
    worker: JoinHandle<()>,
}

impl LyricsService {
    pub(crate) fn new(config: &ServerConfig, library: Arc<RwLock<LibraryIndex>>) -> Result<Self> {
        Self::start(config, library, "https://lrclib.net".into(), REQUEST_GAP)
    }

    fn start(
        config: &ServerConfig,
        library: Arc<RwLock<LibraryIndex>>,
        base_url: String,
        request_gap: Duration,
    ) -> Result<Self> {
        let shared = Arc::new(Shared {
            schedule: Mutex::new(Schedule::default()),
            notify: Notify::new(),
            cache: Cache::open(&config.music_dir.join("iroh-fm.db"))?,
        });
        let client = reqwest::Client::builder()
            .user_agent(concat!(
                "iroh-fm/",
                env!("CARGO_PKG_VERSION"),
                " (https://github.com/usagi-coffee/iroh-fm)"
            ))
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|error| Error::InvalidRequest(format!("lyrics HTTP client: {error}")))?;
        let worker_shared = Arc::clone(&shared);
        let worker = tokio::spawn(async move {
            run_worker(worker_shared, library, client, base_url, request_gap).await;
        });
        Ok(Self { shared, worker })
    }

    pub(crate) fn get(&self, track: &Track) -> Result<TrackLyrics> {
        let metadata = Metadata::from_track(track);
        if let Some(result) = self.shared.cache.get(&metadata, unix_now())? {
            return Ok(result);
        }
        if !metadata.usable() {
            return Ok(empty(&metadata.id, LyricsStatus::Unavailable, None));
        }
        let retry_after = self
            .shared
            .cache
            .throttle()?
            .0
            .saturating_sub(unix_now())
            .clamp(5, u32::MAX as u64) as u32;
        let scheduled = self.enqueue(metadata.clone());
        Ok(empty(
            &metadata.id,
            if scheduled {
                LyricsStatus::Pending
            } else {
                LyricsStatus::Unavailable
            },
            Some(retry_after),
        ))
    }

    pub(crate) fn playing(&self, track: &Track) {
        let metadata = Metadata::from_track(track);
        if metadata.usable() {
            self.enqueue(metadata);
        }
    }

    fn enqueue(&self, metadata: Metadata) -> bool {
        let scheduled = self
            .shared
            .schedule
            .lock()
            .expect("lyrics schedule lock poisoned")
            .enqueue(metadata);
        self.shared.notify.notify_one();
        scheduled
    }
}

impl Drop for LyricsService {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

fn empty(id: &TrackId, status: LyricsStatus, retry: Option<u32>) -> TrackLyrics {
    TrackLyrics {
        track_id: id.clone(),
        status,
        plain_lyrics: None,
        synced_lyrics: None,
        source_url: None,
        retry_after_seconds: retry,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Global gate is measured from completion, not start. Persist rounded-up wall
/// time too, so restart cannot discard spacing or a provider's Retry-After.
struct Gate {
    until: Instant,
    failures: u32,
}

impl Gate {
    fn restored(deadline: u64, failures: u32) -> Self {
        Self {
            until: Instant::now() + Duration::from_secs(deadline.saturating_sub(unix_now())),
            failures,
        }
    }

    fn completed(&mut self, failure: Option<u64>, gap: Duration) -> Duration {
        let delay = if let Some(retry_after) = failure {
            self.failures = self.failures.saturating_add(1);
            let backoff = BACKOFF_BASE
                .saturating_mul(1u64 << self.failures.min(7).saturating_sub(1))
                .min(BACKOFF_MAX);
            gap.max(Duration::from_secs(
                backoff.max(retry_after.min(u32::MAX as u64)),
            ))
        } else {
            self.failures = 0;
            gap
        };
        self.until = Instant::now() + delay;
        delay
    }
}

async fn run_worker(
    shared: Arc<Shared>,
    library: Arc<RwLock<LibraryIndex>>,
    client: reqwest::Client,
    base_url: String,
    request_gap: Duration,
) {
    let (deadline, failures) = match shared.cache.throttle() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[lyrics] cannot restore provider cooldown: {error}");
            return;
        }
    };
    let mut gate = Gate::restored(deadline, failures);
    loop {
        if Instant::now() < gate.until {
            tokio::time::sleep_until(gate.until).await;
        }
        let job = shared
            .schedule
            .lock()
            .expect("lyrics schedule lock poisoned")
            .take();
        let Some(job) = job else {
            shared.notify.notified().await;
            continue;
        };
        let current = library
            .read()
            .expect("library lock poisoned")
            .tracks
            .get(&job.metadata.id)
            .map(Metadata::from_track);
        let cached = shared.cache.get(&job.metadata, unix_now());
        if current.as_ref() != Some(&job.metadata)
            || !job.metadata.usable()
            || !matches!(cached, Ok(None))
        {
            if let Err(error) = cached {
                eprintln!("[lyrics] cache read failed: {error}");
            }
            shared
                .schedule
                .lock()
                .expect("lyrics schedule lock poisoned")
                .finish(false);
            continue;
        }
        // Reserve the timeout plus spacing BEFORE network access. If the
        // process exits mid-request, restart still cannot immediately retry.
        let reserve = unix_now() + 10 + request_gap.as_secs().max(1) + 1;
        if let Err(error) = shared.cache.save_throttle(reserve, gate.failures) {
            eprintln!("[lyrics] cannot persist provider reservation: {error}");
            shared
                .schedule
                .lock()
                .expect("lyrics schedule lock poisoned")
                .finish(false);
            gate.completed(Some(0), request_gap);
            continue;
        }
        let outcome = attempt(&client, &base_url, &job).await;
        let failure = match &outcome {
            Outcome::Transient(retry) => Some(*retry),
            _ => None,
        };
        let delay = gate.completed(failure, request_gap);
        let persisted_deadline = unix_now().saturating_add(delay.as_secs()).saturating_add(1);
        if let Err(error) = shared
            .cache
            .save_throttle(persisted_deadline, gate.failures)
        {
            eprintln!("[lyrics] cannot persist provider cooldown: {error}");
            // Do not keep making requests if persistence is broken.
            gate.completed(Some(BACKOFF_MAX), request_gap);
        }
        let unchanged = library
            .read()
            .expect("library lock poisoned")
            .tracks
            .get(&job.metadata.id)
            .map(Metadata::from_track)
            .as_ref()
            == Some(&job.metadata);
        let fallback = unchanged && matches!(outcome, Outcome::Fallback);
        let result = match outcome {
            Outcome::Found(result) => Some(result),
            Outcome::NotFound => Some(empty(&job.metadata.id, LyricsStatus::NotFound, None)),
            Outcome::Transient(_) => Some(empty(
                &job.metadata.id,
                LyricsStatus::Unavailable,
                Some(delay.as_secs().min(u32::MAX as u64) as u32),
            )),
            Outcome::Fallback => None,
        };
        if unchanged
            && let Some(result) = result
            && let Err(error) = shared.cache.put(&job.metadata, &result, unix_now())
        {
            eprintln!("[lyrics] cache write failed: {error}");
        }
        shared
            .schedule
            .lock()
            .expect("lyrics schedule lock poisoned")
            .finish(fallback);
    }
}

enum Outcome {
    Found(TrackLyrics),
    Fallback,
    NotFound,
    Transient(u64),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: u64,
    track_name: String,
    artist_name: String,
    album_name: String,
    duration: f64,
    #[serde(default)]
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Strip only an explicit trailing Cover label. Never remove Japanese text,
/// artist credits, live/remix/version labels, or arbitrary parentheticals.
fn title_key(value: &str) -> String {
    let value = normalized(value);
    value
        .strip_suffix("(cover)")
        .unwrap_or(&value)
        .trim_end()
        .to_string()
}

fn matches_record(metadata: &Metadata, record: &Record) -> bool {
    // Providers differ in spacing around Japanese text and punctuation.
    // Artist, album, duration and all non-whitespace title characters still
    // have to agree; retain the original spacing in lookup queries.
    title_key(&metadata.title).replace(' ', "") == title_key(&record.track_name).replace(' ', "")
        && normalized(&metadata.artist) == normalized(&record.artist_name)
        && (metadata.album.trim().is_empty()
            || normalized(&metadata.album) == normalized(&record.album_name))
        && record.duration.is_finite()
        && metadata
            .duration
            .is_some_and(|d| (record.duration - f64::from(d)).abs() <= 2.0)
}

fn lyrics_result(metadata: &Metadata, record: Record) -> Option<TrackLyrics> {
    if !matches_record(metadata, &record) {
        return None;
    }
    let plain = record.plain_lyrics.filter(|s| !s.trim().is_empty());
    let synced = record.synced_lyrics.filter(|s| !s.trim().is_empty());
    let status = if record.instrumental {
        LyricsStatus::Instrumental
    } else if plain.is_some() || synced.is_some() {
        LyricsStatus::Available
    } else {
        return None;
    };
    Some(TrackLyrics {
        track_id: metadata.id.clone(),
        status,
        plain_lyrics: plain,
        synced_lyrics: synced,
        source_url: Some(format!("https://lrclib.net/lyrics/{}", record.id)),
        retry_after_seconds: None,
    })
}

fn select_search_result(metadata: &Metadata, records: Vec<Record>) -> Outcome {
    let mut candidates = records
        .into_iter()
        .filter_map(|record| lyrics_result(metadata, record));
    let Some(mut selected) = candidates.next() else {
        return Outcome::NotFound;
    };
    for candidate in candidates {
        let same_plain =
            selected.plain_lyrics.is_some() && selected.plain_lyrics == candidate.plain_lyrics;
        let same_synced =
            selected.synced_lyrics.is_some() && selected.synced_lyrics == candidate.synced_lyrics;
        let conflicting_plain =
            selected.plain_lyrics.is_some() && candidate.plain_lyrics.is_some() && !same_plain;
        let conflicting_synced =
            selected.synced_lyrics.is_some() && candidate.synced_lyrics.is_some() && !same_synced;
        // Duplicate records are common. Accept equivalent content, preferring
        // timestamps, but never choose between conflicting lyrics or timings.
        if selected.status != candidate.status
            || conflicting_plain
            || conflicting_synced
            || !(same_plain || same_synced || selected.status == LyricsStatus::Instrumental)
        {
            return Outcome::NotFound;
        }
        if selected.synced_lyrics.is_none() && candidate.synced_lyrics.is_some() {
            selected = candidate;
        }
    }
    Outcome::Found(selected)
}

fn retry_after(value: Option<&reqwest::header::HeaderValue>, now: SystemTime) -> u64 {
    let Some(value) = value.and_then(|v| v.to_str().ok()) else {
        return 0;
    };
    value.parse().unwrap_or_else(|_| {
        httpdate::parse_http_date(value)
            .ok()
            .and_then(|date| date.duration_since(now).ok())
            .map(|d| d.as_secs().saturating_add(1))
            .unwrap_or(0)
    })
}

async fn attempt(client: &reqwest::Client, base_url: &str, job: &Job) -> Outcome {
    let metadata = &job.metadata;
    let endpoint = if job.search { "search" } else { "get" };
    let title = if job.search {
        title_key(&metadata.title)
    } else {
        metadata.title.clone()
    };
    let mut query = vec![
        ("track_name", title),
        ("artist_name", metadata.artist.clone()),
        ("album_name", metadata.album.clone()),
    ];
    if !job.search {
        query.push(("duration", metadata.duration.unwrap_or(0).to_string()));
    }
    let response = client
        .get(format!("{base_url}/api/{endpoint}"))
        .query(&query)
        .send()
        .await;
    let Ok(mut response) = response else {
        return Outcome::Transient(0);
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND && !job.search {
        return Outcome::Fallback;
    }
    if !status.is_success() {
        return Outcome::Transient(retry_after(
            response.headers().get(reqwest::header::RETRY_AFTER),
            SystemTime::now(),
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Outcome::Transient(0);
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len().saturating_add(chunk.len()) <= MAX_BODY => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Outcome::Transient(0),
        }
    }
    if job.search {
        let Ok(records) = serde_json::from_slice::<Vec<Record>>(&bytes) else {
            return Outcome::Transient(0);
        };
        select_search_result(metadata, records)
    } else {
        let Ok(record) = serde_json::from_slice::<Record>(&bytes) else {
            return Outcome::Transient(0);
        };
        match lyrics_result(metadata, record) {
            Some(result) => Outcome::Found(result),
            None => Outcome::Fallback,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "iroh-fm-lyrics-{}-{}-{}",
                std::process::id(),
                unix_now(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn config(&self) -> ServerConfig {
            ServerConfig::new(&self.0)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn track(title: &str) -> Track {
        Track {
            id: TrackId(title.into()),
            title: title.into(),
            artist: "歌手".into(),
            album: "アルバム".into(),
            album_artist: Some("Compilation".into()),
            duration_seconds: Some(180),
            track_number: None,
            disc_number: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            codec: None,
            genres: vec![],
            date: None,
            musicbrainz_track_id: None,
            musicbrainz_recording_id: None,
            musicbrainz_album_id: None,
            musicbrainz_release_group_id: None,
            cover_art_id: None,
            has_embedded_cover: false,
            suffix: None,
            relative_path: PathBuf::from(format!("{title}.mp3")),
            file_size: 42,
            modified_at: UNIX_EPOCH,
            content_type: "audio/mpeg".into(),
        }
    }

    fn index(tracks: &[Track]) -> Arc<RwLock<LibraryIndex>> {
        Arc::new(RwLock::new(LibraryIndex::new(
            BTreeMap::new(),
            BTreeMap::new(),
            tracks.iter().map(|t| (t.id.clone(), t.clone())).collect(),
            BTreeMap::new(),
        )))
    }

    fn record(title: &str) -> Record {
        Record {
            id: 123,
            track_name: title.into(),
            artist_name: "歌手".into(),
            album_name: "アルバム".into(),
            duration: 180.9,
            instrumental: false,
            plain_lyrics: Some("一行目\n二行目".into()),
            synced_lyrics: Some("[00:01.00]一行目\n[00:02.00]二行目".into()),
        }
    }

    fn body(title: &str) -> String {
        serde_json::json!({
            "id": 123, "trackName": title, "artistName": "歌手",
            "albumName": "アルバム", "duration": 180.9, "instrumental": false,
            "plainLyrics": "一行目\n二行目",
            "syncedLyrics": "[00:01.00]一行目\n[00:02.00]二行目"
        })
        .to_string()
    }

    struct Reply {
        status: u16,
        headers: String,
        body: String,
        delay: Duration,
    }

    impl Reply {
        fn new(status: u16, body: impl Into<String>) -> Self {
            Self {
                status,
                headers: String::new(),
                body: body.into(),
                delay: Duration::ZERO,
            }
        }
    }

    struct Mock {
        url: String,
        requests: mpsc::UnboundedReceiver<(String, Instant)>,
        task: JoinHandle<()>,
    }

    impl Mock {
        async fn start(replies: Vec<Reply>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let (tx, requests) = mpsc::unbounded_channel();
            let task = tokio::spawn(async move {
                for reply in replies {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut request = String::new();
                    reader.read_line(&mut request).await.unwrap();
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).await.unwrap();
                        if header == "\r\n" || header.is_empty() {
                            break;
                        }
                    }
                    tx.send((request, Instant::now())).unwrap();
                    tokio::time::sleep(reply.delay).await;
                    // status 0 simulates connection loss without a response.
                    if reply.status != 0 {
                        let response = format!(
                            "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
                            reply.status,
                            reply.body.len(),
                            reply.headers,
                            reply.body,
                        );
                        let _ = reader.get_mut().write_all(response.as_bytes()).await;
                    }
                }
                // Stay alive so an unexpected extra request can be observed.
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut request = String::new();
                    reader.read_line(&mut request).await.unwrap();
                    let _ = tx.send((request, Instant::now()));
                }
            });
            Self {
                url,
                requests,
                task,
            }
        }

        async fn next(&mut self) -> (String, Instant) {
            tokio::time::timeout(Duration::from_secs(2), self.requests.recv())
                .await
                .unwrap()
                .unwrap()
        }

        async fn quiet(&mut self, duration: Duration) {
            assert!(
                tokio::time::timeout(duration, self.requests.recv())
                    .await
                    .is_err()
            );
        }
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn ready(service: &LyricsService, track: &Track) -> TrackLyrics {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let result = service.get(track).unwrap();
                if result.status != LyricsStatus::Pending {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap()
    }

    #[test]
    fn persistent_cache_invalidates_metadata_and_distinguishes_negative_from_transient() {
        let dir = TestDir::new();
        let path = dir.0.join("iroh-fm.db");
        let metadata = Metadata::from_track(&track("曲"));
        let available = lyrics_result(&metadata, record("曲")).unwrap();
        let cache = Cache::open(&path).unwrap();
        cache.put(&metadata, &available, 100).unwrap();
        cache.save_throttle(900, 3).unwrap();
        drop(cache);
        let cache = Cache::open(&path).unwrap();
        assert_eq!(cache.throttle().unwrap(), (900, 3));
        let loaded = cache.get(&metadata, 1000).unwrap().unwrap();
        assert_eq!(loaded.status, LyricsStatus::Available);
        assert_eq!(
            loaded.source_url.as_deref(),
            Some("https://lrclib.net/lyrics/123")
        );
        assert_eq!(loaded.synced_lyrics, available.synced_lyrics);
        for changed in [
            Metadata {
                title: "Other".into(),
                ..metadata.clone()
            },
            Metadata {
                artist: "Other".into(),
                ..metadata.clone()
            },
            Metadata {
                album: "Other".into(),
                ..metadata.clone()
            },
            Metadata {
                duration: Some(181),
                ..metadata.clone()
            },
        ] {
            assert!(cache.get(&changed, 1000).unwrap().is_none());
        }
        cache
            .put(
                &metadata,
                &empty(&metadata.id, LyricsStatus::NotFound, None),
                100,
            )
            .unwrap();
        assert_eq!(
            cache
                .get(&metadata, 100 + NEGATIVE_TTL - 1)
                .unwrap()
                .unwrap()
                .status,
            LyricsStatus::NotFound
        );
        assert!(cache.get(&metadata, 100 + NEGATIVE_TTL).unwrap().is_none());
        cache
            .put(
                &metadata,
                &empty(&metadata.id, LyricsStatus::Unavailable, Some(60)),
                100,
            )
            .unwrap();
        assert_eq!(
            cache
                .get(&metadata, 101)
                .unwrap()
                .unwrap()
                .retry_after_seconds,
            Some(59)
        );
        assert!(cache.get(&metadata, 160).unwrap().is_none());
        cache
            .put(
                &metadata,
                &empty(&metadata.id, LyricsStatus::Pending, Some(5)),
                200,
            )
            .unwrap();
        assert!(
            cache.get(&metadata, 200).unwrap().is_none(),
            "Pending is never persisted"
        );
        cache
            .put(
                &metadata,
                &empty(&metadata.id, LyricsStatus::Instrumental, None),
                200,
            )
            .unwrap();
        assert_eq!(
            cache
                .get(&metadata, u32::MAX as u64)
                .unwrap()
                .unwrap()
                .status,
            LyricsStatus::Instrumental
        );
    }

    #[test]
    fn japanese_cover_matching_never_falls_back_to_original_artist_or_version() {
        let metadata = Metadata::from_track(&track("夜に駆ける (Cover)"));
        assert!(matches_record(&metadata, &record("夜に駆ける")));
        assert!(matches_record(&metadata, &record("夜に駆ける (cover)")));
        assert!(matches_record(&metadata, &record("夜に駆ける(Cover)")));
        assert!(matches_record(
            &Metadata::from_track(&track("粛聖!! ロリ神レクイエム☆")),
            &record("粛聖!!ロリ神レクイエム☆")
        ));
        let mut original_artist = record("夜に駆ける");
        original_artist.artist_name = "YOASOBI".into();
        assert!(!matches_record(&metadata, &original_artist));
        for title in [
            "夜に駆ける (Live)",
            "夜に駆ける (Remix)",
            "夜に駆ける (Acoustic)",
            "夜に駆ける (Cover by Someone)",
        ] {
            assert!(!matches_record(&metadata, &record(title)));
        }
        let mut wrong = record("夜に駆ける");
        wrong.duration = 184.0;
        assert!(!matches_record(&metadata, &wrong));
        wrong.duration = f64::NAN;
        assert!(!matches_record(&metadata, &wrong));
        wrong.duration = 180.0;
        wrong.album_name = "Live Album".into();
        assert!(!matches_record(&metadata, &wrong));
        assert_eq!(
            metadata.artist, "歌手",
            "use track artist, not compilation album artist"
        );
        assert_eq!(title_key("  日本語 (Live)  "), "日本語 (live)");
        let mut instrumental = record("夜に駆ける");
        instrumental.instrumental = true;
        instrumental.plain_lyrics = None;
        instrumental.synced_lyrics = None;
        assert_eq!(
            lyrics_result(&metadata, instrumental).unwrap().status,
            LyricsStatus::Instrumental
        );
    }

    #[test]
    fn bounded_scheduler_coalesces_queued_and_active_work() {
        let metadata = Metadata::from_track(&track("A"));
        let mut scheduler = Schedule::default();
        assert!(scheduler.enqueue(metadata.clone()));
        assert!(scheduler.enqueue(metadata.clone()));
        assert_eq!(scheduler.demand.len(), 1);
        let selected = scheduler.take().unwrap();
        assert_eq!(selected.metadata, metadata);
        assert!(!selected.search);
        assert!(scheduler.enqueue(metadata.clone()));
        assert!(scheduler.demand.is_empty());
        scheduler.finish(true);
        assert!(scheduler.enqueue(metadata.clone()));
        assert_eq!(scheduler.demand.len(), 1);
        assert!(scheduler.take().unwrap().search);
        scheduler.finish(false);
        for n in 0..MAX_QUEUE {
            assert!(scheduler.enqueue(Metadata::from_track(&track(&n.to_string()))));
        }
        assert!(!scheduler.enqueue(metadata));
        assert_eq!(scheduler.demand.len(), MAX_QUEUE);
    }

    #[test]
    fn full_queue_reserves_inflight_fallback_capacity() {
        let metadata = Metadata::from_track(&track("Cover"));
        let mut schedule = Schedule::default();
        assert!(schedule.enqueue(metadata.clone()));
        schedule.take().unwrap();
        for n in 0..MAX_QUEUE - 1 {
            assert!(schedule.enqueue(Metadata::from_track(&track(&n.to_string()))));
        }
        assert!(!schedule.enqueue(Metadata::from_track(&track("overflow"))));
        schedule.finish(true);
        assert_eq!(schedule.demand.len(), MAX_QUEUE);
        let fallback = schedule.demand.back().unwrap();
        assert_eq!(fallback.metadata, metadata);
        assert!(fallback.search);
    }

    #[test]
    fn equivalent_search_records_prefer_timestamps_but_conflicts_are_rejected() {
        let metadata = Metadata::from_track(&track("曲 (Cover)"));
        let mut plain = record("曲 (Cover)");
        plain.synced_lyrics = None;
        let timed = record("曲");
        let expected = timed.synced_lyrics.clone();
        let selected = select_search_result(&metadata, vec![plain, timed, record("曲")]);
        assert!(matches!(selected, Outcome::Found(result) if result.synced_lyrics == expected));

        let mut conflicting = record("曲");
        conflicting.synced_lyrics = Some("[00:12.00]一行目".into());
        assert!(matches!(
            select_search_result(&metadata, vec![record("曲"), conflicting]),
            Outcome::NotFound
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn global_gate_spaces_every_attempt_and_exponentially_cools_down() {
        assert!(REQUEST_GAP >= Duration::from_secs(5));
        let mut gate = Gate::restored(0, 0);
        let now = Instant::now();
        assert_eq!(gate.completed(None, REQUEST_GAP), Duration::from_secs(5));
        assert_eq!(gate.until, now + Duration::from_secs(5));
        assert_eq!(
            gate.completed(Some(0), REQUEST_GAP),
            Duration::from_secs(60)
        );
        assert_eq!(
            gate.completed(Some(0), REQUEST_GAP),
            Duration::from_secs(120)
        );
        assert_eq!(
            gate.completed(Some(900), REQUEST_GAP),
            Duration::from_secs(900)
        );
        for _ in 0..30 {
            gate.completed(Some(0), REQUEST_GAP);
        }
        assert_eq!(
            gate.completed(Some(0), REQUEST_GAP),
            Duration::from_secs(3600)
        );
        assert_eq!(
            gate.completed(Some(7200), REQUEST_GAP),
            Duration::from_secs(7200)
        );
        assert_eq!(gate.completed(None, REQUEST_GAP), REQUEST_GAP);
        assert_eq!(gate.failures, 0);
        let date = UNIX_EPOCH + Duration::from_secs(1000);
        let header =
            reqwest::header::HeaderValue::from_str(&httpdate::fmt_http_date(date)).unwrap();
        assert_eq!(
            retry_after(Some(&header), date - Duration::from_secs(90)),
            91
        );
        let header = reqwest::header::HeaderValue::from_static("123");
        assert_eq!(retry_after(Some(&header), date), 123);
    }

    #[tokio::test]
    async fn offline_mock_only_fetches_on_demand_and_reuses_cached_playback() {
        let dir = TestDir::new();
        let played = track("Played");
        let requested = track("Requested");
        let library = index(&[played.clone(), requested.clone(), track("Untouched")]);
        let mut reply = Reply::new(200, body("Played"));
        reply.delay = Duration::from_millis(40);
        let mut mock = Mock::start(vec![reply, Reply::new(200, body("Requested"))]).await;
        let gap = Duration::from_millis(15);
        let service =
            LyricsService::start(&dir.config(), Arc::clone(&library), mock.url.clone(), gap)
                .unwrap();
        mock.quiet(Duration::from_millis(60)).await;
        service.playing(&played);
        let (first, _) = mock.next().await;
        assert!(first.contains("track_name=Played&"));
        for _ in 0..10 {
            service.playing(&played);
        }
        assert_eq!(
            ready(&service, &played).await.status,
            LyricsStatus::Available
        );
        for _ in 0..10 {
            service.playing(&played);
            assert_eq!(
                service.get(&played).unwrap().status,
                LyricsStatus::Available
            );
        }
        mock.quiet(Duration::from_millis(60)).await;
        assert_eq!(
            service.get(&requested).unwrap().status,
            LyricsStatus::Pending
        );
        let (second, _) = mock.next().await;
        assert!(second.contains("track_name=Requested&"));
        assert_eq!(
            ready(&service, &requested).await.status,
            LyricsStatus::Available
        );
        drop(service);
        let service = LyricsService::start(&dir.config(), library, mock.url.clone(), gap).unwrap();
        service.playing(&played);
        service.playing(&requested);
        assert_eq!(
            service.get(&played).unwrap().status,
            LyricsStatus::Available
        );
        assert_eq!(
            service.get(&requested).unwrap().status,
            LyricsStatus::Available
        );
        // Wait beyond the persisted spacing to catch delayed extra requests.
        mock.quiet(Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn offline_mock_paces_fallback_with_coalesced_demand() {
        let dir = TestDir::new();
        let a = track("A (Cover)");
        let b = track("B");
        let c = track("C");
        let mut reply = Reply::new(404, "{}");
        reply.delay = Duration::from_millis(40);
        let mut mock = Mock::start(vec![
            reply,
            Reply::new(200, body("B")),
            Reply::new(200, body("C")),
            Reply::new(200, "[]"),
        ])
        .await;
        let gap = Duration::from_millis(35);
        let service = LyricsService::start(
            &dir.config(),
            index(&[a.clone(), b.clone(), c.clone()]),
            mock.url.clone(),
            gap,
        )
        .unwrap();
        service.playing(&a);
        let (first, first_at) = mock.next().await;
        assert!(first.contains("/api/get?track_name=A+%28Cover%29"));
        service.playing(&a);
        for _ in 0..10 {
            assert_eq!(service.get(&b).unwrap().status, LyricsStatus::Pending);
        }
        service.playing(&c);
        let (second, second_at) = mock.next().await;
        assert!(second.contains("track_name=B&"));
        assert!(second_at.duration_since(first_at) >= gap);
        assert_eq!(ready(&service, &b).await.status, LyricsStatus::Available);
        let (third, third_at) = mock.next().await;
        assert!(third.contains("track_name=C&"));
        assert!(third_at.duration_since(second_at) >= gap);
        let (fourth, fourth_at) = mock.next().await;
        assert!(fourth.contains("/api/search?track_name=a&"), "{fourth}");
        assert!(
            fourth_at.duration_since(third_at) >= gap,
            "fallback shares global pacing"
        );
        assert_eq!(ready(&service, &a).await.status, LyricsStatus::NotFound);
        assert_eq!(ready(&service, &c).await.status, LyricsStatus::Available);
        service.playing(&a);
        service.playing(&b);
        service.playing(&c);
        mock.quiet(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn offline_mock_rate_limit_is_transient_and_cooldown_survives_restart() {
        let dir = TestDir::new();
        let a = track("A");
        let b = track("B");
        let mut reply = Reply::new(429, "{}");
        reply.headers = "Retry-After: 120\r\n".into();
        let mut mock = Mock::start(vec![reply]).await;
        let config = dir.config();
        let library = index(&[a.clone(), b.clone()]);
        let service = LyricsService::start(
            &config,
            Arc::clone(&library),
            mock.url.clone(),
            Duration::from_millis(1),
        )
        .unwrap();
        assert_eq!(service.get(&a).unwrap().status, LyricsStatus::Pending);
        mock.next().await;
        let result = ready(&service, &a).await;
        assert_eq!(result.status, LyricsStatus::Unavailable);
        assert!(result.retry_after_seconds.unwrap() >= 119);
        assert!(service.shared.cache.throttle().unwrap().0 >= unix_now() + 119);
        let pending = service.get(&b).unwrap();
        assert_eq!(pending.status, LyricsStatus::Pending);
        assert!(pending.retry_after_seconds.unwrap() >= 119);
        mock.quiet(Duration::from_millis(40)).await;
        drop(service);
        let service =
            LyricsService::start(&config, library, mock.url.clone(), Duration::from_millis(1))
                .unwrap();
        service.playing(&b);
        assert_eq!(service.get(&a).unwrap().status, LyricsStatus::Unavailable);
        mock.quiet(Duration::from_millis(40)).await;
    }

    #[tokio::test]
    async fn offline_mock_network_503_invalid_body_and_oversize_are_not_negative() {
        for reply in [
            Reply::new(0, ""),
            Reply::new(503, "{}"),
            Reply::new(200, "invalid json"),
            Reply::new(200, "x".repeat(MAX_BODY + 1)),
        ] {
            let dir = TestDir::new();
            let a = track("A");
            let mut mock = Mock::start(vec![reply]).await;
            let service = LyricsService::start(
                &dir.config(),
                index(std::slice::from_ref(&a)),
                mock.url.clone(),
                Duration::from_millis(1),
            )
            .unwrap();
            service.playing(&a);
            mock.next().await;
            assert_eq!(ready(&service, &a).await.status, LyricsStatus::Unavailable);
            assert!(service.shared.cache.throttle().unwrap().1 > 0);
        }
    }

    #[tokio::test]
    async fn offline_mock_rejects_stale_metadata_and_ambiguous_search() {
        let dir = TestDir::new();
        let a = track("A");
        let library = index(std::slice::from_ref(&a));
        let mut reply = Reply::new(200, body("A"));
        reply.delay = Duration::from_millis(50);
        let mut mock = Mock::start(vec![reply]).await;
        let service = LyricsService::start(
            &dir.config(),
            Arc::clone(&library),
            mock.url.clone(),
            Duration::from_millis(1),
        )
        .unwrap();
        service.playing(&a);
        mock.next().await;
        library
            .write()
            .unwrap()
            .tracks
            .get_mut(&a.id)
            .unwrap()
            .title = "Changed".into();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            service
                .shared
                .cache
                .get(&Metadata::from_track(&a), unix_now())
                .unwrap()
                .is_none()
        );
        drop(service);
        let conflicting = body("A").replace("[00:01.00]", "[00:05.00]");
        let mut mock = Mock::start(vec![Reply::new(
            200,
            format!("[{},{}]", body("A"), conflicting),
        )])
        .await;
        let client = reqwest::Client::new();
        let job = Job {
            metadata: Metadata::from_track(&a),
            search: true,
        };
        assert!(matches!(
            attempt(&client, &mock.url, &job).await,
            Outcome::NotFound
        ));
        mock.next().await;
    }
}
