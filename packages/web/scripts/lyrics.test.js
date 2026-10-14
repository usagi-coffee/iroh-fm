import { requestLyrics } from "../src/lib/lyrics-request.js";
import { activeLyricIndex, estimateLyrics, lyricsSourceUrl, parseLrc } from "../src/lib/lyrics.js";

import assert from "node:assert/strict";
import { test } from "node:test";

test("parses repeated timestamps, fractions, offsets, metadata and Japanese text", () => {
  assert.deepEqual(
    parseLrc(
      "\uFEFF[ar:歌手]\r\n[00:03.4][00:05.040]日本語の歌詞\r\n[00:01:250]最初\r\n[offset:-500]",
    ),
    [
      { time: 1.75, text: "最初" },
      { time: 3.9, text: "日本語の歌詞" },
      { time: 5.54, text: "日本語の歌詞" },
    ],
  );
  assert.deepEqual(
    parseLrc("[offset:100]\n[00:01.1234]<00:01.1>歌\n[00:02]\n[00:99]invalid\n[offset:200]"),
    [
      { time: 0.9234, text: "歌" },
      { time: 1.8, text: "" },
    ],
  );
  assert.deepEqual(parseLrc("[offset:+5000]\n[00:01]clamped\nmetadata"), [
    { time: 0, text: "clamped" },
  ]);
  assert.deepEqual(parseLrc("plain lyrics\n[ar:Metadata]"), []);
});

test("positive LRC offsets advance lyrics and negative offsets delay them", () => {
  const advanced = parseLrc("[offset:+500]\n[00:02]advanced");
  const delayed = parseLrc("[offset:-500]\n[00:02]delayed");
  assert.deepEqual(advanced, [{ time: 1.5, text: "advanced" }]);
  assert.deepEqual(delayed, [{ time: 2.5, text: "delayed" }]);
  assert.equal(activeLyricIndex(advanced, 1.5), 0);
  assert.equal(activeLyricIndex(delayed, 2), -1);
  assert.equal(activeLyricIndex(delayed, 2.5), 0);
});

test("active positions recompute on backward seeks and respect exact boundaries", () => {
  const lines = parseLrc("[00:02]first\n[00:05]second\n[00:05]translation\n[00:10]third");
  assert.equal(activeLyricIndex(lines, 1.99), -1);
  assert.equal(activeLyricIndex(lines, 5), 2);
  assert.equal(activeLyricIndex(lines, 100), 3);
  assert.equal(activeLyricIndex(lines, 2), 0);
  assert.equal(activeLyricIndex(lines, NaN), -1);
  assert.equal(activeLyricIndex([], 0), -1);
});

test("estimated lines evenly span duration, retain Japanese and disable timing without duration", () => {
  const lines = estimateLyrics(" 日本語 \n\n二行目\r\n三行目\n", 30);
  assert.deepEqual(lines, [
    { time: 0, text: "日本語" },
    { time: 10, text: "二行目" },
    { time: 20, text: "三行目" },
  ]);
  assert.equal(activeLyricIndex(lines, 9), 0);
  assert.equal(activeLyricIndex(lines, 10), 1);
  assert.equal(activeLyricIndex(lines, 30), 2);
  assert.equal(activeLyricIndex(estimateLyrics("text", 0), 1), -1);
  assert.equal(activeLyricIndex(estimateLyrics("text", Infinity), 1), -1);
  assert.deepEqual(estimateLyrics(null, 30), []);
});

test("source links reject executable and relative URLs", () => {
  assert.equal(lyricsSourceUrl("https://lrclib.net/"), "https://lrclib.net/");
  assert.equal(lyricsSourceUrl("javascript:alert(1)"), null);
  assert.equal(lyricsSourceUrl("/lyrics"), null);
});

