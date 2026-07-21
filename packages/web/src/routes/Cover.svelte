<script>
  /**
   * @typedef {Object} Props
   * @property {import('@iroh-fm/client').MusicClient | null} client
   * @property {string | null} [id]
   * @property {string} [title]
   * @property {string} [class]
   * @property {string} [rootMargin]
   * @property {boolean} [fullQuality]
   */
  /** @typedef {{ client: import('@iroh-fm/client').MusicClient | null, id: string | null, fullQuality: boolean }} FailedRequest */
  /** @type {Props} */
  let {
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
  let imageFailed = $derived(
    Boolean(
      failedRequest &&
      failedRequest.client === client &&
      failedRequest.id === id &&
      failedRequest.fullQuality === fullQuality,
    ),
  );
  let hue = $derived(titleHue(title));
  let coverPromise = $derived(
    visible && client && id ? client.coverUrl(id, { fullQuality }) : null,
  );

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

  /** @param {string} requestedRootMargin */
  function loadVisibleCover(requestedRootMargin) {
    /** @param {HTMLElement} node */
    return (node) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      /** @type {IntersectionObserver | undefined} */
      let observer;
      const hide = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const show = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          observer?.disconnect();
        }, LOAD_DELAY_MS);
      };
      if (!("IntersectionObserver" in window)) {
        show();
        return hide;
      }
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) show();
          else hide();
        },
        { root: findScrollRoot(node), rootMargin: requestedRootMargin },
      );
      observer.observe(node);
      return () => {
        observer.disconnect();
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

<div
  {@attach loadVisibleCover(rootMargin)}
  class={`cover ${className}`}
  style={`--cover-hue: ${hue}`}
>
  <svelte:boundary>
    {#if coverPromise && !imageFailed}
      <img
        src={await coverPromise}
        alt={`${title} cover`}
        onerror={() => (failedRequest = { client, id, fullQuality })}
      />
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
