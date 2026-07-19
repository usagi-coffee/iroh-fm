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
const NAVIGATION_FALLBACKS = [scoped("/"), scoped("/index.html")];
const APP_SHELL =
  build.length === 0
    ? []
    : [
        ...new Set(
          [
            ...build,
            ...files.filter((path) => !path.endsWith("/.nojekyll")),
            ...prerendered,
            ...NAVIGATION_FALLBACKS,
          ].map(scoped),
        ),
      ];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // A worker is installable only when its complete, matching application
        // shell is available offline. The previous worker remains active if
        // any asset from this deployment cannot be cached.
        await cache.addAll(APP_SHELL);
        const navigationCached = await Promise.all(
          NAVIGATION_FALLBACKS.map((path) => safeCacheMatch(cache, path)),
        );
        if (!navigationCached.some(Boolean)) {
          throw new Error("the main application document could not be cached");
        }
      } catch (error) {
        await caches.delete(CACHE_NAME).catch(() => {});
        console.error("[sw] application update was not cached completely", error);
        throw error;
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
              key !== CACHE_NAME && key.startsWith(APP_CACHE_PREFIX) && !DATA_CACHE_NAMES.has(key),
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
  const buildVersion = typeof __BUILD_VERSION__ === "undefined" ? version : __BUILD_VERSION__;
  event.ports[0]?.postMessage({ type: "version", version, buildVersion });
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
        const cached =
          (cache && (await safeCacheMatch(cache, event.request))) ||
          (cache && (await safeCacheMatch(cache, NAVIGATION_FALLBACKS[0]))) ||
          (cache && (await safeCacheMatch(cache, NAVIGATION_FALLBACKS[1])));
        if (cached) return cached;

        // This is only needed for the first uncontrolled load or if Cache
        // Storage was cleared. Controlled navigations never mix HTML from a
        // newer deployment into the active worker's versioned cache.
        try {
          const response = await fetch(event.request, { cache: "no-store" });
          if (response.ok) return response;
        } catch {
          // The response below explains why a complete offline shell is absent.
        }
        return new Response("The offline application shell is unavailable.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
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
      } catch {
        const cached = await safeGlobalMatch(event.request);
        if (cached) return cached;

        if (event.request.mode === "navigate") {
          const fallback =
            (cache && (await safeCacheMatch(cache, NAVIGATION_FALLBACKS[0]))) ||
            (cache && (await safeCacheMatch(cache, NAVIGATION_FALLBACKS[1])));
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
