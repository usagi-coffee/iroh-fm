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
