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

test("selects tracks with arrow keys and starts playback with Enter", async ({ page }) => {
  await page.getByRole("row").first().click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("row").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
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
  await expect(page.getByRole("row")).toHaveCount(1);
  await expect(page.getByRole("row")).toContainText("Nebula Drift");
  await expect(page.getByText("First Light", { exact: true })).toHaveCount(0);
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
