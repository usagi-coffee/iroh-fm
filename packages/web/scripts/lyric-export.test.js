import {
  canExportLyrics,
  createLyricArchive,
  createLyricSnapshot,
  downloadLyricArchive,
  lyricFilename,
  MAX_LYRIC_AUDIO_BYTES,
} from "../src/lib/lyric-export.js";

import { strFromU8, unzipSync } from "fflate";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const track = {
  id: "current-track",
  title: "日本語 / 海の歌",
  artist: "歌手",
  album: "アルバム",
  duration_seconds: 30,
  suffix: "flac",
  content_type: "audio/flac",
};
const dictionary = {
  lemma: "海",
  meanings: [
    { entry_id: "123", reading: "うみ", senses: [{ glosses: ["sea", "ocean"], labels: ["noun"] }] },
  ],
  truncated: false,
};

function fixture() {
  const plain = "\uFEFF海！\r\n𠮷野家 海\r\n";
  const synced =
    "\uFEFF[ar:歌手]\r\n[00:03.4][00:05.040] 😀海 <00:03.5>日本語\r\n[00:01:250]𠮷野家\r\n[offset:-500]";
  const annotate = (source) =>
    [...source.matchAll(/海|日本語|𠮷野家/g)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      reading: match[0] === "海" ? "うみ" : match[0] === "日本語" ? "にほんご" : "よしのや",
      ...(match[0] === "海" ? { dictionary } : {}),
    }));
  return {
    track_id: track.id,
    status: "Available",
    plain_lyrics: plain,
    synced_lyrics: synced,
    source_url: "https://lrclib.net/api/get/123",
    annotated_lyrics: {
      version: "dictionary-v1",
      plain: annotate(plain),
      synced: annotate(synced),
    },
  };
}

test("ZIP keeps complete audio and original UTF-8 sources, ruby/dictionary data and provenance", async () => {
  const lyrics = fixture();
  const snapshot = createLyricSnapshot(track, lyrics, 30);
  const audio = new Blob([new Uint8Array([0, 255, 128, 1, 2, 3])], { type: "audio/flac" });
  const archive = await createLyricArchive(snapshot, audio);
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), [
    "ATTRIBUTION.txt",
    "GUIDE.txt",
    "audio.flac",
    "lyrics.json",
    "lyrics.lrc",
    "lyrics.txt",
  ]);
  assert.deepEqual(files["audio.flac"], new Uint8Array(await audio.arrayBuffer()));
  assert.deepEqual(files["lyrics.lrc"], new TextEncoder().encode(lyrics.synced_lyrics));
  assert.deepEqual(files["lyrics.txt"], new TextEncoder().encode(lyrics.plain_lyrics));
  const json = JSON.parse(strFromU8(files["lyrics.json"]));
  assert.equal(json.schema, "iroh-fm.lyric-export");
  assert.equal(json.version, 1);
  assert.deepEqual(json.track, { ...track, file_size: null });
  assert.equal(json.lyrics.sources.synced.text, lyrics.synced_lyrics);
  assert.deepEqual(json.lyrics.sources.synced.annotations, lyrics.annotated_lyrics.synced);
  assert.equal(json.lyrics.annotation_status, "available");
  assert.match(json.lyrics.annotation_note, /not a lyric translation/);
  assert.deepEqual(json.audio, {
    filename: "audio.flac",
    content_type: "audio/flac",
    size_bytes: 6,
    original: true,
  });
  assert.deepEqual(
    json.lyrics.lines.map((line) => line.time_seconds),
    [1.75, 3.9, 5.54],
  );
  assert.deepEqual(
    json.lyrics.lines.map((line) => line.text),
    ["𠮷野家", "😀海 日本語", "😀海 日本語"],
  );
  for (const line of json.lyrics.lines) {
    assert.equal(line.timing, "synced");
    for (const word of line.words)
      assert.equal(word.surface, lyrics.synced_lyrics.slice(word.start, word.end));
  }
  assert.deepEqual(json.lyrics.lines[1].words[0].dictionary, dictionary);
  assert.equal(json.lyrics.lines[1].words[1].reading, "にほんご");
  assert(!Object.hasOwn(json.lyrics.lines[1].words[1], "dictionary"));
  assert.match(strFromU8(files["ATTRIBUTION.txt"]), /https:\/\/lrclib.net\/api\/get\/123/);
  assert.match(strFromU8(files["ATTRIBUTION.txt"]), /JMdict\/EDRDG/);
  assert.match(strFromU8(files["ATTRIBUTION.txt"]), /Attribution-ShareAlike 4.0/);
  assert.match(strFromU8(files["GUIDE.txt"]), /NOT suitable as precise cut boundaries/);
  const license = await readFile(
    new URL("../../../crates/server/IPADIC-COPYING", import.meta.url),
    "utf8",
  );
  assert(strFromU8(files["ATTRIBUTION.txt"]).includes(license.trim()));
  // Every entry is stored, so already-compressed audio is never recompressed.
  const bytes = new Uint8Array(await archive.blob.arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint16(8, true), 0);
});

