import { dev } from "$app/environment";
import { asset } from "$app/paths";

const PAGE_BUILD = __BUILD_VERSION__;
const WORKER_URL = asset("/service-worker.js");
const VERSION_URL = asset("/_app/version.json");
const CHECK_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const DEVELOPMENT =
  dev ||
  (typeof location !== "undefined" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
const MEDIA_CACHES = new Set([
  "iroh-fm-cover-art-v1",
  "iroh-fm-cover-art-v2",
  "iroh-fm-track-audio-v1",
]);

/** @type {Promise<ServiceWorkerRegistration> | undefined} */
let registrationPromise;
/** @type {Promise<ServiceWorker | null> | undefined} */
let installPromise;
/** @type {string | undefined} */
let installingBuild;
/** @type {ServiceWorker | undefined} */
let waitingWorker;
/** @type {string | undefined} */
let availableBuild;
/** @type {string | undefined} */
let activeBuild;
/** @type {any} */
let nativeBuild;
/** @type {ReturnType<typeof nativeRequirement>} */
let nativeUpgrade = null;
let monitoring = false;

/** @type {Set<(ready: boolean) => void>} */
const updateListeners = new Set();
/** @type {Set<(upgrade: ReturnType<typeof nativeRequirement>) => void>} */
const nativeListeners = new Set();
/** @type {WeakSet<ServiceWorkerRegistration>} */
const observedRegistrations = new WeakSet();
/** @type {WeakSet<ServiceWorker>} */
const observedWorkers = new WeakSet();

const noUpdate = () => ({ updateReady: false, nativeUpgrade: null, nativeNewerThanWeb: false });
const updateReady = () => Boolean(availableBuild || waitingWorker);

/**
 * @param {any} build
 * @param {Record<string, {minimum?: number, commit?: string}> | undefined} epochs
 */
function nativeRequirement(build, epochs) {
  const platform = build?.platform;
  const required = platform ? epochs?.[platform] : null;
  if (!required || Number(required.minimum) <= (Number(build?.epoch) || 0)) return null;
  const commit = String(required.commit ?? "");
  const releaseUrl = `https://github.com/usagi-coffee/iroh-fm/releases?q=${platform.toLowerCase()}-`;
  return {
    platform,
    minimum: Number(required.minimum),
    commit,
    releaseUrl,
    downloadUrl:
      platform === "Android" && /^[0-9a-f]{40}$/.test(commit)
        ? `https://github.com/usagi-coffee/iroh-fm/releases/download/android-${commit}/iroh-fm-android-${commit.slice(0, 7)}.apk`
        : releaseUrl,
  };
}

/** @param {any} build */
export function currentNativeRequirement(build) {
  if (DEVELOPMENT) return null;
  return nativeRequirement(build, {
    Desktop: { minimum: __DESKTOP_EPOCH__, commit: __DESKTOP_EPOCH_COMMIT__ },
    Android: { minimum: __ANDROID_EPOCH__, commit: __ANDROID_EPOCH_COMMIT__ },
  });
}

/** @param {any} build */
function nativeNewerThanWeb(build) {
  const epoch =
    build?.platform === "Desktop"
      ? __DESKTOP_EPOCH__
      : build?.platform === "Android"
        ? __ANDROID_EPOCH__
        : null;
  return epoch !== null && Number(build?.epoch) > epoch;
}

/** @param {Record<string, any>} metadata */
function applyWorkerMetadata(metadata) {
  const next = nativeRequirement(nativeBuild, metadata.nativeEpochs);
  const changed =
    next?.platform !== nativeUpgrade?.platform ||
    next?.minimum !== nativeUpgrade?.minimum ||
    next?.commit !== nativeUpgrade?.commit;
  nativeUpgrade = next;
  if (changed) {
    log("compatibility", {
      platform: nativeBuild?.platform,
      installedEpoch: nativeBuild?.epoch,
      requiredEpoch: next?.minimum ?? null,
    });
    for (const listener of nativeListeners) listener(next);
  }
}

/** @param {any} [build] */
export async function ensure_service_worker(build) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return noUpdate();
  if (DEVELOPMENT) {
    await disableDevelopmentWorker();
    return noUpdate();
  }

  nativeBuild = build ?? null;
  startMonitor();
  const registration = await getRegistration();
  await inspect(registration);
  await checkForUpdate().catch((error) => logError("check:unavailable", error));
  if (!availableBuild && activeBuild && activeBuild !== PAGE_BUILD) {
    availableBuild = PAGE_BUILD;
    log("active:behind-page", { activeBuild, pageBuild: PAGE_BUILD });
    notifyUpdates();
    void install(PAGE_BUILD).catch((error) => logError("active:upgrade-failed", error));
  }
  if (availableBuild && nativeNewerThanWeb(build))
    await install(availableBuild).catch((error) => logError("compatibility:check-failed", error));
  return {
    updateReady: updateReady(),
    nativeUpgrade,
    nativeNewerThanWeb: nativeNewerThanWeb(build),
  };
}

