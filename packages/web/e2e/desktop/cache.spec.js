import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("marks the desktop-prefetched next track in the memory cache", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const nextTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });
  await expect(nextTrack.locator('[title="In memory cache"]')).toBeVisible();
  await expect(nextTrack.locator('[title="In memory cache"]')).toHaveClass(/text-peach/);
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__IROH_FM_E2E_METRICS__?.downloads?.["track-2"] ?? 0),
    )
    .toBe(1);

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__IROH_FM_E2E_METRICS__?.downloads?.["track-2"] ?? 0),
    )
    .toBe(1);
});

test("does not show download progress while reopening an LRU-cached track", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const firstTrack = page.getByRole("row").filter({ hasText: "First Light" });
  const secondTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });
  await expect(secondTrack.locator('[title="In memory cache"]')).toBeVisible();

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  await expect(firstTrack.locator('[title="In memory cache"]')).toBeVisible();
  await page.evaluate(() => {
    globalThis.__IROH_FM_E2E_DESKTOP__.memoryCacheHitDelay = 500;
  });

  await page.getByRole("button", { name: "Play First Light" }).click();
  const playerButton = page.locator("footer").getByRole("button", { name: "Loading" });
  await expect(playerButton).toBeVisible();
  await expect(playerButton).not.toContainText("%");
});

test("clears the orange marker when Desktop evicts an LRU track", async ({ page }) => {
  await page.evaluate(() => {
    globalThis.__IROH_FM_E2E_DESKTOP__.maxMemoryTracks = 1;
  });
  await page.getByRole("button", { name: "Play First Light" }).click();
  const firstTrack = page.getByRole("row").filter({ hasText: "First Light" });
  const secondTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });

  await expect(secondTrack.locator('[title="In memory cache"]')).toBeVisible();
  await expect(firstTrack.locator('[title="In memory cache"]')).toHaveCount(0);
});

test("clears the Desktop offline track cache from settings", async ({ page }) => {
  await page.evaluate(() => {
    globalThis.__IROH_FM_E2E_DESKTOP__.nativeCache.set("track-1", 320_044);
  });
  await page.getByRole("link", { name: "Connection settings" }).click();

  await expect(page.getByText("1 · 313 KiB")).toBeVisible();
  await page.getByRole("button", { name: "CLEAR TRACKS" }).click();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByText("0 · 0 B")).toHaveCount(2);
});
