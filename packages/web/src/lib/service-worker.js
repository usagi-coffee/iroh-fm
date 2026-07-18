import { dev } from '$app/environment';
import { base } from '$app/paths';

const workerUrl = `${base}/service-worker.js`;
const START_TIMEOUT_MS = 30_000;
let startupPromise;

function registerServiceWorker() {
	return navigator.serviceWorker.register(workerUrl, {
		type: dev ? 'module' : 'classic'
	});
}

export function attach() {
	return () => {
		if (!('serviceWorker' in navigator)) return;

		ensure_service_worker().catch((error) => console.error('[sw] registration failed', error));

		const reload = () => {
			if (document.startViewTransition) {
				document.startViewTransition(() => location.reload());
			} else {
				location.reload();
			}
		};

		navigator.serviceWorker.addEventListener('controllerchange', reload);
		return () => navigator.serviceWorker.removeEventListener('controllerchange', reload);
	};
}

export async function ensure_service_worker() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	startupPromise ??= startServiceWorker();
	return startupPromise;
}

async function startServiceWorker() {
	let registration = await navigator.serviceWorker.getRegistration();
	if (!registration) registration = await registerServiceWorker();

	let target;
	try {
		target = await waitForActiveWorker(registration);
	} catch (firstError) {
		console.warn('[sw] first activation attempt failed, retrying', firstError);
		await registration.update();
		target = await waitForActiveWorker(registration);
	}

	await pingWorker(target);
	return true;
}

/** @param {ServiceWorkerRegistration} registration @returns {Promise<ServiceWorker>} */
function waitForActiveWorker(registration) {
	const current = registration.active ?? registration.waiting ?? registration.installing;
	if (current?.state === 'activated') return Promise.resolve(current);

	return new Promise((resolve, reject) => {
		let worker = current;
		const timeout = setTimeout(() => finish(new Error('Service worker did not start'), undefined), START_TIMEOUT_MS);
		const changed = () => {
			if (worker?.state === 'activated') finish(undefined, worker);
			else if (worker?.state === 'redundant') finish(new Error('Service worker installation was rejected'), undefined);
		};
		const found = () => {
			worker?.removeEventListener('statechange', changed);
			worker = registration.installing ?? registration.waiting ?? registration.active;
			worker?.addEventListener('statechange', changed);
			changed();
		};
		/** @param {Error | undefined} error @param {ServiceWorker | undefined} active */
		const finish = (error, active) => {
			clearTimeout(timeout);
			registration.removeEventListener('updatefound', found);
			worker?.removeEventListener('statechange', changed);
			if (error) reject(error);
			else if (active) resolve(active);
			else reject(new Error('Service worker is not active'));
		};

		registration.addEventListener('updatefound', found);
		worker?.addEventListener('statechange', changed);
		found();
	});
}

/** @param {ServiceWorker} target */
function pingWorker(target) {
	return new Promise((resolve, reject) => {
		const channel = new MessageChannel();
		const timeout = setTimeout(() => reject(new Error('Service worker did not respond')), 5_000);

		channel.port1.onmessage = (event) => {
			if (event.data?.type !== 'version' && event.data?.type !== 'user') return;
			console.info(`[sw] version: ${event.data.version}`);
			clearTimeout(timeout);
			channel.port1.close();
			resolve(undefined);
		};

		target.postMessage({ type: 'version' }, [channel.port2]);
	});
}