test("ruby source mapping preserves LRC timing across tags, CRLF, BOM and repeated timestamps", () => {
  const source =
    "\uFEFF[ar:歌手]\r\n[00:03.4][00:05.040] 😀日本語 <00:03.5>海！ \r\n[00:01:250]𠮷野家\r\n[offset:-500]";
  const spans = ["歌手", "日本語", "海", "𠮷野家"].map((word, index) => ({
    start: source.indexOf(word),
    end: source.indexOf(word) + word.length,
    reading: ["かしゅ", "にほんご", "うみ", "よしのや"][index],
  }));
  const original = parseLrc(source);
  const annotated = parseLrc(source, spans);
  assert.deepEqual(
    annotated.map(({ time, text }) => ({ time, text })),
    original,
  );
  for (const line of annotated) {
    assert.equal(line.parts.map((part) => part.text).join(""), line.text);
    assert(!line.parts.some((part) => part.reading === "かしゅ"));
  }
  assert.deepEqual(annotated[0].parts, [{ text: "𠮷野家", reading: "よしのや" }]);
  assert.deepEqual(
    annotated[1].parts.filter((part) => part.reading),
    [
      { text: "日本語", reading: "にほんご" },
      { text: "海", reading: "うみ" },
    ],
  );
  assert.deepEqual(annotated[1].parts, annotated[2].parts);
});

test("large lyric sources inspect annotations once, not for every line or tag range", () => {
  const count = 40_000;
  for (const synced of [true, false]) {
    const row = synced ? "[00:01]日<00:01.5>本\n" : "日本\n";
    const source = row.repeat(count);
    let inspections = 0;
    const spans = Array.from({ length: count }, (_, index) => ({
      get start() {
        // Bound work rather than elapsed time, including on slow test machines.
        assert(++inspections <= count * 20, "annotations were repeatedly scanned");
        return index * row.length + row.indexOf("本");
      },
      end: index * row.length + row.indexOf("本") + 1,
      reading: "ほん",
    }));
    const lines = synced ? parseLrc(source, spans) : estimateLyrics(source, 60, spans);
    assert.equal(lines.length, count);
    for (const line of lines) {
      assert.equal(line.text, "日本");
      assert.deepEqual(line.parts, [
        { text: "日", reading: null },
        { text: "本", reading: "ほん" },
      ]);
    }
  }
});

test("unordered, overlapping and malformed spans retain original annotation precedence", () => {
  const source = "\uFEFF[00:01][00:02] 日本語 <00:01.5>海 \r\n[00:03]𠮷野家";
  const start = source.indexOf("日本語");
  const spans = [
    { start: start + 1, end: start + 3, reading: "ほんご" },
    { start, end: start + 3, reading: "にほんご" },
    { start: start + 1, end: start + 2, reading: "duplicate" },
    { start: start + 0.5, end: start + 1, reading: "fractional" },
    { start: start + 3, end: source.indexOf("海") + 1, reading: "crossing" },
    { start: source.indexOf("海"), end: source.indexOf("海") + 1, reading: "" },
    { start: -1, end: 1, reading: "negative" },
    { start: source.indexOf("𠮷"), end: source.length + 1, reading: "outside" },
    { start, end: start, reading: "empty" },
  ];
  const lines = parseLrc(source, spans);
  assert.deepEqual(lines[0].parts, [
    { text: "日", reading: null },
    { text: "本語", reading: "ほんご" },
    { text: " ", reading: null },
    { text: "海", reading: null },
  ]);
  assert.deepEqual(lines[0].parts, lines[1].parts);
  assert.deepEqual(lines[2].parts, [{ text: "𠮷野家", reading: null }]);
  assert.deepEqual(parseLrc(source), lines.map(({ time, text }) => ({ time, text })));
});

test("plain ruby maps original rows while estimated timing and unknown text stay unchanged", () => {
  const source = " 海！ 😀 \r\n\r\n 𠮷𠮷𠮷 hello 日本語 \n海";
  const spans = [
    { start: 1, end: 2, reading: "うみ" },
    { start: source.indexOf("日本語"), end: source.indexOf("日本語") + 3, reading: "にほんご" },
    { start: source.lastIndexOf("海"), end: source.lastIndexOf("海") + 1, reading: "うみ" },
  ];
  const original = estimateLyrics(source, 30);
  const annotated = estimateLyrics(source, 30, spans);
  assert.deepEqual(
    annotated.map(({ time, text }) => ({ time, text })),
    original,
  );
  for (const line of annotated)
    assert.equal(line.parts.map((part) => part.text).join(""), line.text);
  assert.equal(annotated[1].parts[0].text, "𠮷𠮷𠮷 hello ");
  assert.equal(annotated[1].parts[0].reading, null);
});

