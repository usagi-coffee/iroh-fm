import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("plays tracks and navigates forward and backward", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("First Light");
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled();

  await page.getByRole("button", { name: "Next track" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");

  await page.getByRole("button", { name: "Previous track" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("First Light");
});

test("keeps the new album selected when an older Desktop state arrives", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "This exercises Desktop state polling.");

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();

  await page.evaluate(() => {
    globalThis.__IROH_FM_E2E_DESKTOP__.nextPlayerStateDelay = 650;
  });
  await expect
    .poll(
      () => page.evaluate(() => globalThis.__IROH_FM_E2E_METRICS__?.delayedStateCaptured ?? 0),
      { timeout: 2_000 },
    )
    .toBe(1);

  await page.locator('[data-album-id="album-1"] button.bg-mauve').click({ force: true });
  await expect(page).toHaveURL(/\/tracks$/);
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("First Light");

  await page.waitForTimeout(700);
  const selected = page.getByRole("row").filter({ hasText: "First Light" });
  expect(await selected.getAttribute("aria-selected")).toBe("true");
  expect(
    await page.locator("footer").getByTitle("Show currently playing track").first().textContent(),
  ).toBe("First Light");
});

test("selects tracks with arrow keys and starts playback with Enter", async ({ page }) => {
  await page.getByRole("row").first().click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("row").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
});

test("does not restore stale track focus after playing an album", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "web", "The multi-album fixture belongs to the Web client.");

  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "3"));
  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Play Track 001" }).click();
  await page.getByRole("link", { name: "Starred", exact: true }).click();
  await page.getByRole("link", { name: "TRACKS", exact: true }).click();
  await expect(page.locator('[data-track-id="track-1"]')).toHaveAttribute("aria-selected", "true");

  await page.locator('[data-album-id="album-2"] button.bg-mauve').click({ force: true });
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Track 002");
  await page.waitForTimeout(200);
  expect(await page.locator('[data-track-id="track-2"]').getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(await page.locator('[data-track-id="track-1"]').getAttribute("aria-selected")).toBe(
    "false",
  );
});

test("seeks five seconds right and left with the keyboard", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const position = page.getByRole("slider", { name: "Playback position" });
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled();
  const start = Number(await position.inputValue());

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(start + 4);
  const moved = Number(await position.inputValue());

  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await position.inputValue())).toBeLessThan(moved - 4);
});

test("gives lower volumes more slider range", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "android", "Android uses the system volume controls.");
  const volume = page.getByRole("slider", { name: "Volume" });

  await volume.fill("0.5");

  await expect.poll(() => page.evaluate(() => localStorage.getItem("iroh-fm-volume"))).toBe("0.25");
  await expect(volume).toHaveValue("0.5");
});

test("filters tracks by title", async ({ page }) => {
  await page.getByPlaceholder("Filter artist, title, album…").fill("nebula");
  await expect(page).toHaveURL(/\/tracks\?query=nebula$/);
  await expect(page.getByRole("row")).toHaveCount(1);
  await expect(page.getByRole("row")).toContainText("Nebula Drift");
  await expect(page.getByText("First Light", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(1);

  await page.getByPlaceholder("Filter artist, title, album…").press("Enter");
  await expect(page).toHaveURL(/\/tracks$/);
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(page.locator('[data-track-id="track-2"]')).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
});

test("edits client settings through the settings model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "web", "Native clients use platform-owned settings.");

  await page.evaluate(() => {
    localStorage.setItem("iroh-fm-e2e-track-cache-count", "2");
    localStorage.setItem("iroh-fm-e2e-cover-cache-count", "3");
  });
  await page.getByRole("link", { name: "Connection settings" }).click();
  await expect(page.getByRole("heading", { name: "Client settings" })).toBeVisible();

  const relays = page.getByPlaceholder("https://relay.example");
  await expect(relays).toHaveCount(1);
  await page.getByRole("button", { name: "+ ADD RELAY" }).click();
  await expect(relays).toHaveCount(2);

  const memoryCache = page.getByRole("spinbutton", { name: "Memory cache size in MiB" });
  await memoryCache.fill("64");
  await expect(memoryCache).toHaveValue("64");

  await expect(page.getByText("2 · 625 KiB")).toBeVisible();
  await expect(page.getByText("3 · 3.0 KiB")).toBeVisible();

  await page.getByRole("button", { name: "CLEAR TRACKS" }).click();
  await expect(page.getByRole("heading", { name: "Clear offline tracks?" })).toBeVisible();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByText("0 · 0 B")).toBeVisible();
  await expect(page.getByText("3 · 3.0 KiB")).toBeVisible();

  await page.getByRole("button", { name: "CLEAR COVERS" }).click();
  await expect(page.getByRole("heading", { name: "Clear offline covers?" })).toBeVisible();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByText("0 · 0 B")).toHaveCount(2);
});

