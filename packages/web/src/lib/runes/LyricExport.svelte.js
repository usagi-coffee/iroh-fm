import {
  canExportLyrics,
  createLyricArchive,
  createLyricSnapshot,
  downloadLyricArchive,
  MAX_LYRIC_AUDIO_BYTES,
} from "#lib/lyric-export.js";

/** A click-time export whose lifetime is independent of the open lyrics panel. */
export class LyricExport {
  running = $state(false);
  message = $state("");

  /**
   * @param {{exportTrackBlob: (id: string, progress: (received: number, total: number) => void, options: {maxBytes: number}) => Promise<Blob>}} client
   * @param {import('#lib/lyric-export.js').LyricExportTrack} track
   * @param {import('#lib/lyrics-request.js').TrackLyrics} lyrics
   * @param {number} duration
   */
  async download(client, track, lyrics, duration) {
    if (this.running || !canExportLyrics(lyrics)) return;
    this.running = true;
    this.message = "";
    try {
      const snapshot = createLyricSnapshot(track, lyrics, duration);
      const label = `Exporting ${snapshot.track.title}`;
      this.message = `${label}: downloading original audio…`;
      const audio = await client.exportTrackBlob(
        snapshot.track.id,
        (received, total) => {
          const progress =
            total > 0 ? `${Math.floor((received * 100) / total)}%` : `${received} bytes`;
          this.message = `${label}: original audio ${progress}…`;
        },
        { maxBytes: MAX_LYRIC_AUDIO_BYTES },
      );
      const archive = await createLyricArchive(snapshot, audio, (progress) => {
        this.message = `${label}: ${progress}`;
      });
      downloadLyricArchive(archive.blob, archive.filename);
      this.message = `Download started for ${snapshot.track.title}. ${
        snapshot.lyrics.annotation_status !== "available"
          ? "Annotations are incomplete or unavailable in this snapshot."
          : "Verify automatic dictionary readings and meanings."
      }`;
    } catch (error) {
      this.message = `Lyric export failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.running = false;
    }
  }
}
