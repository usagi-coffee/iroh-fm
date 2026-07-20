import { expect } from "@playwright/test";

export async function prepareLibrary(page) {
  await page.addInitScript(() => {
    localStorage.setItem("iroh-fm-ticket", "e2e-ticket");
    localStorage.setItem("iroh-fm-secret", "e2e-secret");
  });
  await page.goto("/tracks");
  await expect(page.getByRole("row")).toHaveCount(3);
}
