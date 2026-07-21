import { build, version } from "$service-worker";

const WEB_BUILD = __BUILD_VERSION__;
const CACHE_NAME = `iroh-fm-shell-${WEB_BUILD}`;
const STATE_CACHE_NAME = "iroh-fm-shell-state-v1";
const LOG_PREFIX = `[sw ${WEB_BUILD.slice(0, 12)}]`;
const METADATA = {
  version,
  workerBuildVersion: WEB_BUILD,
  nativeEpochs: {
    Desktop: { minimum: __DESKTOP_EPOCH__, commit: __DESKTOP_EPOCH_COMMIT__ },
    Android: { minimum: __ANDROID_EPOCH__, commit: __ANDROID_EPOCH_COMMIT__ },
  },
};

const DATA_CACHES = new Set([
  "iroh-fm-cover-art-v1",
  "iroh-fm-cover-art-v2",
  "iroh-fm-track-audio-v1",
]);
const SHELL_CACHE_PREFIXES = ["iroh-fm-shell-", "iroh-fm-"];
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const scoped = (path) => {
  if (!SCOPE_PATH || path.startsWith(`${SCOPE_PATH}/`)) return path;
  return path === "/" ? `${SCOPE_PATH}/` : `${SCOPE_PATH}${path}`;
};
const STATE_KEY = scoped("/__iroh-fm-active-shell__");
const FALLBACKS = [scoped("/"), scoped("/index.html")];
const STATIC_FILES = [
  "/favicon.ico",
  "/manifest.webmanifest",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/pwa-maskable-192.png",
  "/pwa-maskable-512.png",
];
const SHELL_FILES = [...new Set([...build, ...STATIC_FILES, "/"].map(scoped).concat(FALLBACKS))];
const ENTRYPOINTS = SHELL_FILES.filter((path) =>
  /\/_app\/immutable\/entry\/(?:start|app)\.[^/]+\.js$/.test(path),
);
const VERSION_PATH = scoped("/_app/version.json");
const WORKER_PATH = scoped("/service-worker.js");
/** @type {Promise<{cacheName: string, buildVersion: string}> | undefined} */
let approvedShellPromise;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      log("install:start", {
        scriptUrl: self.location.href,
        cache: CACHE_NAME,
        files: SHELL_FILES.length,
        metadata: METADATA,
      });
      try {
        const cache = await caches.open(CACHE_NAME);
        await cacheShell(cache);
        await verifyShell(cache);
        const approved = await approvedShell();
        log("install:ready", { cache: CACHE_NAME, approved });
      } catch (error) {
        logError("install:failed", error, { cache: CACHE_NAME });
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
      log("activate:start", { cache: CACHE_NAME, approved });
      const removed = await cleanOldShells();
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients)
        client.postMessage({ type: "worker-activated", ...workerMetadata(approved) });
      log("activate:complete", { clients: clients.length, removed });
    })().catch((error) => {
      logError("activate:failed", error);
      throw error;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "version") {
    event.waitUntil(
      approvedShell().then((approved) =>
        event.ports[0]?.postMessage({ type: "version", ...workerMetadata(approved) }),
      ),
    );
    return;
  }

  if (event.data?.type !== "activate-update") return;
  event.waitUntil(
    (async () => {
      try {
        await writeApprovedShell({ cacheName: CACHE_NAME, buildVersion: WEB_BUILD });
        const removed = await cleanOldShells();
        await self.skipWaiting();
        log("activation:approved", { message: event.data.type });
        event.ports[0]?.postMessage({ type: "update-activated" });
        log("activation:cleaned", { removed });
      } catch (error) {
        logError("activation:failed", error);
        event.ports[0]?.postMessage({
          type: "update-error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // These two resources must always reach HTTP/WebKit's update machinery.
  if (url.pathname === VERSION_PATH || url.pathname === WORKER_PATH) return;

  event.respondWith(
    (async () => {
      const approved = await approvedShell();
      const cache = await caches.open(approved.cacheName);
      if (event.request.mode === "navigate") {
        return (
          (await cache.match(event.request, { ignoreSearch: true })) ??
          (await cache.match(FALLBACKS[0])) ??
          (await cache.match(FALLBACKS[1])) ??
          new Response("The offline application shell is unavailable.", { status: 503 })
        );
      }
      return (await cache.match(event.request, { ignoreSearch: true })) ?? fetch(event.request);
    })().catch((error) => {
      logError("fetch:failed", error, { url: event.request.url });
      return new Response("This resource is unavailable offline.", { status: 503 });
    }),
  );
});

async function cacheShell(cache) {
  for (const path of SHELL_FILES) {
    try {
      await cache.add(new Request(path, { cache: "reload" }));
    } catch (error) {
      throw new Error(`could not cache ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function verifyShell(cache) {
  if (ENTRYPOINTS.length < 2) throw new Error("the application entrypoints are missing");
  for (const path of FALLBACKS) {
    const response = await cache.match(path);
    if (!response) throw new Error(`the application document is missing: ${path}`);
    const html = await response.text();
    if (!ENTRYPOINTS.every((entry) => html.includes(entry)))
      throw new Error(`the application document and asset manifest do not match: ${path}`);
  }
}

async function cleanOldShells() {
  const approved = await approvedShell();
  const names = await caches.keys();
  const old = names.filter(
    (name) => name !== CACHE_NAME && name !== approved.cacheName && isShellCache(name),
  );
  await Promise.all(old.map((name) => caches.delete(name)));
  return old;
}

function isShellCache(name) {
  return (
    name !== STATE_CACHE_NAME &&
    !DATA_CACHES.has(name) &&
    SHELL_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

async function approvedShell() {
  approvedShellPromise ??= readApprovedShell();
  return approvedShellPromise;
}

async function readApprovedShell() {
  const state = await caches.open(STATE_CACHE_NAME);
  const saved = await state.match(STATE_KEY);
  if (saved) {
    const approved = await saved.json().catch(() => null);
    const buildVersion = approved?.buildVersion ?? shellBuild(approved?.cacheName);
    if (approved?.cacheName && buildVersion && (await caches.has(approved.cacheName))) {
      const restored = { cacheName: approved.cacheName, buildVersion: String(buildVersion) };
      log("shell:restore", restored);
      return restored;
    }
  }

  // Before the pinned-shell state existed, the active worker and active shell
  // were the same build. Prefer that worker's cache when migrating even if
  // one or more newer workers have already been installed and cached.
  const names = await caches.keys();
  const shells = names.filter(isShellCache);
  const activeBuild = registrationBuild(self.registration.active);
  const activeCache = activeBuild ? `iroh-fm-shell-${activeBuild}` : undefined;
  const cacheName =
    (activeCache && shells.includes(activeCache) ? activeCache : undefined) ??
    shells.find((name) => name !== CACHE_NAME) ??
    CACHE_NAME;
  const initial = {
    cacheName,
    buildVersion: activeBuild ?? shellBuild(cacheName) ?? WEB_BUILD,
  };
  await writeApprovedShell(initial);
  log("shell:initialize", initial);
  return initial;
}

/** @param {{cacheName: string, buildVersion: string}} approved */
async function writeApprovedShell(approved) {
  const state = await caches.open(STATE_CACHE_NAME);
  await state.put(
    STATE_KEY,
    new Response(JSON.stringify(approved), {
      headers: { "content-type": "application/json" },
    }),
  );
  approvedShellPromise = Promise.resolve(approved);
}

/** @param {{cacheName: string, buildVersion: string}} approved */
function workerMetadata(approved) {
  return {
    ...METADATA,
    buildVersion: approved.buildVersion,
    updateReady: approved.cacheName !== CACHE_NAME,
  };
}

/** @param {string | undefined} name */
function shellBuild(name) {
  return name?.startsWith("iroh-fm-shell-") ? name.slice("iroh-fm-shell-".length) : undefined;
}

/** @param {ServiceWorker | null} worker */
function registrationBuild(worker) {
  if (!worker) return undefined;
  return new URL(worker.scriptURL).searchParams.get("build") ?? undefined;
}

function log(event, details = {}) {
  console.info(LOG_PREFIX, event, details);
}

function logError(event, error, details = {}) {
  console.error(LOG_PREFIX, event, {
    ...details,
    error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  });
}
