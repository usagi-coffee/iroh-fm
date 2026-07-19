import { dev } from "$app/environment";
import { asset } from "$app/paths";

const workerUrl = asset("/service-worker.js");
const START_TIMEOUT_MS = 30_000;
const APP_CACHE_PREFIX = "iroh-fm-";
const DATA_CACHE_NAMES = new Set(["iroh-fm-cover-art-v1", "iroh-fm-track-audio-v1"]);
let startupPromise;
/** @type {ServiceWorker | undefined} */
let waitingWorker;
let reloadRequired = false;
/** @type {Set<(ready: boolean) => void>} */
const updateListeners = new Set();
/** @type {WeakSet<ServiceWorkerRegistration>} */
const watchedRegistrations = new WeakSet();

function notifyUpdateListeners() {
  for (const listener of updateListeners) listener(Boolean(waitingWorker) || reloadRequired);
}

function registerServiceWorker() {
  return navigator.serviceWorker.register(workerUrl, {
    type: dev ? "module" : "classic",
  });
}

export function attach() {
  return () => {
    if (!("serviceWorker" in navigator)) return;

    ensure_service_worker().catch((error) => console.error("[sw] registration failed", error));
  };
}

/** @param {(ready: boolean) => void} listener */
export function subscribeToServiceWorkerUpdates(listener) {
  if (dev) {
    listener(false);
    return () => {};
  }
  updateListeners.add(listener);
  listener(Boolean(waitingWorker) || reloadRequired);
  return () => updateListeners.delete(listener);
}

/**
 * @typedef {{
 *   kind: "active" | "checking" | "development" | "error" | "installing" | "off" | "unsupported" | "update-ready";
 *   label: string;
 *   detail: string;
 * }} ServiceWorkerStatus
 */

/** @returns {Promise<ServiceWorkerStatus>} */
export async function getServiceWorkerStatus() {
  if (dev)
    return {
      kind: "development",
      label: "SW DEV",
      detail: "The production service worker is disabled during development.",
    };
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return {
      kind: "unsupported",
      label: "SW UNSUPPORTED",
      detail: "This webview does not support service workers.",
    };

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration)
      return {
        kind: "off",
        label: "SW OFF",
        detail: "No service worker is registered for this application.",
      };
    if (waitingWorker || registration.waiting || reloadRequired)
      return {
        kind: "update-ready",
        label: "SW UPDATE READY",
        detail: "A complete application update is cached and waiting to be activated.",
      };
    if (registration.installing)
      return {
        kind: "installing",
        label: "SW INSTALLING",
        detail: "The service worker is caching an application update.",
      };

    const worker = registration.active ?? navigator.serviceWorker.controller;
    if (!worker)
      return {
        kind: "checking",
        label: "SW STARTING",
        detail: "The service worker is registered but has not activated yet.",
      };

    const info = await pingWorker(worker).catch(() => ({}));
    if (info.buildVersion && info.buildVersion !== __BUILD_VERSION__)
      return {
        kind: "update-ready",
        label: "SW RELOAD READY",
        detail: `The active worker uses application build ${info.buildVersion}; this page uses ${__BUILD_VERSION__}.`,
      };
    return {
      kind: "active",
      label: "SW ACTIVE",
      detail: info.version
        ? `Service worker ${info.version} matches application build ${info.buildVersion ?? __BUILD_VERSION__}.`
        : "The service worker is active but did not report its version.",
    };
  } catch (error) {
    return {
      kind: "error",
      label: "SW ERROR",
      detail:
        error instanceof Error ? error.message : "The service worker status could not be read.",
    };
  }
}

/** @param {(status: ServiceWorkerStatus) => void} listener */
export function subscribeToServiceWorkerStatus(listener) {
  let disposed = false;
  const refresh = () => {
    getServiceWorkerStatus().then((status) => {
      if (!disposed) listener(status);
    });
  };
  const unsubscribeUpdates = subscribeToServiceWorkerUpdates(refresh);
  navigator.serviceWorker?.addEventListener("controllerchange", refresh);
  refresh();
  return () => {
    disposed = true;
    unsubscribeUpdates();
    navigator.serviceWorker?.removeEventListener("controllerchange", refresh);
  };
}

