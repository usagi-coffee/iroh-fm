import { ensure_service_worker } from '$lib/service-worker.js';

export const ssr = false;
export const prerender = true;

/** @type {import('./$types').LayoutLoad} */
export async function load() {
	await ensure_service_worker();
}
