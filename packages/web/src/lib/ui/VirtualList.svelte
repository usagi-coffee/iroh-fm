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
   * @property {boolean | "uniform"} [measureItems]
   * @property {number} [overscan]
   * @property {number} [paddingStart]
   * @property {number} [paddingEnd]
   * @property {number | null} [initialIndex]
   * @property {"start" | "center" | "end"} [initialAlign]
   * @property {boolean} [overscroll]
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
    paddingStart = 0,
    paddingEnd = 0,
    initialIndex = null,
    initialAlign = "center",
    overscroll = false,
    api = $bindable(),
    children,
  } = $props();

  /** @type {HTMLElement | undefined} */
  let viewport;
  let viewportSize = $state(0);
  let renderWindowOffset = $state(0);
  let pinnedToEnd = false;
  const MEASUREMENT_EPSILON = 0.5;
  const measuredSizes = new SvelteMap();
  /** @type {{ estimate: number, size: number } | null} */
  let uniformMeasurement = $state(null);
  /** @type {ResizeObserver | undefined} */
  let itemObserver;
  /** @type {Map<Element, number>} */
  const pendingMeasurements = new Map();
  /** @type {number | undefined} */
  let measurementFrame;
  /** @type {WeakMap<Element, { key: string | number, index: number }>} */
  const observedItems = new WeakMap();

  /**
   * @param {any} item
   * @param {number} index
   */
  function estimatedSize(item, index) {
    const value = typeof estimateSize === "function" ? estimateSize(item, index) : estimateSize;
    return Math.max(1, Number.isFinite(value) ? value : 1);
  }

  const leadingPadding = $derived(Math.max(0, paddingStart));
  const trailingPadding = $derived(Math.max(0, paddingEnd));
  const windowStep = $derived(Math.max(1, overscan / 2));
  const uniformMode = $derived(measureItems === "uniform");
  const numericEstimate = $derived(
    typeof estimateSize === "number" ? Math.max(1, estimateSize) : null,
  );
  const uniformEstimate = $derived(
    uniformMode ? (numericEstimate ?? (items.length ? estimatedSize(items[0], 0) : 1)) : null,
  );
  const measuredUniformSize = $derived.by(() => {
    const measurement = /** @type {{ estimate: number, size: number } | null} */ (
      uniformMeasurement
    );
    return uniformEstimate !== null && measurement?.estimate === uniformEstimate
      ? measurement.size
      : null;
  });
  const fixedItemSize = $derived(
    !measureItems && numericEstimate !== null
      ? numericEstimate
      : uniformEstimate === null
        ? null
        : (measuredUniformSize ?? uniformEstimate),
  );

  /** @param {ResizeObserverEntry} entry */
  function observedHeight(entry) {
    const borderSize = Array.isArray(entry.borderBoxSize)
      ? entry.borderBoxSize[0]
      : entry.borderBoxSize;
    return borderSize?.blockSize ?? entry.contentRect.height;
  }

  /**
   * @param {number} estimate
   * @param {number} size
   */
  function updateUniformMeasurement(estimate, size) {
    if (
      size <= 0 ||
      (uniformMeasurement?.estimate === estimate &&
        Math.abs(uniformMeasurement.size - size) < MEASUREMENT_EPSILON)
    )
      return;
    const node = viewport;
    const preserveAnchor = node?.style.visibility === "visible" && items.length > 0;
    const preserveEnd = preserveAnchor && (pinnedToEnd || isAtEnd(node));
    const anchorIndex = preserveAnchor ? indexAtOffset(node.scrollTop) : 0;
    const anchorOffset = preserveAnchor ? node.scrollTop - offsetAt(anchorIndex) : 0;
    uniformMeasurement = { estimate, size };
    if (preserveAnchor)
      queueMicrotask(() => {
        if (viewport !== node) return;
        node.scrollTop = preserveEnd
          ? maximumScrollOffset(node)
          : leadingPadding + anchorIndex * size + anchorOffset;
        updateViewportPosition(node);
      });
  }

  function flushMeasurements() {
    measurementFrame = undefined;
    const measurements = [...pendingMeasurements];
    pendingMeasurements.clear();
    const observedViewport = viewport;
    const preserveEnd = Boolean(observedViewport && (pinnedToEnd || isAtEnd(observedViewport)));
    const anchorIndex =
      observedViewport && items.length ? indexAtOffset(observedViewport.scrollTop) : 0;
    let scrollCorrection = 0;
    let layoutChanged = false;
    /** @type {{ estimate: number, size: number } | null} */
    let nextUniformMeasurement = null;
    for (const [element, size] of measurements) {
      const measurement = observedItems.get(element);
      if (!measurement || measurement.index >= items.length) continue;
      const estimate = estimatedSize(items[measurement.index], measurement.index);
      if (measureItems === "uniform") {
        if (size > 0) nextUniformMeasurement = { estimate, size };
        continue;
      }
      const previousMeasurement = measuredSizes.get(measurement.key);
      const sameEstimate = previousMeasurement?.estimate === estimate;
      const previous = sameEstimate ? previousMeasurement.size : estimate;
      if (size <= 0 || (sameEstimate && Math.abs(size - previous) < MEASUREMENT_EPSILON)) continue;
      measuredSizes.set(measurement.key, { estimate, size });
      layoutChanged = true;
      if (measurement.index < anchorIndex) scrollCorrection += size - previous;
    }
    if (nextUniformMeasurement)
      updateUniformMeasurement(nextUniformMeasurement.estimate, nextUniformMeasurement.size);
    if (observedViewport && layoutChanged)
      queueMicrotask(() => {
        if (viewport !== observedViewport) return;
        if (preserveEnd) observedViewport.scrollTop = maximumScrollOffset(observedViewport);
        else if (scrollCorrection) observedViewport.scrollTop += scrollCorrection;
        updateViewportPosition(observedViewport);
      });
  }

  function ensureItemObserver() {
    itemObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) pendingMeasurements.set(entry.target, observedHeight(entry));
      measurementFrame ??= requestAnimationFrame(flushMeasurements);
    });
    return itemObserver;
  }

  const layout = $derived.by(() => {
    if (fixedItemSize !== null)
      return {
        offsets: null,
        totalSize: leadingPadding + items.length * fixedItemSize + trailingPadding,
      };
    const offsets = Array.from({ length: items.length + 1 });
    offsets[0] = leadingPadding;
    for (let index = 0; index < items.length; index += 1) {
      const key = getKey(items[index]);
      const estimate = estimatedSize(items[index], index);
      const measurement = measuredSizes.get(key);
      offsets[index + 1] =
        offsets[index] + (measurement?.estimate === estimate ? measurement.size : estimate);
    }
    return {
      offsets,
      totalSize: (offsets[items.length] ?? leadingPadding) + trailingPadding,
    };
  });

  /** @param {number} index */
  function offsetAt(index) {
    return fixedItemSize === null
      ? (layout.offsets?.[index] ?? leadingPadding)
      : leadingPadding + index * fixedItemSize;
  }

  /** Find the item containing an offset, or the closest item at either edge. */
  /** @param {number} offset */
  function indexAtOffset(offset) {
    if (!items.length) return 0;
    if (fixedItemSize !== null)
      return Math.max(
        0,
        Math.min(items.length - 1, Math.floor((offset - leadingPadding) / fixedItemSize)),
      );
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
    const top = viewportSize ? renderWindowOffset : fallbackOffset;
    const height = viewportSize || estimatedSize(items[fallbackIndex], fallbackIndex);
    const start = indexAtOffset(Math.max(0, top - overscan));
    const scrollSlack = viewportSize ? windowStep : 0;
    const end = Math.min(items.length, indexAtOffset(top + scrollSlack + height + overscan) + 1);
    return { start, end };
  });

  const visibleItems = $derived.by(() => {
    const visible = [];
    for (let index = range.start; index < range.end; index += 1)
      visible.push({ item: items[index], index, key: getKey(items[index]) });
    return visible;
  });

  /** @param {number} offset */
  function updateScrollWindow(offset) {
    const next = Math.floor(Math.max(0, offset) / windowStep) * windowStep;
    if (next !== renderWindowOffset) renderWindowOffset = next;
  }

  /** @param {HTMLElement} node */
  function maximumScrollOffset(node) {
    return Math.max(0, node.scrollHeight - node.clientHeight);
  }

  /** @param {HTMLElement} node */
  function isAtEnd(node) {
    const maximum = maximumScrollOffset(node);
    return maximum > 2 && maximum - node.scrollTop <= 2;
  }

  /** @param {HTMLElement} node */
  function updateViewportPosition(node) {
    updateScrollWindow(node.scrollTop);
    pinnedToEnd = isAtEnd(node);
  }

  /** Prevent Chromium's Android edge stretch when CSS overscroll containment is ignored. */
  /** @param {HTMLElement} node */
  function disableTouchOverscroll(node) {
    /** @type {number | undefined} */
    let previousY;
    /** @param {TouchEvent} event */
    const start = (event) => {
      previousY = event.touches.length === 1 ? event.touches[0].clientY : undefined;
    };
    /** @param {TouchEvent} event */
    const move = (event) => {
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      if (!touch || previousY === undefined) return;
      const delta = touch.clientY - previousY;
      previousY = touch.clientY;
      const maximum = maximumScrollOffset(node);
      const beyondStart = delta > 0 && node.scrollTop <= 0;
      const beyondEnd = delta < 0 && maximum - node.scrollTop <= 1;
      if (event.cancelable && (beyondStart || beyondEnd)) event.preventDefault();
    };
    const end = () => {
      previousY = undefined;
    };

    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end, { passive: true });
    node.addEventListener("touchcancel", end, { passive: true });
    return () => {
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
    };
  }

  /**
   * @param {number} index
   * @param {ScrollOptions} [options]
   */
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

    const maximum = maximumScrollOffset(viewport);
    viewport.scrollTop = Math.max(0, Math.min(maximum, next));
    updateViewportPosition(viewport);
  }

  /** @param {HTMLElement} node */
  function setupViewport(node) {
    return untrack(() => {
      viewport = node;
      api = { scrollToIndex };
      const updateSize = () => {
        viewportSize = node.clientHeight;
        updateViewportPosition(node);
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(node);
      /** @type {number | undefined} */
      let revealFrame;

      if (initialIndex === null || !items.length) {
        node.style.visibility = "visible";
      } else {
        scrollToIndex(initialIndex, { align: initialAlign });
        if (!measureItems) node.style.visibility = "visible";
        else
          revealFrame = requestAnimationFrame(() => {
            if (viewport !== node) return;
            scrollToIndex(initialIndex, { align: initialAlign });
            node.style.visibility = "visible";
          });
      }

      return () => {
        observer.disconnect();
        if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
        itemObserver?.disconnect();
        itemObserver = undefined;
        pendingMeasurements.clear();
        if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame);
        measurementFrame = undefined;
        if (viewport === node) viewport = undefined;
        api = undefined;
      };
    });
  }

  /**
   * @param {string | number} key
   * @param {number} index
   */
  function measureItem(key, index) {
    /** @param {HTMLElement} node */
    return (node) => {
      return untrack(() => {
        const estimate = estimatedSize(items[index], index);
        observedItems.set(node, { key, index });
        if (measureItems === "uniform" && uniformMeasurement?.estimate !== estimate)
          updateUniformMeasurement(estimate, node.getBoundingClientRect().height);
        ensureItemObserver().observe(node);
        return () => {
          observedItems.delete(node);
          itemObserver?.unobserve(node);
        };
      });
    };
  }
</script>

<div
  {@attach setupViewport}
  {@attach !overscroll && disableTouchOverscroll}
  data-virtual-viewport
  onscroll={(event) => updateViewportPosition(event.currentTarget)}
  class="h-full overflow-y-auto"
  style={`visibility:hidden;overscroll-behavior:${overscroll ? "auto" : "none"};overflow-anchor:none`}
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
