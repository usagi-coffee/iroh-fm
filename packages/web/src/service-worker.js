import { build, files, prerendered, version } from "$service-worker";

const CACHE_NAME = `iroh-fm-${version}`;
const DATA_CACHE_NAMES = new Set(["iroh-fm-cover-art-v1"]);
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scoped = (path) => {
  if (!SCOPE_PATH || path.startsWith(`${SCOPE_PATH}/`)) return path;
  if (path === "/") return `${SCOPE_PATH}/`;
  return `${SCOPE_PATH}${path}`;
};
const APP_SHELL = [
  ...new Set(
    [
      ...build,
      ...files.filter((path) => !path.endsWith("/.nojekyll")),
      ...prerendered,
      "/",
      "/index.html",
    ].map(scoped),
  ),
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && !DATA_CACHE_NAMES.has(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "version" && event.data?.type !== "user") return;
  event.ports[0]?.postMessage({ type: "version", version });
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);
      const cache = await caches.open(CACHE_NAME);

      if (APP_SHELL.includes(url.pathname)) {
        const cached = await cache.match(url.pathname);
        if (cached) return cached;
      }

      try {
        return await fetch(event.request);
      } catch (error) {
        const cached = await cache.match(event.request);
        if (cached) return cached;

        if (event.request.mode === "navigate") {
          return (await cache.match(scoped("/"))) || cache.match(scoped("/index.html"));
        }

        throw error;
      }
    })(),
  );
});