test("malformed or tag-crossing spans never remove original display text", () => {
  const source = "[00:01]日<00:01.5>本語";
  const result = parseLrc(source, [
    { start: -1, end: 1, reading: "bad" },
    { start: 7, end: source.length, reading: "にほんご" },
  ]);
  assert.equal(result[0].text, "日本語");
  assert.equal(result[0].parts.map((part) => part.text).join(""), "日本語");
  assert(!result[0].parts.some((part) => part.reading));
});

const response = (status, retry_after_seconds = null) => ({
  track_id: "one",
  status,
  retry_after_seconds,
  synced_lyrics: null,
  plain_lyrics: null,
  source_url: null,
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("available original lyrics remain visible while same-track annotations are polled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = { ...response("Available", 5), plain_lyrics: "海" };
  const annotated = {
    ...original,
    retry_after_seconds: null,
    annotated_lyrics: {
      version: "test-v1",
      plain: [{ start: 0, end: 1, reading: "うみ" }],
      synced: [],
    },
  };
  let calls = 0;
  const updates = [];
  const stop = requestLyrics(
    {
      getTrackLyrics: async () => (++calls === 1 ? original : annotated),
    },
    "one",
    (result) => updates.push(result),
  );
  await settle();
  assert.equal(updates[0], original);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(updates[1], annotated);
  t.mock.timers.tick(50_000);
  await settle();
  assert.equal(calls, 2);
  stop();
});

test("pending hints have a conservative minimum, finite budget, and cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const updates = [];
  const stop = requestLyrics(
    {
      getTrackLyrics: async () => {
        calls++;
        return response("Pending", 0);
      },
    },
    "one",
    (...args) => updates.push(args),
  );
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls, 1);
  for (let index = 1; index < 8; index++) {
    t.mock.timers.tick(index === 1 ? 1 : 5000);
    await settle();
  }
  assert.equal(calls, 8);
  assert.match(updates.at(-1)[1], /retries paused/);
  t.mock.timers.tick(100_000);
  await settle();
  assert.equal(calls, 8);
  stop();
});

test("Unavailable honors longer hints and cancels scheduled retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = requestLyrics(
    {
      getTrackLyrics: async () => {
        calls++;
        return response("Unavailable", 60);
      },
    },
    "one",
    () => {},
  );
  await settle();
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls, 2);
  stop();
  t.mock.timers.tick(100_000);
  await settle();
  assert.equal(calls, 2);
});

test("discard canceled responses, stop on older-server errors and time out hung requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve;
  const updates = [];
  const stop = requestLyrics(
    {
      getTrackLyrics: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    "one",
    (...args) => updates.push(args),
  );
  stop();
  resolve(response("Available"));
  await settle();
  assert.equal(updates.length, 0);
  let calls = 0;
  requestLyrics(
    {
      getTrackLyrics: async () => {
        calls++;
        throw new Error("unknown request");
      },
    },
    "one",
    (...args) => updates.push(args),
  );
  await settle();
  assert.match(updates[0][1], /server may not support/);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 1);
  requestLyrics({ getTrackLyrics: () => new Promise(() => {}) }, "one", (...args) =>
    updates.push(args),
  );
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(updates.length, 2);
});

test("obsolete annotations upgrade on the same track and refresh failures retain lyrics", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = {
    ...response("Available", 5),
    plain_lyrics: "海",
    annotated_lyrics: {
      version: "old",
      plain: [{ start: 0, end: 1, reading: "うみ" }],
      synced: [],
    },
  };
  const fresh = {
    ...old,
    retry_after_seconds: null,
    annotated_lyrics: { ...old.annotated_lyrics, version: "new" },
  };
  const updates = [];
  let calls = 0;
  let stop = requestLyrics(
    { getTrackLyrics: async () => (++calls === 1 ? old : fresh) },
    "one",
    (...args) => updates.push(args),
  );
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2);
  assert.equal(updates.at(-1)[0], fresh);
  stop();

  calls = 0;
  stop = requestLyrics(
    {
      getTrackLyrics: async () => {
        if (++calls === 1) return old;
        throw new Error("connection lost");
      },
    },
    "one",
    (...args) => updates.push(args),
  );
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(updates.at(-1)[0], old);
  assert.match(updates.at(-1)[1], /Automatic retries paused/);
  stop();
});
