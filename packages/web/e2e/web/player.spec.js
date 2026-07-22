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
  await page.getByRole("link", { name: "STARRED", exact: true }).click();
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

test("filters tracks by title", async ({ page }) => {
  await page.getByPlaceholder("Filter artist, title, album…").fill("nebula");
  await expect(page).toHaveURL(/\/tracks\?query=nebula$/);
  await expect(page.getByRole("row")).toHaveCount(1);
  await expect(page.getByRole("row")).toContainText("Nebula Drift");
  await expect(page.getByText("First Light", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(1);
});

test("edits client settings through the settings model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "web", "Native clients use platform-owned settings.");

  await page.getByRole("link", { name: "Connection settings" }).click();
  await expect(page.getByRole("heading", { name: "Client settings" })).toBeVisible();

  const relays = page.getByPlaceholder("https://relay.example");
  await expect(relays).toHaveCount(1);
  await page.getByRole("button", { name: "+ ADD RELAY" }).click();
  await expect(relays).toHaveCount(2);

  const memoryCache = page.getByRole("spinbutton", { name: "Memory cache size in MiB" });
  await memoryCache.fill("64");
  await expect(memoryCache).toHaveValue("64");
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
  const albumViewport = page.locator("[data-virtual-viewport]");
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
});