function getRegistration() {
  registrationPromise ??= openRegistration().catch((error) => {
    registrationPromise = undefined;
    logError("registration:failed", error);
    throw error;
  });
  return registrationPromise;
}

async function openRegistration() {
  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    log("registration:create", { build: PAGE_BUILD });
    registration = await register(PAGE_BUILD);
  } else {
    log("registration:restore", registrationState(registration));
    observe(registration);
  }
  if (!registration.active) await waitForActive(registration);
  return registration;
}

/** @param {ServiceWorkerRegistration} registration */
async function inspect(registration) {
  if (registration.active) {
    const metadata = await ping(registration.active).catch((error) => {
      logError("active:unresponsive", error, workerState(registration.active));
      return null;
    });
    if (metadata) {
      activeBuild = metadata.buildVersion;
      log("active:metadata", metadataState(metadata, registration.active));
      applyWorkerMetadata(metadata);
      if (metadata.updateReady) await useCandidate(registration.active, metadata);
    }
  }
  if (registration.waiting) await useCandidate(registration.waiting);
}

async function checkForUpdate() {
  const remote = await remoteVersion();
  log("check", { pageBuild: PAGE_BUILD, ...remote });
  if (remote.version === PAGE_BUILD) {
    if (availableBuild && availableBuild !== PAGE_BUILD) {
      log("update:stale-candidate", {
        candidateBuild: availableBuild,
        remoteBuild: remote.version,
      });
      availableBuild = undefined;
      waitingWorker = undefined;
      notifyUpdates();
      void install(PAGE_BUILD).catch((error) => logError("update:restore-failed", error));
    }
    return remote.version;
  }
  if (availableBuild !== remote.version) {
    availableBuild = remote.version;
    log("update:available", { pageBuild: PAGE_BUILD, remoteBuild: remote.version });
    notifyUpdates();
  }
  void install(remote.version).catch((error) => logError("update:install-failed", error));
  return remote.version;
}

/** @param {string} build @returns {Promise<ServiceWorker | null>} */
function install(build) {
  if (installPromise)
    return installingBuild === build ? installPromise : installPromise.then(() => install(build));
  installingBuild = build;
  installPromise = installBuild(build).finally(() => {
    installPromise = undefined;
    installingBuild = undefined;
  });
  return installPromise;
}

/** @param {string} build */
async function installBuild(build) {
  let registration = await getRegistration();
  let worker = findWorker(registration, build);
  if (!worker) {
    log("update:register", { build, scriptUrl: workerUrl(build).href });
    registration = await register(build);
    registrationPromise = Promise.resolve(registration);
    worker = findWorker(registration, build) ?? registration.installing;
  }
  if (!worker) throw new Error("WebKit returned no worker for the requested update.");

  let metadata = worker.state === "installing" ? null : await ping(worker).catch(() => null);
  if (metadata && workerBuild(metadata) !== build) {
    log("update:revalidate", { expected: build, received: workerBuild(metadata) });
    await registration.update();
    worker = registration.installing ?? findWorker(registration, build);
  }

  worker = await waitForInstalled(worker);
  if (!worker) throw new Error("The service worker became redundant during installation.");
  metadata = await ping(worker);
  const installedBuild = workerBuild(metadata);
  if (installedBuild !== build)
    throw new Error(`Expected worker ${build.slice(0, 12)}, received ${installedBuild}.`);
  if (worker.state === "installed" || metadata.updateReady) await useCandidate(worker, metadata);
  return worker;
}

/** @param {string} build */
async function register(build) {
  const registration = await navigator.serviceWorker.register(workerUrl(build), {
    type: "classic",
    updateViaCache: "none",
  });
  log("registration:resolved", { build, ...registrationState(registration) });
  observe(registration);
  return registration;
}

