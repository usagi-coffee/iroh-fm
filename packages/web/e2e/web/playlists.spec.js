import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("creates, fills, renames, plays, and deletes a playlist", async ({ page }) => {
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Morning");
  await page.getByRole("button", { name: "CREATE", exact: true }).click();

  await expect(page).toHaveURL(/\/playlists\/playlist-1$/);
  await expect(page.getByRole("heading", { name: "Morning" })).toBeVisible();

  await page.getByRole("link", { name: "TRACKS", exact: true }).click();
  await page.locator('[data-track-id="track-2"]').click({ button: "right" });
  await page.getByRole("button", { name: "Add to playlist" }).click();
  await page.getByRole("button", { name: /Morning/ }).click();
  await page.getByRole("link", { name: "Morning", exact: true }).click();

  await expect(page.getByRole("row")).toHaveCount(1);
  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");

  await page.getByRole("button", { name: "Rename playlist" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Evening");
  await page.getByRole("button", { name: "SAVE", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evening" })).toBeVisible();

  await page.getByRole("button", { name: "Delete playlist" }).click();
  await page.getByRole("button", { name: "DELETE", exact: true }).click();
  await expect(page).toHaveURL(/\/tracks$/);
  await expect(page.getByRole("link", { name: "Evening", exact: true })).toHaveCount(0);
});
