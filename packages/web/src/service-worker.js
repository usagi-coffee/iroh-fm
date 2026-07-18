import { build, files, prerendered, version } from "$service-worker";

const CACHE_NAME = `iroh-fm-${version}`;
const APP_CACHE_PREFIX = "iroh-fm-";
const DATA_CACHE_NAMES = new Set(["iroh-fm-cover-art-v1", "iroh-fm-track-audio-v1"]);
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scoped = (path) => {
  if (!SCOPE_PATH || path.startsWith(`${SCOPE_PATH}/`)) return path;
  if (path === "/") return `${SCOPE_PATH}/`;
  return `${SCOPE_PATH}${path}`;
};
const APP_SHELL = build.length === 0 ? [] : [
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
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(APP_SHELL);
      } catch (error) {
        // Offline support is optional. A quota or transient Cache API failure
        // must never prevent a newer network-safe worker from activating.
        console.warn("[sw] app shell could not be cached", error);
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        const previous = keys
          .filter(
            (key) =>
              key !== CACHE_NAME &&
              key.startsWith(APP_CACHE_PREFIX) &&
              !DATA_CACHE_NAMES.has(key),
          )
          .at(-1);
        await Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_NAME &&
                key !== previous &&
                key.startsWith(APP_CACHE_PREFIX) &&
                !DATA_CACHE_NAMES.has(key),
            )
            .map((key) => caches.delete(key)),
        );
      } catch (error) {
        console.warn("[sw] old app caches could not be cleaned", error);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type !== "version" && event.data?.type !== "user") return;
  event.ports[0]?.postMessage({ type: "version", version, buildVersion: __BUILD_VERSION__ });
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);
      let cache;

      try {
        cache = await caches.open(CACHE_NAME);
      } catch (error) {
        // Cache Storage can fail temporarily or after the origin reaches its
        // quota. Continue as a transparent network proxy in that case.
        console.warn("[sw] app cache is unavailable", error);
      }

      if (event.request.mode === "navigate") {
        try {
          const response = await fetch(event.request, { cache: "no-store" });
          if (response.ok) {
            if (cache) await cache.put(event.request, response.clone()).catch(() => {});
            return response;
          }
        } catch {
          // Fall through to the cached application shell while offline.
        }
      }

      if (cache && APP_SHELL.includes(url.pathname)) {
        try {
          const cached = await cache.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
        } catch (error) {
          console.warn("[sw] cached app resource could not be read", error);
        }
      }

      try {
        const response = await fetch(event.request);
        if (response.ok) return response;

        // A tab can briefly receive HTML from the previous deployment. Keep
        // one prior app cache so its hashed modules still resolve safely.
        const previous = await safeGlobalMatch(event.request);
        return previous ?? response;
      } catch (error) {
        const cached = await safeGlobalMatch(event.request);
        if (cached) return cached;

        if (event.request.mode === "navigate") {
          const fallback =
            (cache && (await safeCacheMatch(cache, scoped("/")))) ||
            (cache && (await safeCacheMatch(cache, scoped("/index.html"))));
          if (fallback) return fallback;
        }

        return new Response("This resource is temporarily unavailable.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })(),
  );
});

async function safeGlobalMatch(request) {
  try {
    return (await caches.match(request, { ignoreSearch: true })) ?? null;
  } catch {
    return null;
  }
}

async function safeCacheMatch(cache, request) {
  try {
    return (await cache.match(request, { ignoreSearch: true })) ?? null;
  } catch {
    return null;
  }
}
