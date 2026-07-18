<script>
	import { base } from '$app/paths';
	import '../app.css';

	let { children } = $props();

	function registerServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		navigator.serviceWorker.register(`${base}/service-worker.js`).catch(() => {});
	}
</script>

<svelte:window onload={registerServiceWorker} />
{@render children()}
