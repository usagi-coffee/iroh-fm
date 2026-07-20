import { dev } from "$app/environment";
import { asset } from "$app/paths";

const workerUrl = asset("/service-worker.js");
const versionUrl = asset("/_app/version.json");
const UPDATE_INTERVAL_MS = 60_000;
const UPDATE_TIMEOUT_MS = 10_000;

/** @type {Promise<ServiceWorkerRegistration> | undefined} */
let registrationPromise;
/** @type {ServiceWorker | undefined} */
let waitingWorker;
let reloadRequired = false;
let monitorStarted = false;
/** @type {any} */
let nativeBuildInfo = null;
/** @type {ReturnType<typeof nativeRequirement>} */
let nativeUpgrade = null;
/** @type {Set<(ready: boolean) => void>} */
const updateListeners = new Set();
/** @type {Set<(upgrade: ReturnType<typeof nativeRequirement>) => void>} */
const nativeUpgradeListeners = new Set();

function updateReady() {
  return Boolean(waitingWorker) || reloadRequired;
}

function notify() {
  for (const listener of updateListeners) listener(updateReady());
}

/** @param {any} buildInfo @param {Record<string, {minimum?: number, commit?: string}> | undefined} epochs */
function nativeRequirement(buildInfo, epochs) {
  const platform = buildInfo?.platform;
  const required = platform ? epochs?.[platform] : null;
  if (!required || Number(required.minimum) <= (Number(buildInfo?.epoch) || 0)) return null;
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

/** @param {ServiceWorker | undefined} worker @param {Record<string, any>} info */
function syncWorkerInfo(worker, info) {
  nativeUpgrade = nativeRequirement(nativeBuildInfo, info.nativeEpochs);
  for (const listener of nativeUpgradeListeners) listener(nativeUpgrade);
  if (info.updateReady && worker) {
    waitingWorker = worker;
    reloadRequired = false;
    notify();
  } else if (info.buildVersion && info.buildVersion !== __BUILD_VERSION__) {
    reloadRequired = true;
    notify();
  }
}

/** @param {any} buildInfo */
export function currentNativeRequirement(buildInfo) {
  return nativeRequirement(buildInfo, {
    Desktop: { minimum: __DESKTOP_EPOCH__, commit: __DESKTOP_EPOCH_COMMIT__ },
    Android: { minimum: __ANDROID_EPOCH__, commit: __ANDROID_EPOCH_COMMIT__ },
  });
}

/** @param {any} buildInfo */
function nativeNewerThanWeb(buildInfo) {
  const webEpoch =
    buildInfo?.platform === "Desktop"
      ? __DESKTOP_EPOCH__
      : buildInfo?.platform === "Android"
        ? __ANDROID_EPOCH__
        : null;
  return webEpoch !== null && Number(buildInfo?.epoch) > webEpoch;
}

async function register() {
  const existing = await navigator.serviceWorker.getRegistration();
  const remoteVersion = dev ? null : await fetchRemoteVersion().catch(() => null);
  let registration;
  try {
    registration =
      !remoteVersion && existing?.active ? existing : await registerWorker(remoteVersion);
  } catch (error) {
    // Registration may need the network, while an already installed worker
    // must remain usable offline.
    if (!existing?.active) throw error;
    registration = existing;
  }
  await requireActiveWorker(registration);
  const active = registration.active;
  if (!dev && active) {
    const info = await pingWorker(active).catch(() => null);
    if (info) syncWorkerInfo(active, info);
  }
  return registration;
}

/** @param {ServiceWorkerRegistration} registration */
function requireActiveWorker(registration) {
  if (registration.active?.state === "activated") return Promise.resolve(registration.active);
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return Promise.reject(new Error("Service worker registration has no worker."));

  return withTimeout(
    new Promise((resolve, reject) => {
      const changed = () => {
        if (worker.state === "activated") finish(undefined);
        else if (worker.state === "redundant") {
          finish(new Error("Service worker installation was rejected."));
        }
      };
      /** @param {Error | undefined} error */
      const finish = (error) => {
        worker.removeEventListener("statechange", changed);
        if (error) reject(error);
        else resolve(worker);
      };
      worker.addEventListener("statechange", changed);
      changed();
    }),
    UPDATE_TIMEOUT_MS,
    "Service worker activation timed out.",
  );
}

function getRegistration() {
  registrationPromise ??= register().catch((error) => {
    registrationPromise = undefined;
    throw error;
  });
  return registrationPromise;
}

/** @param {any} [buildInfo] */
export async function ensure_service_worker(buildInfo) {
  if (dev || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { updateReady: false, nativeUpgrade: null, nativeNewerThanWeb: false };
  }
  nativeBuildInfo = buildInfo ?? null;
  if (!dev) startUpdateMonitor();
  await getRegistration();
  return {
    updateReady: updateReady(),
    nativeUpgrade,
    nativeNewerThanWeb: nativeNewerThanWeb(buildInfo),
  };
}

function startUpdateMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;

  const check = () => {
    if (document.visibilityState !== "visible") return;
    void checkForUpdate().catch((error) => console.warn("[sw] update check failed", error));
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    waitingWorker = undefined;
    reloadRequired = false;
    notify();
    const worker = navigator.serviceWorker.controller;
    if (worker)
      void pingWorker(worker)
        .then((info) => syncWorkerInfo(worker, info))
        .catch(() => {});
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "worker-activated") return;
    syncWorkerInfo(
      /** @type {ServiceWorker | undefined} */ (event.source ?? undefined),
      event.data,
    );
  });
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  setInterval(check, UPDATE_INTERVAL_MS);
  queueMicrotask(check);
}