/** @param {ServiceWorkerRegistration} registration */
function observe(registration) {
  observeWorker(registration.installing, "installing");
  observeWorker(registration.waiting, "waiting");
  observeWorker(registration.active, "active");
  if (observedRegistrations.has(registration)) return;
  observedRegistrations.add(registration);
  registration.addEventListener("updatefound", () => {
    log("registration:updatefound", registrationState(registration));
    observeWorker(registration.installing, "installing");
  });
}

/**
 * @param {ServiceWorker | null} worker
 * @param {string} slot
 */
function observeWorker(worker, slot) {
  if (!worker || observedWorkers.has(worker)) return;
  observedWorkers.add(worker);
  const report = () => log("worker:state", { slot, ...workerState(worker) });
  worker.addEventListener("statechange", report);
  report();
}

/**
 * @param {ServiceWorker} worker
 * @param {Record<string, any>} [metadata]
 */
async function useCandidate(worker, metadata) {
  const info = metadata ?? (await ping(worker));
  const build = workerBuild(info);
  if (!build) throw new Error("The service worker did not report its build.");
  if (build === activeBuild && !info.updateReady) {
    log("update:duplicate", metadataState(info, worker));
    return;
  }
  waitingWorker = worker;
  if (build !== PAGE_BUILD) availableBuild = build;
  applyWorkerMetadata(info);
  log("update:ready", metadataState(info, worker));
  notifyUpdates();
}

/**
 * @param {ServiceWorkerRegistration} registration
 * @param {string} build
 */
function findWorker(registration, build) {
  const url = workerUrl(build).href;
  return [registration.installing, registration.waiting, registration.active].find(
    (worker) => worker?.scriptURL === url,
  );
}

/** @param {string} build */
function workerUrl(build) {
  const url = new URL(WORKER_URL, location.href);
  // WebKit reuses register() calls whose script URL is unchanged without
  // fetching the script. A build query enters its update path while keeping
  // one physical service-worker.js file on the server.
  url.searchParams.set("build", build);
  return url;
}

