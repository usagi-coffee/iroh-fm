import { build, files, version } from "$service-worker";

const CACHE_NAME = `iroh-fm-shell-${version}`;
const SHELL_CACHE_PREFIXES = ["iroh-fm-shell-", "iroh-fm-"];
// Persistent user data. Application upgrades never delete these caches.
const DATA_CACHE_NAMES = new Set(["iroh-fm-cover-art-v1", "iroh-fm-track-audio-v1"]);
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scoped = (path) => {
  if (!SCOPE_PATH || path.startsWith(`${SCOPE_PATH}/`)) return path;
  if (path === "/") return `${SCOPE_PATH}/`;
  return `${SCOPE_PATH}${path}`;
};
const NAVIGATION_FALLBACKS = [scoped("/"), scoped("/index.html")];
const APP_SHELL = [
  ...new Set(
    [...build, ...files.filter((path) => !path.endsWith("/.nojekyll")), "/"]
      .map(scoped)
      .concat(NAVIGATION_FALLBACKS),
  ),
];
const ENTRYPOINTS = APP_SHELL.filter((path) =>
  /\/_app\/immutable\/entry\/(?:start|app)\.[^/]+\.js$/.test(path),
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(APP_SHELL.map((path) => new Request(path, { cache: "reload" })));
        await verifyHtmlMatchesShell(cache);
      } catch (error) {
        await caches.delete(CACHE_NAME).catch(() => {});
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldShells = keys.filter((name) => name !== CACHE_NAME && isShellCache(name));
      const previous = oldShells.at(-1);
      await Promise.all(
        oldShells.filter((name) => name !== previous).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "version") {
    const buildVersion = typeof __BUILD_VERSION__ === "undefined" ? version : __BUILD_VERSION__;
    event.ports[0]?.postMessage({ type: "version", version, buildVersion });
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const current = await caches.open(CACHE_NAME);
      if (event.request.mode === "navigate") {
        return (
          (await current.match(event.request, { ignoreSearch: true })) ??
          (await current.match(NAVIGATION_FALLBACKS[0])) ??
          (await current.match(NAVIGATION_FALLBACKS[1])) ??
          new Response("The offline application shell is unavailable.", { status: 503 })
        );
      }

      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return new Response("This resource is unavailable offline.", { status: 503 });
      }
    })(),
  );
});

function isShellCache(name) {
  return (
    SHELL_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !DATA_CACHE_NAMES.has(name)
  );
}

async function verifyHtmlMatchesShell(cache) {
  if (ENTRYPOINTS.length < 2) throw new Error("the application entrypoints are missing");
  for (const path of NAVIGATION_FALLBACKS) {
    const response = await cache.match(path);
    if (!response) throw new Error(`the application document is missing: ${path}`);
    const html = await response.text();
    if (!ENTRYPOINTS.every((entry) => html.includes(entry))) {
      throw new Error(`the application document and asset manifest do not match: ${path}`);
    }
  }
}
