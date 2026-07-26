import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const localChromium = "/usr/bin/chromium";
const launchOptions = {
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync(localChromium) ? localChromium : undefined),
};
const browser = {
  ...devices["Desktop Chrome"],
  launchOptions,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "web",
      testMatch: [
        "web/player.spec.js",
        "web/cache.spec.js",
        "web/auth.spec.js",
        "web/playlists.spec.js",
      ],
      use: {
        ...browser,
        baseURL: "http://127.0.0.1:4173",
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      name: "desktop",
      testMatch: ["web/player.spec.js", "desktop/cache.spec.js"],
      use: {
        ...browser,
        baseURL: "http://127.0.0.1:4174",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "android",
      testMatch: ["web/player.spec.js", "android/cache.spec.js"],
      use: {
        ...devices["Pixel 7"],
        baseURL: "http://127.0.0.1:4175",
        launchOptions,
      },
    },
  ],
  webServer: [
    server("bun run dev:e2e:web", 4173),
    server("bun run dev:e2e:desktop", 4174),
    server("bun run dev:e2e:android", 4175),
  ],
});

function server(command, port) {
  return {
    command,
    url: `http://127.0.0.1:${port}/tracks`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  };
}
