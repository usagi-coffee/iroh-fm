import { dev } from "$app/environment";
import { asset } from "$app/paths";

const workerUrl = asset("/service-worker.js");
const START_TIMEOUT_MS = 30_000;
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
    if (!worker || !navigator.serviceWorker.controller) return;
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
