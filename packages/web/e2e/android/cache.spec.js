import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("marks Android played and prefetched tracks from transfer state", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const nextTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });
  await expect(nextTrack.locator('[title="Cached"]')).toBeVisible();
  await expect(nextTrack.locator('[title="Cached"]')).toHaveClass(/text-green/);

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  const playedTrack = page.getByRole("row").filter({ hasText: "First Light" });
  await expect(playedTrack.locator('[title="Cached"]')).toBeVisible();
  await expect(playedTrack.locator('[title="Cached"]')).toHaveClass(/text-green/);
});
