<script>
	// @ts-nocheck
	let { client, id = null, title = '', class: className = '', rootMargin = '240px' } = $props();
	let element = $state();
	let visible = $state(false);
	let imageFailed = $state(false);
	let hue = $derived([...title].reduce((total, char) => total + char.charCodeAt(0), 27) % 360);
	let coverPromise = $derived(visible && client && id ? client.coverUrl(id) : null);

	function findScrollRoot(node) {
		let parent = node.parentElement;
		while (parent) {
			const style = getComputedStyle(parent);
			if (/auto|scroll|overlay/.test(style.overflowY)) return parent;
			parent = parent.parentElement;
		}
		return null;
	}

	$effect(() => {
		if (!element) return;
		if (!('IntersectionObserver' in window)) {
			visible = true;
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				visible = true;
				observer.disconnect();
			}
		}, { root: findScrollRoot(element), rootMargin });
		observer.observe(element);
		return () => observer.disconnect();
	});

	$effect(() => {
		id;
		imageFailed = false;
	});

</script>

{#snippet fallback()}
	<div class="cover-fallback" aria-hidden="true">
		<span>{title.trim().slice(0, 1).toUpperCase() || '♪'}</span>
		<div class="groove one"></div><div class="groove two"></div>
	</div>
{/snippet}

<div bind:this={element} class={`cover ${className}`} style={`--cover-hue: ${hue}`}>
	<svelte:boundary>
		{#if coverPromise && !imageFailed}
			<img src={await coverPromise} alt={`${title} cover`} onerror={() => (imageFailed = true)} />
		{:else}
			{@render fallback()}
		{/if}

		{#snippet pending()}
			{@render fallback()}
		{/snippet}

		{#snippet failed()}
			{@render fallback()}
		{/snippet}
	</svelte:boundary>
</div>

<style>
	.cover { position: relative; overflow: hidden; aspect-ratio: 1; background: hsl(var(--cover-hue) 28% 28%); color: white; }
	.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
	.cover-fallback { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 68% 28%, hsl(var(--cover-hue) 75% 65%), transparent 27%), linear-gradient(145deg, hsl(var(--cover-hue) 55% 45%), hsl(calc(var(--cover-hue) + 42) 38% 18%)); }
	.cover-fallback::after { content: ''; position: absolute; width: 62%; height: 62%; border-radius: 50%; border: 1px solid rgb(255 255 255 / .32); box-shadow: 0 0 0 12px rgb(0 0 0 / .08), 0 0 0 24px rgb(255 255 255 / .06); }
	.cover-fallback span { position: relative; z-index: 2; font-family: var(--font-display); font-size: clamp(2rem, 5vw, 4.5rem); font-style: italic; text-shadow: 0 2px 20px rgb(0 0 0 / .25); }
	.groove { position: absolute; border: 1px solid rgb(255 255 255 / .18); border-radius: 50%; }
	.groove.one { width: 82%; height: 82%; } .groove.two { width: 43%; height: 43%; }
</style>
