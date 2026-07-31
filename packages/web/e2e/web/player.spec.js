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
  await page.getByRole("link", { name: "Starred", exact: true }).click();
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

test("gives lower volumes more slider range", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "android", "Android uses the system volume controls.");
  const volume = page.getByRole("slider", { name: "Volume" });

  await volume.fill("0.5");

  await expect.poll(() => page.evaluate(() => localStorage.getItem("iroh-fm-volume"))).toBe("0.25");
  await expect(volume).toHaveValue("0.5");
});

test("filters tracks by title", async ({ page }) => {
  await page.getByPlaceholder("Filter artist, title, album…").fill("nebula");
  await expect(page).toHaveURL(/\/tracks\?query=nebula$/);
  await expect(page.getByRole("row")).toHaveCount(1);
  await expect(page.getByRole("row")).toContainText("Nebula Drift");
  await expect(page.getByText("First Light", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(1);

  await page.getByPlaceholder("Filter artist, title, album…").press("Enter");
  await expect(page).toHaveURL(/\/tracks$/);
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(page.locator('[data-track-id="track-2"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText("Nebula Drift");
});

test("edits client settings through the settings model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "web", "Native clients use platform-owned settings.");

  await page.evaluate(() => {
    localStorage.setItem("iroh-fm-e2e-track-cache-count", "2");
    localStorage.setItem("iroh-fm-e2e-cover-cache-count", "3");
  });
  await page.getByRole("link", { name: "Connection settings" }).click();
  await expect(page.getByRole("heading", { name: "Client settings" })).toBeVisible();

  const relays = page.getByPlaceholder("https://relay.example");
  await expect(relays).toHaveCount(1);
  await page.getByRole("button", { name: "+ ADD RELAY" }).click();
  await expect(relays).toHaveCount(2);

  const memoryCache = page.getByRole("spinbutton", { name: "Memory cache size in MiB" });
  await memoryCache.fill("64");
  await expect(memoryCache).toHaveValue("64");

  await expect(page.getByText("2 · 625 KiB")).toBeVisible();
  await expect(page.getByText("3 · 3.0 KiB")).toBeVisible();

  await page.getByRole("button", { name: "CLEAR TRACKS" }).click();
  await expect(page.getByRole("heading", { name: "Clear offline tracks?" })).toBeVisible();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByText("0 · 0 B")).toBeVisible();
  await expect(page.getByText("3 · 3.0 KiB")).toBeVisible();

  await page.getByRole("button", { name: "CLEAR COVERS" }).click();
  await expect(page.getByRole("heading", { name: "Clear offline covers?" })).toBeVisible();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByText("0 · 0 B")).toHaveCount(2);
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
  const albumViewport = page.locator("[data-album-library] [data-virtual-viewport]");
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

test("allows virtualized track and album lists to reach their bottom edge", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop",
    "The Desktop fixture does not expose the generated large library.",
  );
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.hover();
  await page.mouse.wheel(0, 100_000);
  await expect(page.locator('[data-track-id="track-120"]')).toBeVisible();
  await expect.poll(() => distanceFromBottom(trackViewport)).toBeLessThan(1);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const albumViewport = page.locator("[data-album-library] [data-virtual-viewport]");
  await albumViewport.hover();
  await page.mouse.wheel(0, 100_000);
  await expect(page.locator('[data-album-id="album-120"]')).toBeVisible();
  await expect.poll(() => distanceFromBottom(albumViewport)).toBeLessThan(1);
  expect(await outwardTouchMovePrevented(albumViewport)).toBe(true);
  await albumViewport.evaluate(
    (element) => (element.scrollTop = element.scrollHeight - element.clientHeight - 1),
  );
  await expect.poll(() => finalVirtualRowOverflow(albumViewport)).toBeLessThanOrEqual(0);
  await expect.poll(() => uniformVirtualStrideError(albumViewport, 120)).toBeLessThan(0.1);
  const settledPosition = await albumViewport.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(1_200);
  expect(
    Math.abs((await albumViewport.evaluate((element) => element.scrollTop)) - settledPosition),
  ).toBeLessThan(1);
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

  await page.getByRole("link", { name: "TRACKS", exact: true }).click();
  const sidebarPlayingAlbum = page.locator(`[data-album-id="${albumId}"]`);
  await expect(sidebarPlayingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(sidebarPlayingAlbum)).toBeLessThan(15);
});

test("centers the sidebar for explicit track and album-header play clicks", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "web", "The sidebar is visible in the Web test viewport.");
  await page.evaluate(() => localStorage.setItem("iroh-fm-e2e-album-count", "120"));
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.6));
  await expect
    .poll(() => trackViewport.evaluate((viewport) => viewport.scrollTop))
    .toBeGreaterThan(1_000);
  const visibleTrack = trackViewport.locator("[data-track-id]").nth(2);
  await expect(visibleTrack).toBeVisible();
  const trackId = await visibleTrack.getAttribute("data-track-id");
  await visibleTrack.getByRole("button", { name: /^Play / }).click();

  const playingAlbum = page.locator(`[data-album-id="${trackId?.replace("track-", "album-")}"]`);
  await expect(playingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(playingAlbum)).toBeLessThan(15);

  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.25));
  const albumHeader = trackViewport.locator('button[aria-label^="Play album "]').nth(2);
  await expect(albumHeader).toBeVisible();
  const albumLabel = await albumHeader.getAttribute("aria-label");
  const albumNumber = Number(albumLabel?.match(/(\d{3})$/)?.[1]);
  await albumHeader.click();

  const headerAlbum = page.locator(`[data-album-id="album-${albumNumber}"]`);
  await expect(headerAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(headerAlbum)).toBeLessThan(15);
});