async function remoteVersion() {
  const url = new URL(VERSION_URL, location.href);
  url.searchParams.set("check", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Web version check failed with ${response.status}.`);
  const version = String((await response.json())?.version ?? "");
  if (!version) throw new Error("Web version check returned no version.");
  return {
    version,
    etag: response.headers.get("etag"),
    cacheControl: response.headers.get("cache-control"),
    age: response.headers.get("age"),
    lastModified: response.headers.get("last-modified"),
  };
}

function startMonitor() {
  if (monitoring) return;
  monitoring = true;
  const check = () => {
    if (document.visibilityState === "visible")
      void checkForUpdate().catch((error) => logError("check:failed", error));
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    log("controller:changed", workerState(navigator.serviceWorker.controller));
    waitingWorker = undefined;
    notifyUpdates();
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "worker-activated")
      log("worker:activated", metadataState(event.data, event.source));
  });
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  setInterval(check, CHECK_INTERVAL_MS);
  log("monitor:start", { intervalMs: CHECK_INTERVAL_MS });
}

function notifyUpdates() {
  for (const listener of updateListeners) listener(updateReady());
}

/** @param {(ready: boolean) => void} listener */
export function subscribeToServiceWorkerUpdates(listener) {
  if (DEVELOPMENT) {
    listener(false);
    return () => {};
  }
  updateListeners.add(listener);
  listener(updateReady());
  return () => updateListeners.delete(listener);
}

/** @param {(upgrade: ReturnType<typeof nativeRequirement>) => void} listener */
export function subscribeToNativeUpgrade(listener) {
  nativeListeners.add(listener);
  listener(nativeUpgrade);
  return () => nativeListeners.delete(listener);
}

/** @typedef {{ kind: "active" | "checking" | "development" | "error" | "installing" | "off" | "unsupported" | "update-ready"; label: string; detail: string; hash: string }} ServiceWorkerStatus */

/** @returns {Promise<ServiceWorkerStatus>} */
export async function getServiceWorkerStatus() {
  if (DEVELOPMENT)
    return status("development", "SW DEV", "The service worker is disabled in development.");
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return status("unsupported", "SW UNSUPPORTED", "This webview has no service worker support.");
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return status("off", "SW OFF", "No service worker is registered.");
    const active = registration.active ?? navigator.serviceWorker.controller;
    const metadata = active ? await ping(active).catch(() => ({})) : {};
    const hash = String(metadata.buildVersion ?? "—").slice(0, 12);
    if (registration.waiting || waitingWorker || availableBuild)
      return status(
        "update-ready",
        "SW UPDATE READY",
        availableBuild
          ? `Running ${hash}; web build ${availableBuild.slice(0, 12)} is available.`
          : "An application update is waiting for activation.",
        hash,
      );
    if (registration.installing)
      return status("installing", "SW INSTALLING", "An application update is being cached.", hash);
    if (!active) return status("checking", "SW STARTING", "The registration is settling.");
    return status("active", "SW ACTIVE", `Service worker ${hash} is serving the app.`, hash);
  } catch (error) {
    return status("error", "SW ERROR", error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {ServiceWorkerStatus["kind"]} kind
 * @param {string} label
 * @param {string} detail
 * @param {string} [hash]
 */
function status(kind, label, detail, hash = "—") {
  return { kind, label, detail, hash };
}

/** @param {(status: ServiceWorkerStatus) => void} listener */
export function subscribeToServiceWorkerStatus(listener) {
  let disposed = false;
  const refresh = () =>
    void getServiceWorkerStatus().then((value) => {
      if (!disposed) listener(value);
    });
  const unsubscribe = subscribeToServiceWorkerUpdates(refresh);
  navigator.serviceWorker?.addEventListener("controllerchange", refresh);
  refresh();
  return () => {
    disposed = true;
    unsubscribe();
    navigator.serviceWorker?.removeEventListener("controllerchange", refresh);
  };
}

/** @param {{ reload?: boolean }} [options] */
export async function activateServiceWorkerUpdate({ reload = true } = {}) {
  if (DEVELOPMENT || nativeUpgrade) return false;
  try {
    let remoteBuild;
    try {
      remoteBuild = await checkForUpdate();
    } catch (error) {
      logError("activation:check-unavailable", error);
    }
    if (remoteBuild === PAGE_BUILD && activeBuild === PAGE_BUILD) return false;

    const targetBuild = remoteBuild && remoteBuild !== PAGE_BUILD ? remoteBuild : availableBuild;
    if (targetBuild) await install(targetBuild);
    if (nativeUpgrade) return false;

    const registration = await getRegistration();
    let worker = targetBuild ? findWorker(registration, targetBuild) : undefined;
    worker ??= targetBuild ? waitingWorker : (registration.waiting ?? waitingWorker);
    if (!worker) throw new Error("WebKit did not expose a waiting worker.");
    if (targetBuild) {
      const metadata = await ping(worker);
      if (workerBuild(metadata) !== targetBuild)
        throw new Error("The waiting worker does not match the available web build.");
    }
    log("activation:start", workerState(worker));
    const controlled = waitForController(worker);
    await approve(worker);
    await controlled;
    if (reload) location.reload();
    return true;
  } catch (error) {
    logError("activation:fallback", error);
    if (!reload) return false;
    try {
      await remoteVersion();
    } catch (networkError) {
      logError("activation:deferred-offline", networkError);
      return false;
    }
    await resetAndReload("activation-failed");
    return true;
  }
}

export async function forceServiceWorkerUpdate() {
  if (DEVELOPMENT || !("serviceWorker" in navigator)) return location.reload();
  await remoteVersion();
  await resetAndReload("manual-reset");
}

/** @param {string} reason */
async function resetAndReload(reason) {
  const registration = await navigator.serviceWorker.getRegistration();
  const unregistered = registration ? await registration.unregister() : false;
  const caches = await removeShellCaches();
  log("reset:reload", { reason, unregistered, caches });
  location.reload();
}

async function disableDevelopmentWorker() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const controlled = Boolean(navigator.serviceWorker.controller);
  const unregistered = await registration.unregister();
  const caches = await removeShellCaches();
  log("development:cleanup", { unregistered, caches, controlled });
  if (controlled) location.reload();
}

async function removeShellCaches() {
  const names = await caches.keys();
  const shellCaches = names.filter(
    (name) =>
      !MEDIA_CACHES.has(name) &&
      ["iroh-fm-shell-", "iroh-fm-"].some((prefix) => name.startsWith(prefix)),
  );
  await Promise.all(shellCaches.map((name) => caches.delete(name)));
  return shellCaches;
}

/** @param {ServiceWorker} worker */
function approve(worker) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        if (event.data?.type === "update-activated") resolve(undefined);
        else reject(new Error(event.data?.error ?? "The update could not be activated."));
      };
      worker.postMessage({ type: "activate-update" }, [channel.port2]);
    }),
    "The worker did not approve activation.",
  );
}

/** @param {ServiceWorker} worker */
function waitForController(worker) {
  if (worker.state === "activated" && navigator.serviceWorker.controller === worker)
    return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => {
      const changed = () => {
        if (navigator.serviceWorker.controller !== worker) return;
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
        resolve(undefined);
      };
      navigator.serviceWorker.addEventListener("controllerchange", changed);
    }),
    "The updated worker did not take control.",
  );
}

/** @param {ServiceWorkerRegistration} registration */
function waitForActive(registration) {
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error("The registration has no worker."));
  return waitForState(
    worker,
    ["activated"],
    "The initial worker did not activate.",
    INSTALL_TIMEOUT_MS,
  );
}

/** @param {ServiceWorker | null | undefined} worker */
function waitForInstalled(worker) {
  if (!worker || worker.state === "redundant") return Promise.resolve(null);
  if (["installed", "activating", "activated"].includes(worker.state))
    return Promise.resolve(worker);
  return waitForState(
    worker,
    ["installed", "activating", "activated"],
    "The worker did not install.",
    INSTALL_TIMEOUT_MS,
  );
}

/**
 * @param {ServiceWorker} worker
 * @param {string[]} accepted
 * @param {string} message
 * @param {number} timeoutMs
 */
function waitForState(worker, accepted, message, timeoutMs) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const changed = () => {
        if (!accepted.includes(worker.state) && worker.state !== "redundant") return;
        worker.removeEventListener("statechange", changed);
        if (worker.state === "redundant") reject(new Error(message));
        else resolve(worker);
      };
      worker.addEventListener("statechange", changed);
      changed();
    }),
    message,
    timeoutMs,
  );
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} message
 * @param {number} [timeoutMs]
 */
function withTimeout(promise, message, timeoutMs = TIMEOUT_MS) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

/** @param {ServiceWorker} worker */
function ping(worker) {
  return withTimeout(
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        if (event.data?.type !== "version") return;
        channel.port1.close();
        resolve(event.data);
      };
      worker.postMessage({ type: "version" }, [channel.port2]);
    }),
    "The worker did not report its metadata.",
  );
}

/** @param {ServiceWorkerRegistration} registration */
function registrationState(registration) {
  return {
    scope: registration.scope,
    updateViaCache: registration.updateViaCache,
    active: registration.active?.scriptURL,
    waiting: registration.waiting?.scriptURL,
    installing: registration.installing?.scriptURL,
  };
}

/** @param {ServiceWorker | MessageEventSource | null | undefined} worker */
function workerState(worker) {
  return worker && "scriptURL" in worker
    ? { state: worker.state, scriptUrl: worker.scriptURL }
    : { state: null, scriptUrl: null };
}

/**
 * @param {Record<string, any>} metadata
 * @param {ServiceWorker | MessageEventSource | null | undefined} worker
 */
function metadataState(metadata, worker) {
  return {
    ...workerState(worker),
    shellBuild: metadata.buildVersion,
    workerBuild: workerBuild(metadata),
    desktopEpoch: metadata.nativeEpochs?.Desktop?.minimum,
    desktopCommit: metadata.nativeEpochs?.Desktop?.commit,
    androidEpoch: metadata.nativeEpochs?.Android?.minimum,
    androidCommit: metadata.nativeEpochs?.Android?.commit,
  };
}

/** @param {Record<string, any>} metadata */
function workerBuild(metadata) {
  return String(metadata.workerBuildVersion ?? metadata.buildVersion ?? "");
}

/**
 * @param {string} event
 * @param {Record<string, any>} [details]
 */
function log(event, details = {}) {
  console.info(`[sw client ${PAGE_BUILD.slice(0, 12)}]`, event, details);
}

/**
 * @param {string} event
 * @param {unknown} error
 * @param {Record<string, any>} [details]
 */
function logError(event, error, details = {}) {
  console.error(`[sw client ${PAGE_BUILD.slice(0, 12)}]`, event, {
    ...details,
    error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  });
}