test("pending/missing annotations export originals with explicit availability and estimated times", async () => {
  const lyrics = {
    track_id: track.id,
    status: "Available",
    plain_lyrics: "海\n\n歌",
    retry_after_seconds: 5,
  };
  const snapshot = createLyricSnapshot(track, lyrics, 20);
  assert.equal(snapshot.lyrics.annotation_status, "incomplete");
  assert.equal(snapshot.lyrics.annotation_version, null);
  assert.equal(snapshot.lyrics.display_source, "plain");
  assert.deepEqual(
    snapshot.lyrics.lines.map((line) => line.time_seconds),
    [0, 10],
  );
  assert(
    snapshot.lyrics.lines.every(
      (line) => line.timing === "duration_estimate" && !line.words.length,
    ),
  );
  const archive = await createLyricArchive(snapshot, new Blob(["audio"]));
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  assert(!Object.hasOwn(files, "lyrics.lrc"));
  assert.equal(strFromU8(files["lyrics.txt"]), "海\n\n歌");
  assert.equal(
    createLyricSnapshot(track, { track_id: track.id, status: "Available", plain_lyrics: "海" }, 0)
      .lyrics.lines[0].time_seconds,
    null,
  );
  assert.equal(
    createLyricSnapshot(track, { track_id: track.id, status: "Available", plain_lyrics: "海" }, 0)
      .lyrics.annotation_status,
    "unavailable",
  );
});

test("snapshots do not change with new song metadata, lyrics, or later dictionary upgrades", () => {
  const mutableTrack = { ...track };
  const lyrics = fixture();
  const snapshot = createLyricSnapshot(mutableTrack, lyrics, 30);
  mutableTrack.id = "new-track";
  mutableTrack.title = "new title";
  lyrics.synced_lyrics = "new lyrics";
  lyrics.annotated_lyrics.synced[0].reading = "new reading";
  assert.equal(snapshot.track.id, "current-track");
  assert.equal(snapshot.track.title, track.title);
  assert.match(snapshot.lyrics.sources.synced.text, /海/);
  assert.equal(snapshot.lyrics.lines[1].words[0].reading, "うみ");
});

test("source spans exclude metadata, tags, crossing and invalid offsets but raw annotations survive", () => {
  const source = "\uFEFF[ar:海]\r\n[offset:500]\r\n[00:02]海<00:02.5>歌";
  const spans = [
    { start: 5, end: 6, reading: "metadata" },
    { start: -1, end: 5, reading: "invalid" },
    { start: source.indexOf("海<"), end: source.length, reading: "crossing" },
    {
      start: source.indexOf("海<"),
      end: source.indexOf("海<") + 1,
      reading: "うみ",
      dictionary: { lemma: "海", meanings: [], truncated: false },
    },
  ];
  const snapshot = createLyricSnapshot(
    track,
    {
      track_id: track.id,
      status: "Available",
      synced_lyrics: source,
      annotated_lyrics: { version: "v1", synced: spans, plain: [] },
    },
    30,
  );
  assert.equal(snapshot.lyrics.lines[0].time_seconds, 1.5);
  assert.equal(snapshot.lyrics.lines[0].words.length, 1);
  assert.deepEqual(snapshot.lyrics.lines[0].words[0].dictionary.meanings, []);
  assert.equal(snapshot.lyrics.sources.synced.annotations.length, 4);
});

