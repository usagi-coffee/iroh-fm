import { expect, test } from "@playwright/test";

test("uses the ticket and client secret from a root share link", async ({ page }) => {
  await page.goto("/#ticket=shared-ticket&secret=shared-secret");

  await expect(page).toHaveURL(/\/tracks#ticket=shared-ticket&secret=shared-secret$/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("iroh-fm-ticket")))
    .toBe("shared-ticket");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("iroh-fm-secret")))
    .toBe("shared-secret");
});

test("redirects disconnected app routes to connection setup", async ({ page }) => {
  await page.goto("/albums");

  await expect(page).toHaveURL(/\/connect$/);
});

test("redirects connected users away from connection setup", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("iroh-fm-ticket", "e2e-ticket");
    localStorage.setItem("iroh-fm-secret", "e2e-secret");
  });
  await page.goto("/connect");

  await expect(page).toHaveURL(/\/tracks$/);
});

test("explains protocol version mismatches on the connect page", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("iroh-fm-ticket", "e2e-ticket");
    localStorage.setItem("iroh-fm-secret", "e2e-secret");
    localStorage.setItem(
      "iroh-fm-e2e-bootstrap-error",
      "unknown variant `ListPlaylists`, expected one of `GetLibrarySummary`, `ListTracks`",
    );
  });
  await page.goto("/connect");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Connection failed.");
  await expect(alert).toContainText("unknown variant `ListPlaylists`");
  await expect(alert).toContainText("Protocol version mismatch.");
  await expect(alert).toContainText(
    "Upgrade both to the newest iroh.fm version, then try again.",
  );
});
