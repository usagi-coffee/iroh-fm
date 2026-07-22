<script module>
  /** @typedef {{ observer: IntersectionObserver, listeners: Map<Element, (visible: boolean) => void> }} ObserverEntry */
  /** @type {Map<string, ObserverEntry>} */
  const viewportObservers = new Map();
  /** @type {WeakMap<Element, Map<string, ObserverEntry>>} */
  const rootedObservers = new WeakMap();
  /** @type {WeakMap<object, Map<string, string>>} */
  const resolvedCoverUrls = new WeakMap();

  /**
   * @param {string} id
   * @param {boolean} fullQuality
   */
  function coverKey(id, fullQuality) {
    return `${id}\u0000${fullQuality ? "full" : "thumbnail"}`;
  }

  /**
   * @param {object | null} client
   * @param {string | null} id
   * @param {boolean} fullQuality
   */
  function resolvedCoverUrl(client, id, fullQuality) {
    return client && id
      ? (resolvedCoverUrls.get(client)?.get(coverKey(id, fullQuality)) ?? null)
      : null;
  }

  /**
   * @param {Awaited<ReturnType<typeof import('@iroh-fm/client/core').ClientCore.connect>>} client
   * @param {string} id
   * @param {boolean} fullQuality
   */
  function loadCoverUrl(client, id, fullQuality) {
    const resolved = resolvedCoverUrl(client, id, fullQuality);
    if (resolved) return resolved;
    return client.coverUrl(id, { fullQuality }).then((url) => {
      if (url) {
        let urls = resolvedCoverUrls.get(client);
        if (!urls) {
          urls = new Map();
          resolvedCoverUrls.set(client, urls);
        }
        urls.set(coverKey(id, fullQuality), url);
      }
      return url;
    });
  }

  /**
   * @param {object | null} client
   * @param {string | null} id
   * @param {boolean} fullQuality
   */
  function forgetCoverUrl(client, id, fullQuality) {
    if (client && id) resolvedCoverUrls.get(client)?.delete(coverKey(id, fullQuality));
  }

  /** @param {HTMLElement} node */
  function findScrollRoot(node) {
    let parent = node.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if (/auto|scroll|overlay/.test(style.overflowY)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  /**
   * @param {HTMLElement} node
   * @param {string} rootMargin
   * @param {(visible: boolean) => void} listener
   */
  function observeVisibility(node, rootMargin, listener) {
    const root = findScrollRoot(node);
    let registry;
    if (root) {
      registry = rootedObservers.get(root);
      if (!registry) {
        registry = new Map();
        rootedObservers.set(root, registry);
      }
    } else registry = viewportObservers;

    let entry = registry.get(rootMargin);
    if (!entry) {
      /** @type {Map<Element, (visible: boolean) => void>} */
      const listeners = new Map();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const observed of entries) listeners.get(observed.target)?.(observed.isIntersecting);
        },
        { root, rootMargin },
      );
      entry = { observer, listeners };
      registry.set(rootMargin, entry);
    }

    entry.listeners.set(node, listener);
    entry.observer.observe(node);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(node);
      entry.observer.unobserve(node);
      if (!entry.listeners.size) {
        entry.observer.disconnect();
        registry.delete(rootMargin);
      }
    };
  }
</script>

<script>
  /**
   * @typedef {Object} Props
   * @property {Awaited<ReturnType<typeof import('@iroh-fm/client/core').ClientCore.connect>> | null} client
   * @property {string | null} [id]
   * @property {string} [title]
   * @property {string} [class]
   * @property {string} [rootMargin]
   * @property {boolean} [fullQuality]
   */
  /** @typedef {{ client: Awaited<ReturnType<typeof import('@iroh-fm/client/core').ClientCore.connect>> | null, id: string | null, fullQuality: boolean }} FailedRequest */
  /** @type {Props} */
  const {
    client,
    id = null,
    title = "",
    class: className = "",
    rootMargin = "100%",
    fullQuality = false,
  } = $props();
  const LOAD_DELAY_MS = 150;

  /** @param {string} value */
  function titleHue(value) {
    let total = 27;
    for (const character of value) total += character.charCodeAt(0);
    return total % 360;
  }

  let visible = $state(false);
  let failedRequest = $state(/** @type {FailedRequest | null} */ (null));

  function imageError() {
    forgetCoverUrl(client, id, fullQuality);
    failedRequest = { client, id, fullQuality };
  }

  /** @param {string} requestedRootMargin */
  function loadVisibleCover(requestedRootMargin) {
    /** @param {HTMLElement} node */
    return (node) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      let stopObserving = () => {};
      const hide = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const show = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          stopObserving();
        }, LOAD_DELAY_MS);
      };
      if (!("IntersectionObserver" in window)) {
        show();
        return hide;
      }
      stopObserving = observeVisibility(node, requestedRootMargin, (intersecting) => {
        if (intersecting) show();
        else hide();
      });
      return () => {
        stopObserving();
        hide();
      };
    };
  }
</script>

{#snippet fallback()}
  <div class="cover-fallback" aria-hidden="true">
    <span>{title.trim().slice(0, 1).toUpperCase() || "♪"}</span>
    <div class="groove one"></div>
    <div class="groove two"></div>
  </div>
{/snippet}

{#snippet image(/** @type {string} */ url)}
  <img src={url} alt={`${title} cover`} onerror={imageError} />
{/snippet}

{const imageFailed = $derived(
  Boolean(
    failedRequest &&
    failedRequest.client === client &&
    failedRequest.id === id &&
    failedRequest.fullQuality === fullQuality,
  ),
)}
{const hue = $derived(titleHue(title))}
{const resolvedSource = $derived(client && id ? resolvedCoverUrl(client, id, fullQuality) : null)}
{const coverSource = $derived(
  resolvedSource ?? (client && id && visible ? loadCoverUrl(client, id, fullQuality) : null),
)}
<div
  {@attach loadVisibleCover(rootMargin)}
  class={`cover ${className}`}
  style={`--cover-hue: ${hue}`}
>
  {#if typeof coverSource === "string" && !imageFailed}
    {@render image(coverSource)}
  {:else}
    <svelte:boundary>
      {#if coverSource && !imageFailed}
        {@render image(await coverSource)}
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
  {/if}
</div>

<style>
  .cover {
    position: relative;
    overflow: hidden;
    aspect-ratio: 1;
    background: hsl(var(--cover-hue) 28% 28%);
    color: white;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cover-fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 68% 28%, hsl(var(--cover-hue) 75% 65%), transparent 27%),
      linear-gradient(
        145deg,
        hsl(var(--cover-hue) 55% 45%),
        hsl(calc(var(--cover-hue) + 42) 38% 18%)
      );
  }
  .cover-fallback::after {
    content: "";
    position: absolute;
    width: 62%;
    height: 62%;
    border-radius: 50%;
    border: 0.0625rem solid rgb(255 255 255 / 0.32);
    box-shadow:
      0 0 0 0.75rem rgb(0 0 0 / 0.08),
      0 0 0 1.5rem rgb(255 255 255 / 0.06);
  }
  .cover-fallback span {
    position: relative;
    z-index: 2;
    font-family: var(--font-display);
    font-size: clamp(2rem, 5vw, 4.5rem);
    font-style: italic;
    text-shadow: 0 0.125rem 1.25rem rgb(0 0 0 / 0.25);
  }
  .groove {
    position: absolute;
    border: 0.0625rem solid rgb(255 255 255 / 0.18);
    border-radius: 50%;
  }
  .groove.one {
    width: 82%;
    height: 82%;
  }
  .groove.two {
    width: 43%;
    height: 43%;
  }
</style>
