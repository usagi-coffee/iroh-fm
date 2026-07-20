import { build, version } from "$service-worker";

const CACHE_NAME = `iroh-fm-shell-${version}`;
const BUILD_VERSION = __BUILD_VERSION__;
const LOG_PREFIX = `[sw ${BUILD_VERSION.slice(0, 12)}]`;
const PROTOCOL_VERSION = 1;
const NATIVE_EPOCHS = {
  Desktop: { minimum: __DESKTOP_EPOCH__, commit: __DESKTOP_EPOCH_COMMIT__ },
  Android: { minimum: __ANDROID_EPOCH__, commit: __ANDROID_EPOCH_COMMIT__ },
};
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
const STATIC_SHELL_FILES = [
  "/favicon.ico",
  "/manifest.webmanifest",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/pwa-maskable-192.png",
  "/pwa-maskable-512.png",
];
const APP_SHELL = [
  ...new Set([...build, ...STATIC_SHELL_FILES, "/"].map(scoped).concat(NAVIGATION_FALLBACKS)),
];
const ENTRYPOINTS = APP_SHELL.filter((path) =>
  /\/_app\/immutable\/entry\/(?:start|app)\.[^/]+\.js$/.test(path),
);
/** @type {Promise<{cacheName: string, buildVersion: string}> | undefined} */
let approvedShellPromise;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      let stage = "opening the shell cache";
      console.info(LOG_PREFIX, "install started", {
        scriptUrl: self.location.href,
        cacheName: CACHE_NAME,
        files: APP_SHELL.length,
      });
      try {
        const cache = await caches.open(CACHE_NAME);
        stage = "caching the application shell";
        await cache.addAll(APP_SHELL.map((path) => new Request(path, { cache: "reload" })));
        console.info(LOG_PREFIX, "application shell cached");
        stage = "verifying the application shell";
        await verifyHtmlMatchesShell(cache);
        console.info(LOG_PREFIX, "application shell verified");
        // Activate the worker so the old page can discover this shell, but do
        // not select the new shell until the user approves the update.
        stage = "requesting activation";
        await self.skipWaiting();
        console.info(LOG_PREFIX, "install completed");
      } catch (error) {
        console.error(LOG_PREFIX, "install failed", { stage, cacheName: CACHE_NAME, error });
        await caches.delete(CACHE_NAME).catch(() => {});
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      console.info(LOG_PREFIX, "activation started");
      try {
        const approved = await approvedShell();
        await cleanShellCaches(approved.cacheName);
        await self.clients.claim();
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients)
          client.postMessage({ type: "worker-activated", ...workerInfo(approved) });
        console.info(LOG_PREFIX, "activation completed", {
          approvedCache: approved.cacheName,
          updateReady: approved.cacheName !== CACHE_NAME,
          clients: clients.length,
        });
      } catch (error) {
        console.error(LOG_PREFIX, "activation failed", error);
        throw error;
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  // "skip-waiting" keeps the explicit update button from the pre-pointer
  // client compatible with this worker during the one-time migration.
  if (event.data?.type === "activate-update" || event.data?.type === "skip-waiting") {
    event.waitUntil(
      (async () => {
        console.info(LOG_PREFIX, "update approval received", { type: event.data.type });
        try {
          await writeApprovedShell({
            cacheName: CACHE_NAME,
            buildVersion: BUILD_VERSION,
          });
          await cleanShellCaches(CACHE_NAME);
          await self.skipWaiting();
          console.info(LOG_PREFIX, "update approved", { cacheName: CACHE_NAME });
          event.ports[0]?.postMessage({ type: "update-activated" });
        } catch (error) {
          console.error(LOG_PREFIX, "update approval failed", error);
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
          ...workerInfo(approved),
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

      const cached = await active.match(event.request, { ignoreSearch: true });
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
  approvedShellPromise ??= readApprovedShell();
  return approvedShellPromise;
}

async function readApprovedShell() {
  const stateCache = await caches.open(STATE_CACHE_NAME);
  const saved = await stateCache.match(STATE_KEY);
  if (saved) {
    const approved = await saved.json().catch(() => null);
    if (approved?.cacheName && (await caches.has(approved.cacheName))) {
      console.info(LOG_PREFIX, "restored approved shell", approved);
      return approved;
    }
  }

  const initial = {
    cacheName: CACHE_NAME,
    buildVersion: BUILD_VERSION,
  };
  await writeApprovedShell(initial);
  console.info(LOG_PREFIX, "initialized approved shell", initial);
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
  approvedShellPromise = Promise.resolve(approved);
}

function workerInfo(approved) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    version,
    buildVersion: approved.buildVersion,
    workerBuildVersion: BUILD_VERSION,
    nativeEpochs: NATIVE_EPOCHS,
    updateReady: approved.cacheName !== CACHE_NAME,
  };
}

async function cleanShellCaches(approvedName) {
  const shells = (await caches.keys()).filter(isShellCache);
  const keep = new Set([approvedName, CACHE_NAME]);
  const removed = shells.filter((name) => !keep.has(name));
  await Promise.all(removed.map((name) => caches.delete(name)));
  if (removed.length) console.info(LOG_PREFIX, "removed old shell caches", removed);
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
