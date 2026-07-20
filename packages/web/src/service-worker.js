import { build, files, version } from "$service-worker";

const CACHE_NAME = `iroh-fm-shell-${version}`;
const STATE_CACHE_NAME = "iroh-fm-shell-state-v1";
const SHELL_CACHE_PREFIXES = ["iroh-fm-shell-", "iroh-fm-"];
// Persistent user data. Application upgrades never delete these caches.
const DATA_CACHE_NAMES = new Set([
  "iroh-fm-cover-art-v1",
  "iroh-fm-cover-art-v2",
  "iroh-fm-track-audio-v1",
]);
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scoped = (path) => {
  if (!SCOPE_PATH || path.startsWith(`${SCOPE_PATH}/`)) return path;
  if (path === "/") return `${SCOPE_PATH}/`;
  return `${SCOPE_PATH}${path}`;
};
const STATE_KEY = scoped("/__iroh-fm-active-shell__");
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
      const approved = await approvedShell();
      await cleanShellCaches(approved.cacheName);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  // "skip-waiting" keeps the explicit update button from the pre-pointer
  // client compatible with this worker during the one-time migration.
  if (event.data?.type === "activate-update" || event.data?.type === "skip-waiting") {
    event.waitUntil(
      (async () => {
        try {
          await writeApprovedShell({
            cacheName: CACHE_NAME,
            buildVersion: typeof __BUILD_VERSION__ === "undefined" ? version : __BUILD_VERSION__,
          });
          await cleanShellCaches(CACHE_NAME);
          await self.skipWaiting();
          event.ports[0]?.postMessage({ type: "update-activated" });
        } catch (error) {
          event.ports[0]?.postMessage({
            type: "update-error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );
    return;
  }

  if (event.data?.type === "version") {
    event.waitUntil(
      (async () => {
        const approved = await approvedShell();
        event.ports[0]?.postMessage({
          type: "version",
          version,
          buildVersion: approved.buildVersion,
          workerBuildVersion:
            typeof __BUILD_VERSION__ === "undefined" ? version : __BUILD_VERSION__,
          updateReady: approved.cacheName !== CACHE_NAME,
        });
      })(),
    );
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const approved = await approvedShell();
      const active = await caches.open(approved.cacheName);
      if (event.request.mode === "navigate") {
        return (
          (await active.match(event.request, { ignoreSearch: true })) ??
          (await active.match(NAVIGATION_FALLBACKS[0])) ??
          (await active.match(NAVIGATION_FALLBACKS[1])) ??
          new Response("The offline application shell is unavailable.", { status: 503 })
        );
      }

      const cached =
        (await active.match(event.request, { ignoreSearch: true })) ??
        (await caches.match(event.request, { ignoreSearch: true }));
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
    name !== STATE_CACHE_NAME &&
    SHELL_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
    !DATA_CACHE_NAMES.has(name)
  );
}

async function approvedShell() {
  const stateCache = await caches.open(STATE_CACHE_NAME);
  const saved = await stateCache.match(STATE_KEY);
  if (saved) {
    const approved = await saved.json().catch(() => null);
    if (approved?.cacheName && (await caches.has(approved.cacheName))) return approved;
  }

  const initial = {
    cacheName: CACHE_NAME,
    buildVersion: typeof __BUILD_VERSION__ === "undefined" ? version : __BUILD_VERSION__,
  };
  await writeApprovedShell(initial);
  return initial;
}

async function writeApprovedShell(approved) {
  const stateCache = await caches.open(STATE_CACHE_NAME);
  await stateCache.put(
    STATE_KEY,
    new Response(JSON.stringify(approved), {
      headers: { "content-type": "application/json" },
    }),
  );
}

async function cleanShellCaches(approvedName) {
  const shells = (await caches.keys()).filter(isShellCache);
  const keep = new Set([approvedName, CACHE_NAME]);
  const previous = shells.filter((name) => !keep.has(name)).at(-1);
  if (previous) keep.add(previous);
  await Promise.all(shells.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
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
