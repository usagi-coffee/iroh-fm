import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = (
  await readFile(new URL("../src/service-worker/index.js", import.meta.url), "utf8")
).replace(/^import .* from "\$app\/(?:env|manifest|service-worker)";$/gm, "");
const build = ["/_app/immutable/entry/start.a.js", "/_app/immutable/entry/app.b.js"];
const html = `<html>${build.join(" ")}</html>`;

function worker(storage, offline = false, base = "") {
  const shellHtml = html.replaceAll("/_app/", `${base}/_app/`);
  const handlers = new Map();
  const key = (request) => (typeof request === "string" ? request : new URL(request.url).pathname);
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(request) {
          return entries.get(key(request))?.clone();
        },
        async put(request, response) {
          entries.set(key(request), response.clone());
        },
        async add(request) {
          if (offline) throw new Error("network unavailable");
          entries.set(key(request), new Response(shellHtml));
        },
      };
    },
    async keys() {
      return [...storage.keys()];
    },
    async has(name) {
      return storage.has(name);
    },
    async delete(name) {
      return storage.delete(name);
    },
  };
  vm.runInNewContext(source, {
    immutable: build.map((path) => ({ path: path.slice(1) })),
    version: "current",
    __BUILD_VERSION__: "current",
    __DESKTOP_EPOCH__: 1,
    __DESKTOP_EPOCH_COMMIT__: "desktop",
    __ANDROID_EPOCH__: 1,
    __ANDROID_EPOCH_COMMIT__: "android",
    URL,
    Response,
    Request: class extends Request {
      constructor(path, options) {
        super(new URL(path, "https://app.test"), options);
      }
    },
    caches,
    console: { info() {}, error() {} },
    self: {
      location: new URL(`https://app.test${base}/service-worker.js`),
      registration: {
        scope: `https://app.test${base}/`,
        active: { scriptURL: `https://app.test${base}/service-worker.js?build=current` },
      },
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
    },
  });
  return {
    install() {
      let pending;
      handlers.get("install")({
        waitUntil(promise) {
          pending = promise;
        },
      });
      return pending;
    },
    navigate() {
      let pending;
      handlers.get("fetch")({
        request: { method: "GET", url: `https://app.test${base}/tracks`, mode: "navigate" },
        respondWith(promise) {
          pending = promise;
        },
      });
      return pending;
    },
  };
}

test("reinstalling the same build offline preserves the installed shell", async () => {
  const storage = new Map();
  await worker(storage).install();
  await worker(storage, true).install();
  const response = await worker(storage, true).navigate();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
});

test("a failed first install does not retain an incomplete shell", async () => {
  const storage = new Map();
  await assert.rejects(worker(storage, true).install(), /could not cache/);
  assert.equal(storage.has("iroh-fm-shell-current"), false);
});

test("an incomplete existing shell is repaired rather than reused", async () => {
  const storage = new Map();
  await worker(storage).install();
  storage.get("iroh-fm-shell-current").delete(build[0]);
  await worker(storage).install();
  assert.ok(storage.get("iroh-fm-shell-current").has(build[0]));
});

test("manifest assets and offline navigation respect the deployment base path", async () => {
  const storage = new Map();
  await worker(storage, false, "/music").install();
  const shell = storage.get("iroh-fm-shell-current");
  assert.ok(shell.has(`/music${build[0]}`));
  assert.ok(shell.has("/music/pwa-icon-192.png"));
  assert.ok([...shell.keys()].every((path) => path.startsWith("/music/")));
  await worker(storage, true, "/music").install();
  const response = await worker(storage, true, "/music").navigate();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html.replaceAll("/_app/", "/music/_app/"));
});
