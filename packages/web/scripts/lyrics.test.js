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
