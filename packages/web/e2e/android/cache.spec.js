import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("shows asynchronous native connection stats while starting", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("e2e-slow-native-startup", "1");
  });
  await page.goto("/tracks");

  const status = page.locator('[title="direct: e2e"]');
  await expect(status).toContainText("DIRECT");
  await expect(status).toContainText(/DIRECT \d+ KiB/);
  await expect(status).toContainText(/↓ [1-9][\d.]* (?:B|KiB|MiB)\/s/);
});

test("marks Android played and prefetched tracks from transfer state", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const nextTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });
  await expect(nextTrack.locator('[title="In memory cache"]')).toBeVisible();
  await expect(nextTrack.locator('[title="In memory cache"]')).toHaveClass(/text-peach/);

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  const playedTrack = page.getByRole("row").filter({ hasText: "First Light" });
  await expect(playedTrack.locator('[title="In memory cache"]')).toBeVisible();
  await expect(playedTrack.locator('[title="In memory cache"]')).toHaveClass(/text-peach/);
});

test("discards stale native playback states after resume", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("e2e-stale-native-state", "1"));
  await page.getByRole("button", { name: "Play First Light" }).click();

  const currentTrack = page.locator("footer").getByTitle("Show currently playing track").first();
  await expect(currentTrack).toHaveText("First Light");
  await page.waitForTimeout(100);
  await expect(currentTrack).toHaveText("First Light");
  await expect(page.getByRole("slider", { name: "Playback position" })).toHaveValue("0");
});