test("shows resolved album covers immediately after remounting", async ({ page }) => {
  await expect(page.locator('.cover img[alt="Test Signals cover"]').first()).toBeVisible();

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const firstRender = await page
    .locator(".cover")
    .first()
    .evaluate((cover) => ({
      image: Boolean(cover.querySelector("img")),
      fallback: Boolean(cover.querySelector(".cover-fallback")),
    }));

  expect(firstRender).toEqual({ image: true, fallback: false });
});

test("keeps album scrolling stable and centers a selected album track", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "web",
    "The large-library fixture belongs to the Web client.",
  );
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const albumViewport = page.locator("[data-album-library] [data-virtual-viewport]");
  await page.waitForTimeout(250);
  await albumViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight / 2));
  await expect(page.locator("[data-album-id]").first()).toBeVisible();
  await page.waitForTimeout(100);

  const positions = await albumViewport.evaluate(async (viewport) => {
    const values = [];
    for (let sample = 0; sample < 10; sample += 1) {
      values.push(viewport.scrollTop);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return values;
  });
  expect(positions[0]).toBeGreaterThan(100);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);

  const albumCard = page.locator("[data-album-id]").nth(2);
  const albumId = await albumCard.getAttribute("data-album-id");
  await albumCard.locator("button.bg-mauve").click({ force: true });
  await expect(page).toHaveURL(/\/tracks$/);

  const trackId = albumId?.replace("album-", "track-");
  const target = page.locator(`[data-track-id="${trackId}"]`);
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((row) => {
        const viewport = row.closest("[data-virtual-viewport]");
        if (!(viewport instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
        const viewportRect = viewport.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return Math.abs(
          rowRect.top + rowRect.height / 2 - (viewportRect.top + viewportRect.height / 2),
        );
      }),
    )
    .toBeLessThan(2);
});

test("keeps track positions stable when reversing a deep scroll", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop",
    "The Desktop fixture does not expose the generated large library.",
  );
  await page.setViewportSize({ width: 412, height: 915 });
  await page.evaluate(() => {
    localStorage.setItem("iroh-fm-e2e-album-count", "500");
    localStorage.setItem("iroh-fm-e2e-cover-delay", "1000");
  });
  await page.reload();
  await expect(page.getByText("500 / 500", { exact: true })).toBeVisible();

  const viewport = page.locator("section.bg-base [data-virtual-viewport]");
  await viewport.hover();
  await page.mouse.wheel(0, 16_000);
  await page.waitForTimeout(200);
  const initialScrollTop = await viewport.evaluate((element) => element.scrollTop);
  expect(initialScrollTop).toBeGreaterThan(10_000);
  let previousScrollTop = initialScrollTop;
  const positions = new Map();
  for (const delta of [-1400, -1400, -1400, ...Array(40).fill(-20)]) {
    await page.mouse.wheel(0, delta);
    // Let covers start loading while continuing to move the render window.
    await page.waitForTimeout(170);
    const sample = await viewport.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll("[data-list-index]")];
      return {
        scrollTop: element.scrollTop,
        topGap: rows[0].getBoundingClientRect().top - rect.top,
        bottomGap: rect.bottom - rows.at(-1).getBoundingClientRect().bottom,
        positions: rows.map((row) => [
          Number(row.getAttribute("data-list-index")),
          row.getBoundingClientRect().top - rect.top + element.scrollTop,
        ]),
      };
    });
    expect(sample.scrollTop).toBeLessThanOrEqual(previousScrollTop);
    previousScrollTop = sample.scrollTop;
    expect(sample.topGap).toBeLessThanOrEqual(0);
    expect(sample.bottomGap).toBeLessThanOrEqual(0);
    for (const [index, position] of sample.positions) {
      if (positions.has(index)) expect(Math.abs(position - positions.get(index))).toBeLessThan(1);
      positions.set(index, position);
    }
  }
  expect(previousScrollTop).toBeLessThan(initialScrollTop - 4500);
});

test("allows virtualized track and album lists to reach their bottom edge", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop",
    "The Desktop fixture does not expose the generated large library.",
  );
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.hover();
  await page.mouse.wheel(0, 100_000);
  await expect(page.locator('[data-track-id="track-120"]')).toBeVisible();
  await expect.poll(() => distanceFromBottom(trackViewport)).toBeLessThan(1);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const albumViewport = page.locator("[data-album-library] [data-virtual-viewport]");
  await albumViewport.hover();
  await page.mouse.wheel(0, 100_000);
  await expect(page.locator('[data-album-id="album-120"]')).toBeVisible();
  await expect.poll(() => distanceFromBottom(albumViewport)).toBeLessThan(1);
  expect(await outwardTouchMovePrevented(albumViewport)).toBe(true);
  await albumViewport.evaluate(
    (element) => (element.scrollTop = element.scrollHeight - element.clientHeight - 1),
  );
  await expect.poll(() => finalVirtualRowOverflow(albumViewport)).toBeLessThanOrEqual(0);
  await expect.poll(() => uniformVirtualStrideError(albumViewport, 120)).toBeLessThan(0.1);
  const settledPosition = await albumViewport.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(1_200);
  expect(
    Math.abs((await albumViewport.evaluate((element) => element.scrollTop)) - settledPosition),
  ).toBeLessThan(1);
});

