import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("marks the web-prefetched next track in the memory cache", async ({ page }) => {
  await page.getByRole("button", { name: "Play First Light" }).click();
  const nextTrack = page.getByRole("row").filter({ hasText: "Nebula Drift" });
  await expect(nextTrack.locator('[title="In memory cache"]')).toBeVisible();
  await expect(nextTrack.locator('[title="In memory cache"]')).toHaveClass(/text-peach/);
});
