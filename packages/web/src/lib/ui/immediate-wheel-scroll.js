/**
 * Bypass WebKitGTK's kinetic wheel animation for a virtual-list viewport.
 * Browser and PWA builds keep their native scrolling behavior.
 * @param {HTMLElement} host
 */
export function immediateTauriWheelScroll(host) {
  if (!("__TAURI_INTERNALS__" in window)) return;

  /** @param {WheelEvent} event */
  const scroll = (event) => {
    const viewport = host.firstElementChild;
    if (!(viewport instanceof HTMLElement) || event.deltaY === 0) return;
    event.preventDefault();
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const lineHeight = Number.isFinite(rootFontSize) ? rootFontSize * 3 : 48;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * lineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
    viewport.scrollTop += delta;
  };

  host.addEventListener("wheel", scroll, { passive: false, capture: true });
  return () => host.removeEventListener("wheel", scroll, true);
}