test("centers the playing album without shifting after navigation", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "web",
    "The large-library fixture belongs to the Web client.",
  );
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const albumViewport = page.locator("[data-virtual-viewport]").last();
  await albumViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight / 2));
  await expect
    .poll(() => albumViewport.evaluate((viewport) => viewport.scrollTop))
    .toBeGreaterThan(100);
  const albumCard = page.locator("[data-album-id]").nth(2);
  await expect(albumCard).toBeVisible();
  const albumId = await albumCard.getAttribute("data-album-id");
  await albumCard.locator("button.bg-mauve").click({ force: true });
  const trackNumber = albumId?.replace("album-", "").padStart(3, "0");
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText(`Track ${trackNumber}`);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const playingAlbum = page.locator(`[data-album-id="${albumId}"]`);
  await expect(playingAlbum).toBeVisible();
  const offsets = await playingAlbum.evaluate(async (album) => {
    const values = [];
    for (let sample = 0; sample < 10; sample += 1) {
      const viewport = album.closest("[data-virtual-viewport]");
      if (!(viewport instanceof HTMLElement)) throw new Error("Album viewport not found");
      const viewportRect = viewport.getBoundingClientRect();
      const albumRect = album.getBoundingClientRect();
      values.push(
        albumRect.top + albumRect.height / 2 - (viewportRect.top + viewportRect.height / 2),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return values;
  });
  expect(Math.abs(offsets.at(-1))).toBeLessThan(15);
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(1);

  await page.getByRole("link", { name: "TRACKS", exact: true }).click();
  const sidebarPlayingAlbum = page.locator(`[data-album-id="${albumId}"]`);
  await expect(sidebarPlayingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(sidebarPlayingAlbum)).toBeLessThan(15);
});

test("centers the sidebar for explicit track and album-header play clicks", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "web", "The sidebar is visible in the Web test viewport.");
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.6));
  await expect
    .poll(() => trackViewport.evaluate((viewport) => viewport.scrollTop))
    .toBeGreaterThan(1_000);
  const visibleTrack = trackViewport.locator("[data-track-id]").nth(2);
  await expect(visibleTrack).toBeVisible();
  const trackId = await visibleTrack.getAttribute("data-track-id");
  await visibleTrack.getByRole("button", { name: /^Play / }).click();

  const playingAlbum = page.locator(`[data-album-id="${trackId?.replace("track-", "album-")}"]`);
  await expect(playingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(playingAlbum)).toBeLessThan(15);

  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.25));
  const albumHeader = trackViewport.locator('button[aria-label^="Play album "]').nth(2);
  await expect(albumHeader).toBeVisible();
  const albumLabel = await albumHeader.getAttribute("aria-label");
  const albumNumber = Number(albumLabel?.match(/(\d{3})$/)?.[1]);
  await albumHeader.click();

  const headerAlbum = page.locator(`[data-album-id="album-${albumNumber}"]`);
  await expect(headerAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(headerAlbum)).toBeLessThan(15);
});

test("centers album navigation on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "android", "This exercises the mobile native player.");
  await page.evaluate(() => {
    localStorage.setItem("iroh-fm-e2e-album-count", "120");
    localStorage.setItem("iroh-fm-album-column-adjustment", "-1");
  });
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.6));
  await expect
    .poll(() => trackViewport.evaluate((viewport) => viewport.scrollTop))
    .toBeGreaterThan(1_000);
  const visibleTrack = trackViewport.locator("[data-track-id]").nth(2);
  await expect(visibleTrack).toBeVisible();
  const trackId = await visibleTrack.getAttribute("data-track-id");
  const trackNumber = trackId?.replace("track-", "").padStart(3, "0");
  await visibleTrack.getByRole("button", { name: /^Play / }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText(`Track ${trackNumber}`);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const playingAlbum = page.locator(`[data-album-id="${trackId?.replace("track-", "album-")}"]`);
  await expect(playingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(playingAlbum)).toBeLessThan(15);
});

