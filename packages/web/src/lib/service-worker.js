import { dev } from '$app/environment';
import { base } from '$app/paths';

const workerUrl = `${base}/service-worker.js`;

function registerServiceWorker() {
	return navigator.serviceWorker.register(workerUrl, {
		type: dev ? 'module' : 'classic'
	});
}

export function attach() {
	return () => {
		if (!('serviceWorker' in navigator)) return;

		registerServiceWorker().catch((error) => console.error('[sw] registration failed', error));

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

	let registration = await navigator.serviceWorker.getRegistration();
	if (!registration) registration = await registerServiceWorker();

	const readyRegistration = await Promise.race([
		navigator.serviceWorker.ready,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Service worker did not start')), 10_000)
		)
	]);
	const target =
		readyRegistration.active ??
		readyRegistration.waiting ??
		readyRegistration.installing ??
		navigator.serviceWorker.controller;
	if (!target) throw new Error('Service worker is not active');

	await new Promise((resolve, reject) => {
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
