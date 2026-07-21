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
