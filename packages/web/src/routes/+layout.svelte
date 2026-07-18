<script>
	import { attach as serviceworker } from '$lib/service-worker.js';
	import '../app.css';

	let { children } = $props();
</script>

<div id="content" {@attach serviceworker()}>
	{@render children()}
</div>