test("lyrics toggle reserves space above the player and follows forward/backward seeks", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": {
          status: "Available",
          synced_lyrics: Array.from(
            { length: 40 },
            (_, index) =>
              `[00:${String(Math.floor(index / 2)).padStart(2, "0")}.${index % 2 ? "5" : "0"}]日本語 ${index}`,
          ).join("\n"),
          source_url: "https://lrclib.net/",
        },
      }),
    );
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => lyricsCalls(page)).toEqual(["track-1"]);
  const toggle = page.getByRole("button", { name: "Lyrics", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  const viewport = page.getByRole("region", { name: "Scrollable lyrics" });
  await expect(panel.getByRole("link", { name: "LRCLIB" })).toHaveAttribute(
    "href",
    "https://lrclib.net/",
  );
  const geometry = await panel.evaluate((element) => {
    const footer = document.querySelector("footer");
    const main = document.querySelector("main");
    const viewport = element.querySelector("[data-lyrics-scroll]");
    const row = element.querySelector("[data-lyric-index]");
    return {
      panelBottom: element.getBoundingClientRect().bottom,
      panelTop: element.getBoundingClientRect().top,
      footerTop: footer.getBoundingClientRect().top,
      mainBottom: main.getBoundingClientRect().bottom,
      rows: viewport.clientHeight / row.getBoundingClientRect().height,
    };
  });
  expect(Math.abs(geometry.panelBottom - geometry.footerTop)).toBeLessThan(1);
  expect(Math.abs(geometry.mainBottom - geometry.panelTop)).toBeLessThan(1);
  expect(geometry.rows).toBeGreaterThanOrEqual(3);
  expect(Math.floor(geometry.rows)).toBeLessThanOrEqual(4);
  await expect(page.getByRole("button", { name: "Next track" })).toBeInViewport();

  const position = page.getByRole("slider", { name: "Playback position" });
  await position.fill("15");
  await expect(panel.locator('[data-lyric-index="30"]')).toHaveAttribute("aria-current", "true");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await position.fill("2");
  await expect(panel.locator('[data-lyric-index="4"]')).toHaveAttribute("aria-current", "true");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(200);
  await panel.getByRole("spinbutton", { name: "Offset" }).fill("1");
  await expect(panel.locator('[data-lyric-index="6"]')).toHaveAttribute("aria-current", "true");
  await panel.getByRole("button", { name: "Close lyrics" }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("lyrics follow seeks before the first timestamp and respect manual scrolling", async ({
  page,
}) => {
  await prepareTimedLyrics(page);
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  const viewport = page.getByRole("region", { name: "Scrollable lyrics" });
  const position = page.getByRole("slider", { name: "Playback position" });
  await position.fill("17");
  await expect(panel.locator('[data-lyric-index="30"]')).toHaveAttribute("aria-current", "true");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await position.fill("0");
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);

  await position.fill("17");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await panel.getByRole("checkbox", { name: "Follow playback" }).uncheck();
  await position.fill("0");
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await panel.getByRole("checkbox", { name: "Follow playback" }).check();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
});

test("lyrics controls retain native keyboard behavior without invoking library shortcuts", async ({
  page,
}) => {
  await prepareTimedLyrics(page);
  const toggle = page.getByRole("button", { name: "Lyrics", exact: true });
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  const viewport = page.getByRole("region", { name: "Scrollable lyrics" });
  const position = page.getByRole("slider", { name: "Playback position" });
  await position.fill("17");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[data-track-id="track-2"]')).toHaveAttribute("aria-selected", "true");
  const follow = panel.getByRole("checkbox", { name: "Follow playback" });
  await follow.focus();
  await page.keyboard.press("Space");
  await expect(follow).not.toBeChecked();
  await viewport.focus();
  const scroll = await viewport.evaluate((element) => element.scrollTop);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scroll);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await page.keyboard.press("x");
  await expect(position).toHaveValue("17");
  await expect(page.locator('[data-track-id="track-2"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.getByPlaceholder("Filter artist, title, album…")).toHaveValue("");
  await expect(
    page.locator("footer").getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  const close = panel.getByRole("button", { name: "Close lyrics" });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await close.focus();
  await page.keyboard.press("Space");
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(
    page.locator("footer").getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();

  // Library shortcuts still work when focus returns to the library.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowUp");
  await expect(page.locator('[data-track-id="track-1"]')).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
});

for (const viewport of [
  { width: 393, height: 851, minimumRows: 3 },
  { width: 851, height: 393, minimumRows: 2 },
]) {
  test(`lyrics stay compact and keep the library/player visible at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await prepareTimedLyrics(page);
    const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
    const geometry = await panel.evaluate((element) => {
      const footer = document.querySelector("footer").getBoundingClientRect();
      const main = document.querySelector("main");
      const scroll = element.querySelector("[data-lyrics-scroll]");
      const row = element.querySelector("[data-lyric-index]").getBoundingClientRect();
      const panel = element.getBoundingClientRect();
      return {
        rows: scroll.clientHeight / row.height,
        panelHeight: panel.height,
        panelTop: panel.top,
        panelBottom: panel.bottom,
        mainHeight: main.clientHeight,
        mainBottom: main.getBoundingClientRect().bottom,
        footerTop: footer.top,
        footerBottom: footer.bottom,
        windowHeight: window.innerHeight,
      };
    });
    expect(geometry.rows).toBeGreaterThanOrEqual(viewport.minimumRows);
    expect(geometry.rows).toBeLessThanOrEqual(4);
    expect(geometry.panelHeight).toBeLessThanOrEqual(240);
    expect(geometry.mainHeight).toBeGreaterThanOrEqual(40);
    expect(Math.abs(geometry.mainBottom - geometry.panelTop)).toBeLessThan(1);
    expect(Math.abs(geometry.panelBottom - geometry.footerTop)).toBeLessThan(1);
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.windowHeight);
    await expect(panel.getByRole("button", { name: "Close lyrics" })).toBeInViewport();
    await expect(panel.getByRole("spinbutton", { name: "Offset" })).toBeInViewport();
    await expect(panel.getByRole("link", { name: "LRCLIB" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Next track" })).toBeInViewport();
  });
}

test("Retry lyrics recovers after a failed request without restarting playback", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": [
          { error: "connection interrupted" },
          { status: "Available", synced_lyrics: "[00:00]Recovered lyrics" },
        ],
      }),
    );
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  await expect(panel).toContainText("Lyrics unavailable.");
  await expect.poll(() => lyricsCalls(page)).toEqual(["track-1"]);
  await panel.getByRole("button", { name: "Retry lyrics" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Recovered lyrics");
  await expect(panel.getByRole("button", { name: "Retry lyrics" })).toHaveCount(0);
  expect(await lyricsCalls(page)).toEqual(["track-1", "track-1"]);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("First Light");
});

async function prepareTimedLyrics(page) {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": {
          status: "Available",
          synced_lyrics: Array.from(
            { length: 40 },
            (_, index) =>
              `[00:${String(2 + Math.floor(index / 2)).padStart(2, "0")}.${index % 2 ? "5" : "0"}]日本語 ${index}`,
          ).join("\n"),
          source_url: "https://lrclib.net/",
        },
      }),
    );
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  await expect(page.locator('[data-lyric-index="39"]')).toBeAttached();
}

for (const { plain, width, height } of [false, true].flatMap((plain) => [
  { plain, width: 393, height: 851 },
  { plain, width: 851, height: 393 },
])) {
  test(`automatic furigana toggles word ruby and follows ${plain ? "estimated" : "timed"} lines at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.evaluate((plain) => {
      const source = Array.from(
        { length: 40 },
        (_, index) =>
          `${plain ? "" : `[00:${String(Math.floor(index / 2)).padStart(2, "0")}.${index % 2 ? "5" : "0"}]`}海！ hello 𠮷𠮷𠮷 日本語 ${index}`,
      ).join("\r\n");
      const spans = [...source.matchAll(/海|日本語/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        reading: match[0] === "海" ? "うみ" : "にほんご",
      }));
      localStorage.setItem(
        "iroh-fm-e2e-lyrics",
        JSON.stringify({
          "track-1": {
            status: "Available",
            [plain ? "plain_lyrics" : "synced_lyrics"]: source,
            annotated_lyrics: {
              version: "test-v1",
              plain: plain ? spans : [],
              synced: plain ? [] : spans,
            },
          },
        }),
      );
    }, plain);
    await page.getByRole("button", { name: "Play First Light" }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Lyrics", exact: true }).click();
    const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
    const toggle = panel.getByRole("checkbox", { name: "Furigana" });
    await expect(toggle).not.toBeChecked();
    await expect(panel.locator("ruby")).toHaveCount(0);
    await expect(panel.locator('[data-lyric-index="0"]')).toHaveText("海！ hello 𠮷𠮷𠮷 日本語 0");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(panel.locator("ruby")).toHaveCount(80);
    const ruby = panel.locator("ruby").first();
    await expect(ruby).toHaveAttribute("lang", "ja");
    await expect(ruby.locator("rt")).toHaveText("うみ");
    const layout = await ruby.evaluate((element) => {
      const reading = element.querySelector("rt").getBoundingClientRect();
      const base = document.createRange();
      base.selectNode(element.firstChild);
      const rect = base.getBoundingClientRect();
      const panel = document.querySelector("#player-lyrics");
      const scroll = panel.querySelector("[data-lyrics-scroll]");
      const footer = document.querySelector("footer");
      return {
        // Font line boxes overlap in native ruby even when the glyphs don't.
        above: reading.top < rect.top && reading.bottom < rect.bottom,
        size: reading.height < rect.height,
        height: panel.clientHeight,
        rows: scroll.clientHeight / element.closest("p").clientHeight,
        anchored:
          Math.abs(panel.getBoundingClientRect().bottom - footer.getBoundingClientRect().top) < 1,
      };
    });
    expect(layout.above).toBe(true);
    expect(layout.size).toBe(true);
    expect(layout.height).toBeLessThanOrEqual(240);
    expect(layout.rows).toBeGreaterThanOrEqual(2);
    expect(layout.anchored).toBe(true);
    if (plain) await expect(panel).toContainText("Estimated scrolling");
    const position = page.getByRole("slider", { name: "Playback position" });
    await position.fill("16");
    const current = panel.locator('[aria-current="true"]').last();
    await expect(current).toBeInViewport();
    const scroll = panel.locator("[data-lyrics-scroll]");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(400);
    await toggle.uncheck();
    await expect(panel.locator("ruby")).toHaveCount(0);
    await expect(current).toBeInViewport();
    await position.fill("0");
    await expect(panel.locator('[data-lyric-index="0"]')).toHaveAttribute("aria-current", "true");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(50);
    await expect(page.getByRole("button", { name: "Next track" })).toBeInViewport();
  });
}

test.describe("optional dictionary meanings above kanji furigana", () => {
  test.use({ hasTouch: true });
  for (const { plain, width, height } of [false, true].flatMap((plain) => [
    { plain, width: 393, height: 851 },
    { plain, width: 851, height: 393 },
  ])) {
    test(`stacked meanings preserve ${plain ? "estimated" : "timed"} lyrics at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.evaluate((plain) => {
        const source = Array.from(
          { length: 40 },
          (_, index) =>
            `${plain ? "" : `[00:${String(Math.floor(index / 2)).padStart(2, "0")}.${index % 2 ? "5" : "0"}]`}😀食べた！ 海 かな 太郎 歌 ${index}`,
        ).join("\r\n");
        const spans = [...source.matchAll(/食べ|海|太郎|歌/g)].map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
          reading: { 食べ: "たべ", 海: "うみ", 太郎: "たろう", 歌: "うた" }[match[0]],
          ...(match[0] === "歌"
            ? {}
            : {
                dictionary: {
                  lemma: match[0] === "食べ" ? "食べる" : match[0],
                  meanings:
                    match[0] === "太郎"
                      ? []
                      : [
                          {
                            entry_id: match[0] === "食べ" ? "1358280" : "1195800",
                            reading: match[0] === "食べ" ? "たべる" : "うみ",
                            senses: [
                              {
                                glosses: [
                                  match[0] === "食べ" ? "to eat" : "sea",
                                  "another dictionary gloss",
                                ],
                                labels: ["noun or verb"],
                              },
                              { glosses: ["another sense"], labels: [] },
                            ],
                          },
                        ],
                  truncated: false,
                },
              }),
        }));
        localStorage.setItem(
          "iroh-fm-e2e-lyrics",
          JSON.stringify({
            "track-1": {
              status: "Available",
              [plain ? "plain_lyrics" : "synced_lyrics"]: source,
              annotated_lyrics: {
                version: "meanings-test-v1",
                plain: plain ? spans : [],
                synced: plain ? [] : spans,
              },
            },
            "track-2": {
              status: "Available",
              synced_lyrics: "[00:00]Second track without meanings",
            },
          }),
        );
      }, plain);
      await page.getByRole("button", { name: "Play First Light" }).click();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("button", { name: "Lyrics", exact: true }).click();
      const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
      const rubyToggle = panel.getByRole("checkbox", { name: "Furigana" });
      const meaningsToggle = panel.getByRole("checkbox", { name: "Meanings (dictionary)" });
      await expect(meaningsToggle).toBeDisabled();
      await expect(meaningsToggle).not.toBeChecked();
      await rubyToggle.tap();
      await expect(meaningsToggle).toBeEnabled();
      await expect(panel.locator("[data-lyric-meaning]")).toHaveCount(0);
      await meaningsToggle.focus();
      await page.keyboard.press("Space");
      await expect(meaningsToggle).toBeChecked();
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
      await expect(panel.locator("[data-lyric-meaning]")).toHaveCount(80);
      await expect(panel.locator("[data-lyric-meaning]").first()).toHaveText("to eat / …");
      const first = panel.locator('[data-lyric-index="0"]');
      await expect(first.locator("ruby").nth(2).locator("[data-lyric-meaning]")).toHaveCount(0);
      await expect(first.locator("ruby").nth(2)).toHaveAttribute("title", /No JMdict match/);
      await expect(first.locator("ruby").nth(3)).toHaveAttribute("title", /unavailable/);
      await expect(first.locator("ruby").first()).toHaveAttribute(
        "title",
        /食べる.*not a lyric translation.*another sense/,
      );
      await expect(panel).toContainText("Automatic dictionary senses, not lyric translation");
      await expect(panel.getByRole("link", { name: "JMdict / EDRDG" })).toHaveAttribute(
        "href",
        "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project",
      );
      const layout = await first
        .locator("ruby")
        .first()
        .evaluate((element) => {
          const meaning = element.querySelector("[data-lyric-meaning]").getBoundingClientRect();
          const reading = element.querySelector("[data-lyric-reading]").getBoundingClientRect();
          const range = document.createRange();
          range.selectNode(element.firstChild);
          const base = range.getBoundingClientRect();
          const panel = document.querySelector("#player-lyrics");
          const scroll = panel.querySelector("[data-lyrics-scroll]");
          return {
            above: meaning.top < reading.top && reading.top < base.top,
            meaningSmall: meaning.height < base.height,
            readingSmall: reading.height < base.height,
            viewport: scroll.clientHeight,
            noOverflow: document.documentElement.scrollWidth <= innerWidth,
          };
        });
      expect(layout.above).toBe(true);
      expect(layout.meaningSmall).toBe(true);
      expect(layout.readingSmall).toBe(true);
      expect(layout.viewport).toBeGreaterThan(40);
      expect(layout.noOverflow).toBe(true);
      expect(
        await first.evaluate((element) =>
          [...element.childNodes]
            .map((node) =>
              node.nodeName === "RUBY" ? node.firstChild.textContent : node.textContent,
            )
            .join("")
            .trim(),
        ),
      ).toBe("😀食べた！ 海 かな 太郎 歌 0");
      const position = page.getByRole("slider", { name: "Playback position" });
      await position.fill("16");
      const current = panel.locator('[aria-current="true"]').last();
      await expect(current).toBeInViewport();
      await meaningsToggle.tap();
      await expect(panel.locator("[data-lyric-meaning]")).toHaveCount(0);
      await expect(panel.locator("ruby")).toHaveCount(160);
      await expect(current).toBeInViewport();
      await meaningsToggle.tap();
      await rubyToggle.tap();
      await expect(meaningsToggle).toBeDisabled();
      await expect(panel.locator("ruby")).toHaveCount(0);
      await expect(current).toBeInViewport();
      await rubyToggle.tap();
      await expect(panel.locator("[data-lyric-meaning]")).toHaveCount(80);
      await position.fill("0");
      await expect(first).toBeInViewport();
      await page.getByRole("button", { name: "Next track" }).click();
      await expect(panel).toContainText("Second track without meanings");
      await expect(panel.locator("[data-lyric-meaning]")).toHaveCount(0);
      await expect(meaningsToggle).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Next track" })).toBeInViewport();
    });
  }
});

test("lazy furigana upgrades arrive during the same playback without hiding cached lyrics", async ({
  page,
}) => {
  await page.evaluate(() => {
    const original = {
      status: "Available",
      synced_lyrics: "[00:00]海の歌",
      retry_after_seconds: 5,
    };
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": [
          original,
          {
            ...original,
            retry_after_seconds: null,
            annotated_lyrics: {
              version: "test-v1",
              plain: [],
              synced: [{ start: 7, end: 8, reading: "うみ" }],
            },
          },
        ],
      }),
    );
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  await expect(panel.locator('[data-lyric-index="0"]')).toHaveText("海の歌");
  const toggle = panel.getByRole("checkbox", { name: "Furigana" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toBeEnabled({ timeout: 10_000 });
  await toggle.check();
  await expect(panel.locator("rt")).toHaveText("うみ");
  expect(await lyricsCalls(page)).toEqual(["track-1", "track-1"]);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
});

test("annotation retry exhaustion keeps original lyrics and allows a manual same-track upgrade", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": { status: "Available", synced_lyrics: "[00:00]海", retry_after_seconds: 5 },
      }),
    );
  });
  await page.clock.install();
  await page.getByRole("button", { name: "Play First Light" }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  for (let attempt = 1; attempt < 8; attempt++) {
    await page.clock.fastForward(5000);
    await expect.poll(async () => (await lyricsCalls(page)).length).toBe(attempt + 1);
  }
  await expect(panel).toContainText("Automatic retries paused");
  await expect(panel.locator('[data-lyric-index="0"]')).toHaveText("海");
  await page.clock.fastForward(60_000);
  expect((await lyricsCalls(page)).length).toBe(8);
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": {
          status: "Available",
          synced_lyrics: "[00:00]海",
          annotated_lyrics: {
            version: "test-v1",
            plain: [],
            synced: [{ start: 7, end: 8, reading: "うみ" }],
          },
        },
      }),
    );
  });
  await panel.getByRole("button", { name: "Retry lyrics" }).click();
  await panel.getByRole("checkbox", { name: "Furigana" }).check();
  await expect(panel.locator("rt")).toHaveText("うみ");
  await expect(panel.getByRole("button", { name: "Retry lyrics" })).toHaveCount(0);
});

test("lyrics discard stale track responses and label plain scrolling as estimated", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": { status: "Available", synced_lyrics: "[00:00]STALE LYRICS", delay: 1200 },
        "track-2": { status: "Available", plain_lyrics: "海の歌\n日本語のまま\n最後の行" },
        "track-3": { error: "unknown request GetTrackLyrics" },
      }),
    );
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  await expect.poll(() => lyricsCalls(page)).toEqual(["track-1"]);
  await page.getByRole("button", { name: "Next track" }).click();
  const panel = page.getByRole("region", { name: "Track lyrics", exact: true });
  await expect(panel.locator("#player-lyrics-description")).toHaveText("Nebula Drift");
  await expect(panel).toContainText(
    "Estimated scrolling · plain text, duration-based approximation",
  );
  await expect(panel).toContainText("日本語のまま");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("slider", { name: "Playback position" }).fill("10");
  await expect(panel.locator('[data-lyric-index="1"]')).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(1300);
  await expect(panel).not.toContainText("STALE LYRICS");
  await page.getByRole("button", { name: "Next track" }).click();
  await expect(panel).toContainText("Lyrics unavailable. The server may not support lyrics");
  await expect(panel.locator("[data-lyric-index]")).toHaveCount(0);
  expect(await lyricsCalls(page)).toEqual(["track-1", "track-2", "track-3"]);
});

for (const [status, message] of [
  ["NotFound", "No lyrics found for this track."],
  ["Instrumental", "Instrumental track. No sung lyrics."],
  ["Unavailable", "Lyrics temporarily unavailable."],
]) {
  test(`lyrics show ${status} distinctly`, async ({ page }) => {
    await page.evaluate((status) => {
      localStorage.setItem("iroh-fm-e2e-lyrics", JSON.stringify({ "track-1": { status } }));
    }, status);
    await page.getByRole("button", { name: "Play First Light" }).click();
    await page.getByRole("button", { name: "Lyrics", exact: true }).click();
    await expect(page.getByRole("region", { name: "Track lyrics", exact: true })).toContainText(
      message,
    );
  });
}

test("lyrics poll Pending using the server retry hint, not on every toggle", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": [
          { status: "Pending", retry_after_seconds: 7 },
          { status: "Available", synced_lyrics: "[00:00]Ready lyrics" },
        ],
      }),
    );
  });
  await page.clock.install();
  await page.getByRole("button", { name: "Play First Light" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Lyrics", exact: true });
  await toggle.click();
  await expect(page.getByRole("region", { name: "Track lyrics", exact: true })).toContainText(
    "Looking for lyrics…",
  );
  await toggle.click();
  await toggle.click();
  expect(await lyricsCalls(page)).toEqual(["track-1"]);
  await page.clock.fastForward(6000);
  expect(await lyricsCalls(page)).toEqual(["track-1"]);
  await page.clock.fastForward(1000);
  await expect(page.getByRole("region", { name: "Track lyrics", exact: true })).toContainText(
    "Ready lyrics",
  );
  expect(await lyricsCalls(page)).toEqual(["track-1", "track-1"]);
});

test("lyrics requests stop when disconnecting or unmounting the player", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "iroh-fm-e2e-lyrics",
      JSON.stringify({
        "track-1": { status: "Pending", retry_after_seconds: 5 },
      }),
    );
  });
  await page.clock.install();
  await page.getByRole("button", { name: "Play First Light" }).click();
  await expect.poll(() => lyricsCalls(page)).toEqual(["track-1"]);
  await page.getByRole("link", { name: "Connection settings" }).click();
  await page.getByLabel("Server endpoint ID").fill("e2e-new-server");
  await page.getByLabel("Relay URLs").fill("https://relay.example");
  await page.getByRole("button", { name: "SAVE & RECONNECT" }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.clock.fastForward(10_000);
  expect(await lyricsCalls(page)).toEqual(["track-1"]);
});

async function lyricsCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("iroh-fm-e2e-lyrics-calls") ?? "[]"));
}

/** @param {import('@playwright/test').Locator} album */
async function albumCenterOffset(album) {
  return album.evaluate((element) => {
    const viewport = element.closest("[data-virtual-viewport]");
    if (!(viewport instanceof HTMLElement)) throw new Error("Album viewport not found");
    const viewportRect = viewport.getBoundingClientRect();
    const albumRect = element.getBoundingClientRect();
    return Math.abs(
      albumRect.top + albumRect.height / 2 - (viewportRect.top + viewportRect.height / 2),
    );
  });
}

/** @param {import('@playwright/test').Locator} viewport */
async function distanceFromBottom(viewport) {
  return viewport.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

/** @param {import('@playwright/test').Locator} viewport */
async function finalVirtualRowOverflow(viewport) {
  return viewport.evaluate((element) => {
    const renderedRows = element.firstElementChild?.firstElementChild;
    const finalRow = renderedRows?.lastElementChild;
    if (!(finalRow instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    return finalRow.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
  });
}

/** @param {import('@playwright/test').Locator} viewport */
async function outwardTouchMovePrevented(viewport) {
  return viewport.evaluate((element) => {
    const touch = (identifier, clientY) =>
      new Touch({ identifier, target: element, clientX: 20, clientY });
    const start = touch(1, 200);
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [start],
        changedTouches: [start],
      }),
    );
    const moved = touch(1, 100);
    const accepted = element.dispatchEvent(
      new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        changedTouches: [moved],
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        changedTouches: [moved],
      }),
    );
    return !accepted;
  });
}

/**
 * @param {import('@playwright/test').Locator} viewport
 * @param {number} albumCount
 */
async function uniformVirtualStrideError(viewport, albumCount) {
  return viewport.evaluate((element, count) => {
    const rows = element.querySelectorAll("[data-virtual-index]");
    const first = rows[0];
    const second = rows[1];
    const spacer = element.firstElementChild;
    const group = spacer?.firstElementChild;
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement) || !group || !spacer)
      return Number.POSITIVE_INFINITY;
    const columnsLabel = element.closest("section")?.querySelector('[title$="album columns"]');
    const columns = Number.parseInt(columnsLabel?.getAttribute("title") ?? "", 10);
    const firstIndex = Number(first.dataset.virtualIndex);
    const stride = second.getBoundingClientRect().top - first.getBoundingClientRect().top;
    const transform = new DOMMatrixReadOnly(getComputedStyle(group).transform).m42;
    const padding = transform - firstIndex * stride;
    const expectedHeight = padding * 2 + Math.ceil(count / columns) * stride;
    return Math.abs(spacer.getBoundingClientRect().height - expectedHeight);
  }, albumCount);
}
