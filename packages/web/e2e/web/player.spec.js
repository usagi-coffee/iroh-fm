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
  const firstRender = await page.locator(".cover").first().evaluate((cover) => ({
    image: Boolean(cover.querySelector("img")),
    fallback: Boolean(cover.querySelector(".cover-fallback")),
  }));

  expect(firstRender).toEqual({ image: true, fallback: false });
});
