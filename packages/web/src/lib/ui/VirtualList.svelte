<script>
  import { untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";

  /**
   * @typedef {{ align?: "start" | "center" | "end" | "auto" }} ScrollOptions
   * @typedef {{ scrollToIndex: (index: number, options?: ScrollOptions) => void }} VirtualListApi
   * @typedef {Object} Props
   * @property {any[]} items
   * @property {(item: any) => string | number} getKey
   * @property {number | ((item: any, index: number) => number)} estimateSize
   * @property {boolean} [measureItems]
   * @property {number} [overscan]
   * @property {number | null} [initialIndex]
   * @property {"start" | "center" | "end"} [initialAlign]
   * @property {VirtualListApi | undefined} [api]
   * @property {import("svelte").Snippet<[any, number]>} children
   */

  /** @type {Props} */
  let {
    items,
    getKey,
    estimateSize,
    measureItems = true,
    overscan = 400,
    initialIndex = null,
    initialAlign = "center",
    api = $bindable(),
    children,
  } = $props();

  /** @type {HTMLElement | undefined} */
  let viewport;
  let viewportSize = $state(0);
  let scrollOffset = $state(0);
  const measuredSizes = new SvelteMap();
  /** @type {ResizeObserver | undefined} */
  let itemObserver;
  /** @type {WeakMap<Element, { id: string, index: number, estimate: number }>} */
  const observedItems = new WeakMap();

  /** @param {any} item @param {number} index */
  function estimatedSize(item, index) {
    const value = typeof estimateSize === "function" ? estimateSize(item, index) : estimateSize;
    return Math.max(1, Number.isFinite(value) ? value : 1);
  }

  const fixedItemSize = $derived(
    !measureItems && typeof estimateSize === "number" ? Math.max(1, estimateSize) : null,
  );

  /** @param {string | number} key @param {number} estimate */
  function measurementId(key, estimate) {
    return `${typeof key}:${String(key)}\u0000${estimate}`;
  }

  function ensureItemObserver() {
    itemObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const measurement = observedItems.get(entry.target);
        if (!measurement) continue;
        const size = entry.target.getBoundingClientRect().height;
        if (size <= 0 || measuredSizes.get(measurement.id) === size) continue;
        const previous = measuredSizes.get(measurement.id) ?? measurement.estimate;
        const anchorIndex = indexAtOffset(scrollOffset);
        measuredSizes.set(measurement.id, size);
        if (viewport && measurement.index < anchorIndex) {
          viewport.scrollTop += size - previous;
          scrollOffset = viewport.scrollTop;
        }
      }
    });
    return itemObserver;
  }

  const layout = $derived.by(() => {
    if (fixedItemSize !== null) return { offsets: null, totalSize: items.length * fixedItemSize };
    const offsets = new Array(items.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < items.length; index += 1) {
      const key = getKey(items[index]);
      const estimate = estimatedSize(items[index], index);
      offsets[index + 1] =
        offsets[index] + (measuredSizes.get(measurementId(key, estimate)) ?? estimate);
    }
    return { offsets, totalSize: offsets[items.length] ?? 0 };
  });

  /** @param {number} index */
  function offsetAt(index) {
    return fixedItemSize === null ? (layout.offsets?.[index] ?? 0) : index * fixedItemSize;
  }

  /** Find the item containing an offset, or the closest item at either edge. */
  /** @param {number} offset */
  function indexAtOffset(offset) {
    if (!items.length) return 0;
    if (fixedItemSize !== null)
      return Math.max(0, Math.min(items.length - 1, Math.floor(offset / fixedItemSize)));
    let low = 0;
    let high = items.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((layout.offsets?.[middle + 1] ?? 0) <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  const range = $derived.by(() => {
    if (!items.length) return { start: 0, end: 0 };
    const fallbackIndex = Math.max(0, Math.min(items.length - 1, initialIndex ?? 0));
    const fallbackOffset = offsetAt(fallbackIndex);
    const top = viewportSize ? scrollOffset : fallbackOffset;
    const height = viewportSize || estimatedSize(items[fallbackIndex], fallbackIndex);
    const start = indexAtOffset(Math.max(0, top - overscan));
    const end = Math.min(items.length, indexAtOffset(top + height + overscan) + 1);
    return { start, end };
  });

  const visibleItems = $derived.by(() => {
    const visible = [];
    for (let index = range.start; index < range.end; index += 1)
      visible.push({ item: items[index], index, key: getKey(items[index]) });
    return visible;
  });

  /** @param {number} index @param {ScrollOptions} [options] */
  function scrollToIndex(index, options = {}) {
    if (!viewport || !items.length) return;
    const target = Math.max(0, Math.min(items.length - 1, index));
    const itemStart = offsetAt(target);
    const itemEnd = offsetAt(target + 1);
    const viewStart = viewport.scrollTop;
    const viewEnd = viewStart + viewport.clientHeight;
    const align = options.align ?? "auto";
    let next = viewStart;

    if (align === "start") next = itemStart;
    else if (align === "center")
      next = itemStart - (viewport.clientHeight - (itemEnd - itemStart)) / 2;
    else if (align === "end") next = itemEnd - viewport.clientHeight;
    else if (itemStart < viewStart) next = itemStart;
    else if (itemEnd > viewEnd) next = itemEnd - viewport.clientHeight;
    else return;

    const maximum = Math.max(0, layout.totalSize - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(maximum, next));
    scrollOffset = viewport.scrollTop;
  }

  /** @param {HTMLElement} node */
  function setupViewport(node) {
    return untrack(() => {
      viewport = node;
      api = { scrollToIndex };
      const updateSize = () => {
        viewportSize = node.clientHeight;
        scrollOffset = node.scrollTop;
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(node);

      if (initialIndex === null || !items.length) {
        node.style.visibility = "visible";
      } else {
        scrollToIndex(initialIndex, { align: initialAlign });
        requestAnimationFrame(() => {
          if (viewport !== node) return;
          scrollToIndex(initialIndex, { align: initialAlign });
          node.style.visibility = "visible";
        });
      }

      return () => {
        observer.disconnect();
        itemObserver?.disconnect();
        itemObserver = undefined;
        if (viewport === node) viewport = undefined;
        api = undefined;
      };
    });
  }

  /** @param {string | number} key @param {number} index */
  function measureItem(key, index) {
    /** @param {HTMLElement} node */
    return (node) => {
      const estimate = estimatedSize(items[index], index);
      const id = measurementId(key, estimate);
      observedItems.set(node, { id, index, estimate });
      const size = node.getBoundingClientRect().height;
      if (size > 0) measuredSizes.set(id, size);
      ensureItemObserver().observe(node);
      return () => itemObserver?.unobserve(node);
    };
  }
</script>

<div
  {@attach setupViewport}
  onscroll={(event) => (scrollOffset = event.currentTarget.scrollTop)}
  class="h-full overflow-y-auto"
  style="visibility: hidden; overscroll-behavior: contain; overflow-anchor: none;"
>
  <div class="relative w-full" style={`height:${layout.totalSize}px`}>
    <div
      class="absolute top-0 right-0 left-0"
      style={`transform:translateY(${offsetAt(range.start)}px)`}
    >
      {#each visibleItems as entry (entry.key)}
        {#if measureItems}<div
            {@attach measureItem(entry.key, entry.index)}
            data-virtual-index={entry.index}
          >
            {@render children(entry.item, entry.index)}
          </div>
        {:else}
          {@render children(entry.item, entry.index)}
        {/if}
      {/each}
    </div>
  </div>
</div>
