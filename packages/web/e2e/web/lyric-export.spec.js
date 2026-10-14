import { silentWav } from "../fixtures.js";
import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

async function openLyrics(page) {
  await page.getByRole("button", { name: "Play First Light" }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  return page.getByRole("region", { name: "Track lyrics", exact: true });
}

async function archiveFiles(download) {
  expect(await download.failure()).toBeNull();
  return unzipSync(new Uint8Array(await readFile(await download.path())));
}

test("Export lyrics downloads original audio, UTF-8 sources, timings, ruby and dictionary senses", async ({
  page,
}) => {
  const original = "\uFEFF[offset:-500]\r\n[00:01.250][00:03.500]海 日本語\r\n";
  const plain = "海 日本語\r\n";
  await page.evaluate(
    ({ original, plain }) => {
      const readings = (text) =>
        [...text.matchAll(/海|日本語/g)].map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
          reading: match[0] === "海" ? "うみ" : "にほんご",
          dictionary: {
            lemma: match[0],
            meanings: [
              {
                entry_id: "123",
                reading: "うみ",
                senses: [{ glosses: ["sea"], labels: ["noun"] }],
              },
            ],
            truncated: false,
          },
        }));
      localStorage.setItem(
        "iroh-fm-e2e-lyrics",
        JSON.stringify({
          "track-1": {
            status: "Available",
            plain_lyrics: plain,
            synced_lyrics: original,
            annotated_lyrics: {
              version: "fixture-v1",
              plain: readings(plain),
              synced: readings(original),
            },
            source_url: "https://lrclib.net/api/get/123",
          },
          "track-2": { status: "Available", plain_lyrics: "NOT THIS SONG" },
        }),
      );
    },
    { original, plain },
  );
  const panel = await openLyrics(page);
  await panel.getByRole("checkbox", { name: "Furigana" }).check();
  await expect(panel.locator("ruby").first().locator("rt")).toHaveText("うみ");
  // The UI advance is deliberately not part of original-audio timestamps.
  await panel.getByRole("spinbutton", { name: "Offset (ms)" }).fill("2000");
  const pending = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export lyrics", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("Aurora Unit - First Light-lyrics.zip");
  const files = await archiveFiles(download);
  expect(files["audio.wav"]).toEqual(new Uint8Array(await silentWav().arrayBuffer()));
  expect(files["lyrics.lrc"]).toEqual(new TextEncoder().encode(original));
  expect(files["lyrics.txt"]).toEqual(new TextEncoder().encode(plain));
  const json = JSON.parse(strFromU8(files["lyrics.json"]));
  expect(json.version).toBe(1);
  expect(json.track).toMatchObject({
    id: "track-1",
    title: "First Light",
    artist: "Aurora Unit",
    album: "Test Signals",
    duration_seconds: 20,
  });
  expect(json.lyrics.lines.map((line) => line.time_seconds)).toEqual([1.75, 4]);
  expect(json.lyrics.lines[0].words[0]).toMatchObject({
    surface: "海",
    reading: "うみ",
    dictionary: {
      lemma: "海",
      meanings: [{ entry_id: "123", senses: [{ glosses: ["sea"], labels: ["noun"] }] }],
    },
  });
  expect(strFromU8(files["lyrics.json"])).not.toContain("NOT THIS SONG");
  expect(strFromU8(files["ATTRIBUTION.txt"])).toContain("https://lrclib.net/api/get/123");
  expect(strFromU8(files["ATTRIBUTION.txt"])).toContain("IPADIC");
  expect(strFromU8(files["GUIDE.txt"])).toContain("not lyric translations");
});

test("Export lyrics is disabled while lyrics load and labels absent annotations", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": {
          status: "Available",
          delay: 800,
          plain_lyrics: "海\n歌",
          retry_after_seconds: 5,
        },
      }),
    );
  });
  const panel = await openLyrics(page);
  const button = panel.getByRole("button", { name: "Export lyrics", exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled();
  const pending = page.waitForEvent("download");
  await button.click();
  const files = await archiveFiles(await pending);
  const json = JSON.parse(strFromU8(files["lyrics.json"]));
  expect(json.lyrics.annotation_status).toBe("incomplete");
  expect(json.lyrics.lines.map((line) => line.time_seconds)).toEqual([0, 10]);
  expect(json.lyrics.lines[0].words).toEqual([]);
  expect(json.lyrics.lines[0].timing).toBe("duration_estimate");
  expect(files["lyrics.lrc"]).toBeUndefined();
});

test("Export lyrics recovers from an audio failure and prevents duplicate clicks while fetching", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "web",
    "Web fixture exposes deterministic audio failure and delay controls.",
  );
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": { status: "Available", plain_lyrics: "海" },
      }),
    );
    localStorage.setItem("iroh-fm-e2e-export-delay", "400");
    localStorage.setItem("iroh-fm-e2e-export-error", "Original audio is not available offline.");
  });
  const panel = await openLyrics(page);
  await panel.getByRole("button", { name: "Export lyrics", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Exporting…", exact: true })).toBeDisabled();
  await expect(panel).toContainText(
    "Lyric export failed: Original audio is not available offline.",
  );
  await expect(panel.getByRole("button", { name: "Export lyrics", exact: true })).toBeEnabled();
  await page.evaluate(() => localStorage.removeItem("iroh-fm-e2e-export-error"));
  const pending = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export lyrics", exact: true }).click();
  const files = await archiveFiles(await pending);
  expect(JSON.parse(strFromU8(files["lyrics.json"])).lyrics.annotation_status).toBe("unavailable");
});

test("changing tracks during Export lyrics keeps the original song snapshot", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "web", "Web fixture exposes deterministic audio delay.");
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": { status: "Available", plain_lyrics: "FIRST SONG 海" },
        "track-2": { status: "Available", plain_lyrics: "SECOND SONG 歌" },
      }),
    );
    localStorage.setItem("iroh-fm-e2e-export-delay", "2500");
  });
  const panel = await openLyrics(page);
  const pending = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export lyrics", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Exporting…", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Close lyrics" }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Exporting…", exact: true })).toBeDisabled();
  await expect(panel).toContainText("Exporting First Light");
  await page.getByRole("button", { name: "Next track" }).click();
  await expect(panel.locator("#player-lyrics-description")).toHaveText("Nebula Drift");
  await expect(panel.getByRole("button", { name: "Exporting…", exact: true })).toBeDisabled();
  const download = await pending;
  expect(download.suggestedFilename()).toContain("First Light");
  const files = await archiveFiles(download);
  const json = JSON.parse(strFromU8(files["lyrics.json"]));
  expect(json.track.id).toBe("track-1");
  expect(json.lyrics.sources.plain.text).toBe("FIRST SONG 海");
  expect(files["audio.wav"]).toEqual(new Uint8Array(await silentWav().arrayBuffer()));
});
