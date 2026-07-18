import { ensure_service_worker } from '$lib/service-worker.js';

export const ssr = false;
export const prerender = true;

/** @type {import('./$types').LayoutLoad} */
export function load() {
	return { serviceWorkerReady: ensure_service_worker() };
}
