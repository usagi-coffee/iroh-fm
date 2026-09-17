import { prepareLibrary } from "./prepare.js";

import { expect, test } from "@playwright/test";

test("connects to a stored endpoint without relays only on native clients", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.removeItem("iroh-fm-ticket");
    localStorage.setItem("iroh-fm-endpoint", "e2e-server");
    localStorage.setItem("iroh-fm-relays", JSON.stringify([""]));
    localStorage.setItem("iroh-fm-secret", "e2e-secret");
  });

  await page.goto("/tracks");

  if (testInfo.project.name === "web") {
    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole("row")).toHaveCount(0);
  } else {
    await expect(page).toHaveURL(/\/tracks$/);
    await expect(page.getByRole("row")).toHaveCount(3);
  }
});

test("allows saving an endpoint without relays only on native clients", async ({
  page,
}, testInfo) => {
  await prepareLibrary(page);
  await page.getByRole("link", { name: "Connection settings" }).click();

  await page.getByLabel("Server ticket").fill("");
  await page.getByLabel("Server endpoint ID").fill("e2e-server");
  await page.getByLabel("Relay URLs").fill("");

  const save = page.getByRole("button", { name: "SAVE & RECONNECT" });
  if (testInfo.project.name === "web") await expect(save).toBeDisabled();
  else await expect(save).toBeEnabled();
});
