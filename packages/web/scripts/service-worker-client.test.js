import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../src/lib/service-worker.js", import.meta.url), "utf8"))
  .replace(/^import .* from "\$app\/(?:env|paths)";$/gm, "")
  .replace(/^export /gm, "");

test("Desktop continues from its loaded page when service worker registration stalls", async () => {
  let registrationAttempts = 0;
  let startupTimeout;
  const navigator = {
    serviceWorker: {
      getRegistration() {
        registrationAttempts += 1;
        return new Promise(() => {});
      },
      addEventListener() {},
    },
  };
  const context = vm.createContext({
    navigator,
    location: { hostname: "usagi-coffee.github.io", href: "https://usagi-coffee.github.io/iroh-fm/" },
    dev: false,
    resolve: () => "/iroh-fm/",
    __BUILD_VERSION__: "test-build",
    __DESKTOP_EPOCH__: 1,
    __DESKTOP_EPOCH_COMMIT__: "desktop",
    __ANDROID_EPOCH__: 1,
    __ANDROID_EPOCH_COMMIT__: "android",
    URL,
    Set,
    WeakSet,
    console,
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    setInterval() {},
    setTimeout(callback, milliseconds) {
      startupTimeout = milliseconds;
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });
  vm.runInContext(`${source}\nglobalThis.ensure = ensure_service_worker;`, context);

  const result = await context.ensure({ platform: "Desktop", epoch: 1 });
  assert.equal(result.updateReady, false);
  assert.equal(registrationAttempts, 1);
  assert.equal(startupTimeout, 3_000);
});