test("centers album navigation on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "android", "This exercises the mobile native player.");
  await page.evaluate(() => {
    localStorage.setItem("iroh-fm-e2e-album-count", "120");
    localStorage.setItem("iroh-fm-album-column-adjustment", "-1");
  });
  await page.reload();
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();

  const trackViewport = page.locator("section.bg-base [data-virtual-viewport]");
  await trackViewport.evaluate((viewport) => (viewport.scrollTop = viewport.scrollHeight * 0.6));
  await expect
    .poll(() => trackViewport.evaluate((viewport) => viewport.scrollTop))
    .toBeGreaterThan(1_000);
  const visibleTrack = trackViewport.locator("[data-track-id]").nth(2);
  await expect(visibleTrack).toBeVisible();
  const trackId = await visibleTrack.getAttribute("data-track-id");
  const trackNumber = trackId?.replace("track-", "").padStart(3, "0");
  await visibleTrack.getByRole("button", { name: /^Play / }).click();
  await expect(
    page.locator("footer").getByTitle("Show currently playing track").first(),
  ).toHaveText(`Track ${trackNumber}`);

  await page.getByRole("link", { name: "ALBUMS", exact: true }).click();
  const playingAlbum = page.locator(`[data-album-id="${trackId?.replace("track-", "album-")}"]`);
  await expect(playingAlbum).toBeVisible();
  await expect.poll(() => albumCenterOffset(playingAlbum)).toBeLessThan(15);
});

/** @param {import('@playwright/test').Locator} album */
async function albumCenterOffset(album) {
  return album.evaluate((element) => {
    const viewport = element.closest("[data-virtual-viewport]");
    if (!(viewport instanceof HTMLElement)) throw new Error("Album viewport not found");
    const viewportRect = viewport.getBoundingClientRect();
    const albumRect = element.getBoundingClientRect();
    return Math.abs(
      albumRect.top + albumRect.height / 2 - (viewportRect.top + viewportRect.height / 2),
    );
  });
}

/** @param {import('@playwright/test').Locator} viewport */
async function distanceFromBottom(viewport) {
  return viewport.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

/** @param {import('@playwright/test').Locator} viewport */
async function finalVirtualRowOverflow(viewport) {
  return viewport.evaluate((element) => {
    const renderedRows = element.firstElementChild?.firstElementChild;
    const finalRow = renderedRows?.lastElementChild;
    if (!(finalRow instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    return finalRow.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
  });
}

/** @param {import('@playwright/test').Locator} viewport */
async function outwardTouchMovePrevented(viewport) {
  return viewport.evaluate((element) => {
    const touch = (identifier, clientY) =>
      new Touch({ identifier, target: element, clientX: 20, clientY });
    const start = touch(1, 200);
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [start],
        changedTouches: [start],
      }),
    );
    const moved = touch(1, 100);
    const accepted = element.dispatchEvent(
      new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        changedTouches: [moved],
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        changedTouches: [moved],
      }),
    );
    return !accepted;
  });
}

/**
 * @param {import('@playwright/test').Locator} viewport
 * @param {number} albumCount
 */
async function uniformVirtualStrideError(viewport, albumCount) {
  return viewport.evaluate((element, count) => {
    const rows = element.querySelectorAll("[data-virtual-index]");
    const first = rows[0];
    const second = rows[1];
    const spacer = element.firstElementChild;
    const group = spacer?.firstElementChild;
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement) || !group || !spacer)
      return Number.POSITIVE_INFINITY;
    const columnsLabel = element.closest("section")?.querySelector('[title$="album columns"]');
    const columns = Number.parseInt(columnsLabel?.getAttribute("title") ?? "", 10);
    const firstIndex = Number(first.dataset.virtualIndex);
    const stride = second.getBoundingClientRect().top - first.getBoundingClientRect().top;
    const transform = new DOMMatrixReadOnly(getComputedStyle(group).transform).m42;
    const padding = transform - firstIndex * stride;
    const expectedHeight = padding * 2 + Math.ceil(count / columns) * stride;
    return Math.abs(spacer.getBoundingClientRect().height - expectedHeight);
  }, albumCount);
}