export function activateServiceWorkerUpdate() {
  if (dev) return;
  if (!waitingWorker) {
    if (reloadRequired) location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), {
    once: true,
  });
  waitingWorker.postMessage({ type: "skip-waiting" });
  setTimeout(() => location.reload(), 2_000);
}

export async function forceServiceWorkerUpdate() {
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.unregister();
    }
    if ("caches" in globalThis) {
      const keys = await globalThis.caches.keys();
      await Promise.allSettled(
        keys
          .filter((key) => key.startsWith(APP_CACHE_PREFIX) && !DATA_CACHE_NAMES.has(key))
          .map((key) => globalThis.caches.delete(key)),
      );
    }
  } finally {
    location.reload();
  }
}

export async function ensure_service_worker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  startupPromise ??= startServiceWorker().catch((error) => {
    startupPromise = undefined;
    throw error;
  });
  return startupPromise;
}

async function startServiceWorker() {
  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) registration = await registerServiceWorker();
  if (!dev) watchRegistration(registration);

  let target;
  try {
    target = await waitForActiveWorker(registration);
  } catch (firstError) {
    console.warn("[sw] first activation attempt failed, retrying", firstError);
    await registration.update();
    target = await waitForActiveWorker(registration);
  }

  const workerInfo = await pingWorker(target).catch(() => {
    console.info("[sw] worker is active; version check timed out");
    return {};
  });
  if (dev) return;
  if (workerInfo.buildVersion && workerInfo.buildVersion !== __BUILD_VERSION__) {
    reloadRequired = true;
    notifyUpdateListeners();
  }
  registration.update().catch((error) => console.warn("[sw] update check failed", error));
  const checkForUpdate = () => {
    if (document.visibilityState === "visible")
      registration.update().catch((error) => console.warn("[sw] update check failed", error));
  };
  document.addEventListener("visibilitychange", checkForUpdate);
}

/** @param {ServiceWorkerRegistration} registration */
function watchRegistration(registration) {
  if (watchedRegistrations.has(registration)) return;
  watchedRegistrations.add(registration);

  /** @param {ServiceWorker | null | undefined} worker */
  const announceWaitingWorker = (worker) => {
    if (!worker || (!navigator.serviceWorker.controller && !registration.active)) return;
    waitingWorker = worker;
    notifyUpdateListeners();
  };

  announceWaitingWorker(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed")
        announceWaitingWorker(registration.waiting ?? installing);
    });
  });
}

/** @param {ServiceWorkerRegistration} registration @returns {Promise<ServiceWorker>} */
function waitForActiveWorker(registration) {
  const current = registration.active ?? registration.waiting ?? registration.installing;
  if (current?.state === "activated") return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    let worker = current;
    const timeout = setTimeout(
      () => finish(new Error("Service worker did not start"), undefined),
      START_TIMEOUT_MS,
    );
    const changed = () => {
      if (worker?.state === "activated") finish(undefined, worker);
      else if (worker?.state === "redundant")
        finish(new Error("Service worker installation was rejected"), undefined);
    };
    const found = () => {
      worker?.removeEventListener("statechange", changed);
      worker = registration.installing ?? registration.waiting ?? registration.active;
      worker?.addEventListener("statechange", changed);
      changed();
    };
    /** @param {Error | undefined} error @param {ServiceWorker | undefined} active */
    const finish = (error, active) => {
      clearTimeout(timeout);
      registration.removeEventListener("updatefound", found);
      worker?.removeEventListener("statechange", changed);
      if (error) reject(error);
      else if (active) resolve(active);
      else reject(new Error("Service worker is not active"));
    };

    registration.addEventListener("updatefound", found);
    worker?.addEventListener("statechange", changed);
    found();
  });
}

/** @param {ServiceWorker} target */
function pingWorker(target) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => reject(new Error("Service worker did not respond")), 5_000);

    channel.port1.onmessage = (event) => {
      if (event.data?.type !== "version" && event.data?.type !== "user") return;
      console.info(`[sw] version: ${event.data.version}`);
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };

    target.postMessage({ type: "version" }, [channel.port2]);
  });
}
