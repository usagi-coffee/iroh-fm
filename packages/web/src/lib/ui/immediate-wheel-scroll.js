/**
 * Replace WebKitGTK's kinetic wheel animation with immediate, frame-coalesced
 * scrolling. Browser and PWA builds retain their native scrolling behavior.
 * @param {HTMLElement} host
 */
export function immediateTauriWheelScroll(host) {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const viewport = host.firstElementChild;
  if (!(viewport instanceof HTMLElement)) return;

  let pendingDelta = 0;
  /** @type {number | undefined} */
  let frame;
  let lineHeight = 48;
  const measure = () => {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    lineHeight = Number.isFinite(rootFontSize) ? rootFontSize * 3 : 48;
  };
  measure();

  /** @param {WheelEvent} event */
  const scroll = (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    pendingDelta +=
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * lineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
    frame ??= requestAnimationFrame(() => {
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.max(0, Math.min(maximum, viewport.scrollTop + pendingDelta));
      pendingDelta = 0;
      frame = undefined;
    });
  };

  window.addEventListener("resize", measure);
  host.addEventListener("wheel", scroll, { passive: false, capture: true });
  return () => {
    window.removeEventListener("resize", measure);
    host.removeEventListener("wheel", scroll, true);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
