import { prepareLibrary } from "../prepare.js";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await prepareLibrary(page);
});

test("creates, fills, renames, plays, and deletes a playlist", async ({ page }) => {
  await page.getByRole("button", { name: "Create playlist" }).click();
  await expect(page).toHaveURL(/\/playlists\/playlist-1$/);
  await expect(page.getByRole("link", { name: "Playlist", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Create playlist" }).click();
  await expect(page).toHaveURL(/\/playlists\/playlist-2$/);
  await expect(page.getByRole("link", { name: "Playlist (1)", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "TRACKS", exact: true }).click();
  await page.evaluate(() => {
    window.__IROH_FM_DRAG_PREVIEW__ = "";
    document.addEventListener(
      "dragstart",
      () => {
        window.__IROH_FM_DRAG_PREVIEW__ =
          document.querySelector("[data-playlist-drag-preview]")?.textContent ?? "";
      },
      { once: true },
    );
  });
  await page
    .locator('[data-track-id="track-2"]')
    .dragTo(page.getByRole("link", { name: "Playlist (1)", exact: true }));
  await expect
    .poll(() => page.evaluate(() => window.__IROH_FM_DRAG_PREVIEW__))
    .toContain("Nebula Drift");
  await page.getByRole("link", { name: "Playlist (1)", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(1);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  await page
    .locator('[data-album-id="album-1"]')
    .dragTo(page.getByRole("link", { name: "Playlist (1)", exact: true }));
  await page.getByRole("link", { name: "Playlist (1)", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Rename playlist" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete playlist" })).toHaveCount(0);
  await page
    .locator('[data-track-id="track-3"] .cursor-grab')
    .dragTo(page.locator('[data-track-id="track-2"]'), {
      targetPosition: { x: 20, y: 1 },
    });
  await expect(page.getByRole("row").nth(0)).toHaveAttribute("data-track-id", "track-3");
  await expect(page.getByRole("row").nth(1)).toHaveAttribute("data-track-id", "track-2");
  await page
    .locator('[data-track-id="track-3"] .cursor-grab')
    .dragTo(page.locator('[data-track-id="track-1"]'), {
      targetPosition: { x: 20, y: 26 },
    });
  await expect(page.getByRole("row").nth(2)).toHaveAttribute("data-track-id", "track-3");
  await page
    .getByRole("link", { name: "Playlist (1)", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "Cache playlist" }).click();
  await page
    .getByRole("link", { name: "Playlist (1)", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("button", { name: "Playlist cached" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Play Nebula Drift" }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");

  await page
    .getByRole("link", { name: "Playlist (1)", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("button", { name: "First", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Last", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Evening");
  await page.getByRole("button", { name: "SAVE", exact: true }).click();
  await expect(page.getByRole("link", { name: "Evening", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Evening", exact: true }).click({ button: "right" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "DELETE", exact: true }).click();
  await expect(page).toHaveURL(/\/tracks$/);
  await expect(page.getByRole("link", { name: "Evening", exact: true })).toHaveCount(0);
});