async function checkForUpdate() {
  const registration = await getRegistration();
  if (registration.waiting || registration.installing || !registration.active) return;

  const info = await pingWorker(registration.active).catch(() => ({}));
  syncWorkerInfo(registration.active, info);
  if (info.updateReady) {
    waitingWorker = registration.active;
    notify();
    return;
  }

  const remoteVersion = await fetchRemoteVersion().catch(() => null);
  const workerVersion = info.workerBuildVersion ?? info.version;
  if (remoteVersion && remoteVersion !== workerVersion) await registerWorker(remoteVersion);
}

/** @param {string | null} version */
function registerWorker(version) {
  const url = new URL(workerUrl, location.href);
  if (version) url.searchParams.set("v", version);
  return navigator.serviceWorker.register(url, {
    type: dev ? "module" : "classic",
    updateViaCache: "none",
  });
}

async function fetchRemoteVersion() {
  const url = new URL(versionUrl, location.href);
  url.searchParams.set("check", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Web version check failed with ${response.status}.`);
  const value = String((await response.json())?.version ?? "");
  if (!value) throw new Error("Web version check returned no version.");
  return value;
}

/** @param {(ready: boolean) => void} listener */
export function subscribeToServiceWorkerUpdates(listener) {
  if (dev) {
    listener(false);
    return () => {};
  }
  updateListeners.add(listener);
  listener(updateReady());
  return () => updateListeners.delete(listener);
}

/** @param {(upgrade: ReturnType<typeof nativeRequirement>) => void} listener */
export function subscribeToNativeUpgrade(listener) {
  nativeUpgradeListeners.add(listener);
  listener(nativeUpgrade);
  return () => nativeUpgradeListeners.delete(listener);
}

/**
 * @typedef {{
 *   kind: "active" | "checking" | "development" | "error" | "installing" | "off" | "unsupported" | "update-ready";
 *   label: string;
 *   detail: string;
 *   hash: string;
 * }} ServiceWorkerStatus
 */

/** @returns {Promise<ServiceWorkerStatus>} */
export async function getServiceWorkerStatus() {
  if (dev)
    return {
      kind: "development",
      label: "SW DEV",
      detail: "The production service worker is disabled during development.",
      hash: "—",
    };
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return {
      kind: "unsupported",
      label: "SW UNSUPPORTED",
      detail: "This webview does not support service workers.",
      hash: "—",
    };

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration)
      return {
        kind: "off",
        label: "SW OFF",
        detail: "No service worker is registered for this application.",
        hash: "—",
      };
    const active = registration.active ?? navigator.serviceWorker.controller;
    const info = active ? await pingWorker(active).catch(() => ({})) : {};
    const hash = workerHash(active ?? registration.installing, info);
    if (registration.waiting || updateReady())
      return {
        kind: "update-ready",
        label: "SW UPDATE READY",
        detail: "A complete application update is cached and waiting for activation.",
        hash,
      };
    if (registration.installing)
      return {
        kind: "installing",
        label: "SW INSTALLING",
        detail: "A complete application update is being cached.",
        hash,
      };

    if (!active)
      return {
        kind: "checking",
        label: "SW STARTING",
        detail: "The service worker registration is settling.",
        hash,
      };

    if (info.updateReady)
      return {
        kind: "update-ready",
        label: "SW UPDATE READY",
        detail: "A complete application update is cached and waiting for your approval.",
        hash,
      };
    if (info.buildVersion && info.buildVersion !== __BUILD_VERSION__)
      return {
        kind: "update-ready",
        label: "SW RELOAD READY",
        detail: `The page uses build ${__BUILD_VERSION__}; the active shell uses ${info.buildVersion}.`,
        hash,
      };
    return {
      kind: "active",
      label: "SW ACTIVE",
      detail: info.version
        ? `Service worker ${info.version} is serving application build ${info.buildVersion ?? __BUILD_VERSION__}.`
        : "The active service worker did not report its version.",
      hash,
    };
  } catch (error) {
    return {
      kind: "error",
      label: "SW ERROR",
      detail:
        error instanceof Error ? error.message : "The service worker status could not be read.",
      hash: "—",
    };
  }
}

/** @param {ServiceWorker | null} worker @param {Record<string, any>} info */
function workerHash(worker, info) {
  const scriptVersion = worker ? new URL(worker.scriptURL).searchParams.get("v") : null;
  const value = info.workerBuildVersion ?? scriptVersion ?? info.version;
  return value ? String(value).slice(0, 12) : "—";
}

/** @param {(status: ServiceWorkerStatus) => void} listener */
export function subscribeToServiceWorkerStatus(listener) {
  let disposed = false;
  const refresh = () => {
    getServiceWorkerStatus().then((status) => {
      if (!disposed) listener(status);
    });
  };
  const unsubscribe = subscribeToServiceWorkerUpdates(refresh);
  navigator.serviceWorker?.addEventListener("controllerchange", refresh);
  refresh();
  return () => {
    disposed = true;
    unsubscribe();
    navigator.serviceWorker?.removeEventListener("controllerchange", refresh);
  };
}

export async function activateServiceWorkerUpdate() {
  if (dev) return;
  if (nativeUpgrade) return;
  const registration = await getRegistration();
  let worker = registration.waiting ?? waitingWorker;
  if (!worker && registration.active) {
    const info = await pingWorker(registration.active).catch(() => ({}));
    if (info.updateReady) worker = registration.active;
  }
  if (!worker) {
    if (reloadRequired) location.reload();
    return;
  }

  await Promise.all([approveUpdate(worker), waitForController(worker)]);
  location.reload();
}

export async function forceServiceWorkerUpdate() {
  if (dev || !("serviceWorker" in navigator)) {
    location.reload();
    return;
  }

  const registration = await getRegistration();
  if (registration.active) {
    const info = await pingWorker(registration.active).catch(() => ({}));
    if (info.updateReady) {
      waitingWorker = registration.active;
      await activateServiceWorkerUpdate();
      return;
    }
    const remoteVersion = await fetchRemoteVersion();
    const workerVersion = info.workerBuildVersion ?? info.version;
    if (remoteVersion !== workerVersion) {
      const updated = await registerWorker(remoteVersion);
      const candidate = workerForVersion(updated, remoteVersion);
      const worker = await waitForInstallation(candidate ?? updated.installing);
      if (!worker) throw new Error("The cache-busted service worker was not installed.");
      waitingWorker = worker;
      await activateServiceWorkerUpdate();
      return;
    }
  }
  if (registration.waiting) {
    waitingWorker = registration.waiting;
    await activateServiceWorkerUpdate();
    return;
  }

  const worker = registration.waiting ?? (await waitForInstallation(registration.installing));
  if (worker?.state === "installed") {
    waitingWorker = registration.waiting ?? worker;
    await activateServiceWorkerUpdate();
    return;
  }

  // No newer worker was found. Keep and reload the complete active shell.
  location.reload();
}

/** @param {ServiceWorkerRegistration} registration @param {string} version */
function workerForVersion(registration, version) {
  return [registration.installing, registration.waiting, registration.active].find((worker) => {
    if (!worker) return false;
    return new URL(worker.scriptURL).searchParams.get("v") === version;
  });
}

/** @param {ServiceWorker} worker */
function approveUpdate(worker) {
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
    UPDATE_TIMEOUT_MS,
    "The service worker did not approve the update in time.",
  );
}

/** @param {ServiceWorker} worker */
function waitForController(worker) {
  if (worker.state === "activated" && navigator.serviceWorker.controller === worker) {
    return Promise.resolve();
  }

  /** @type {() => void} */
  let changed = () => {};
  const controlled = new Promise((resolve) => {
    changed = () => {
      if (navigator.serviceWorker.controller === worker) resolve(undefined);
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
  });
  return withTimeout(
    controlled,
    UPDATE_TIMEOUT_MS,
    "The updated service worker did not take control in time.",
  ).finally(() => navigator.serviceWorker.removeEventListener("controllerchange", changed));
}

/** @param {ServiceWorker | null} worker */
function waitForInstallation(worker) {
  if (!worker || worker.state === "redundant") return Promise.resolve(null);
  if (["installed", "activating", "activated"].includes(worker.state))
    return Promise.resolve(worker);

  return withTimeout(
    new Promise((resolve) => {
      const changed = () => {
        if (!["installed", "activating", "activated", "redundant"].includes(worker.state)) return;
        worker.removeEventListener("statechange", changed);
        resolve(worker.state === "redundant" ? null : worker);
      };
      worker.addEventListener("statechange", changed);
    }),
    UPDATE_TIMEOUT_MS,
    "The service worker update timed out.",
  );
}

/** @template T @param {Promise<T>} promise @param {number} timeoutMs @param {string} message */
function withTimeout(promise, timeoutMs, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

/** @param {ServiceWorker} worker */
function pingWorker(worker) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => reject(new Error("Service worker did not respond")), 5_000);
    channel.port1.onmessage = (event) => {
      if (event.data?.type !== "version") return;
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage({ type: "version" }, [channel.port2]);
  });
}