test("filename is bounded, Unicode-safe and not a path or device name", () => {
  assert.equal(lyricFilename("歌手 - 日本語 / 海の歌"), "歌手 - 日本語 _ 海の歌-lyrics.zip");
  assert.equal(lyricFilename("../\u0000\u202e歌:*?"), "___歌___-lyrics.zip");
  assert.equal(lyricFilename("... "), "song-lyrics.zip");
  assert.equal(lyricFilename("CON"), "_CON-lyrics.zip");
  assert.equal(lyricFilename("𠮷".repeat(200)), "𠮷".repeat(50) + "-lyrics.zip");
  assert(new TextEncoder().encode(lyricFilename("海".repeat(200))).length <= 211);
});

test("only Available text exports; rejects empty audio and oversized audio before allocation", async () => {
  for (const status of ["Pending", "Instrumental", "NotFound", "Unavailable"]) {
    assert.equal(canExportLyrics({ status, plain_lyrics: "海" }), false);
    assert.throws(
      () => createLyricSnapshot(track, { status, plain_lyrics: "海" }, 30),
      /No lyrics/,
    );
  }
  assert.equal(canExportLyrics(null), false);
  assert.equal(canExportLyrics({ status: "Available", plain_lyrics: " \r\n" }), false);
  assert.equal(
    canExportLyrics({ status: "Available", synced_lyrics: "[ar:歌手]\n[00:01]" }),
    false,
  );
  assert.throws(
    () => createLyricSnapshot({ ...track, file_size: MAX_LYRIC_AUDIO_BYTES + 1 }, fixture(), 30),
    /512 MiB/,
  );
  const snapshot = createLyricSnapshot(track, fixture(), 30);
  await assert.rejects(createLyricArchive(snapshot, new Blob()), /empty/);
  await assert.rejects(
    createLyricArchive(snapshot, { size: MAX_LYRIC_AUDIO_BYTES + 1 }),
    /512 MiB/,
  );
});

test("rejects stale lyrics and old partial cache blobs against authoritative track size", async () => {
  assert.throws(
    () => createLyricSnapshot(track, { ...fixture(), track_id: "old-track" }, 30),
    /do not belong/,
  );
  const snapshot = createLyricSnapshot({ ...track, file_size: 6 }, fixture(), 30);
  await assert.rejects(createLyricArchive(snapshot, new Blob(["short"])), /size does not match/);
  await assert.rejects(createLyricArchive(snapshot, new Blob(["too long"])), /size does not match/);
  const archive = await createLyricArchive(snapshot, new Blob(["exact!"]));
  assert(archive.blob.size > 0);
});

test("download URL is revoked after browser consumption, and temporary anchor is removed", (t) => {
  const events = [];
  const anchor = { click: () => events.push("click"), remove: () => events.push("remove") };
  t.mock.method(URL, "createObjectURL", () => "blob:archive");
  t.mock.method(URL, "revokeObjectURL", (url) => events.push(url));
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 60_000);
    callback();
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => anchor, body: { append: () => events.push("append") } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  downloadLyricArchive(new Blob(["zip"]), "歌-lyrics.zip");
  assert.equal(anchor.download, "歌-lyrics.zip");
  assert.equal(anchor.href, "blob:archive");
  assert.deepEqual(events, ["append", "click", "remove", "blob:archive"]);
});
