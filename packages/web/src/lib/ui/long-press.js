/**
 * Turn a touch or pen hold into an action without storing timers in application state.
 *
 * @param {() => void} open
 * @param {number} [delay]
 */
export function longPress(open, delay = 500) {
  /** @param {HTMLElement} element */
  return (element) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {{ x: number, y: number } | undefined} */
    let origin;
    let opened = false;
    let dragDisabled = false;

    const restoreDrag = () => {
      if (!dragDisabled) return;
      element.draggable = true;
      dragDisabled = false;
    };

    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      origin = undefined;
    };
    /** @param {PointerEvent} event */
    const start = (event) => {
      if (event.pointerType === "mouse") {
        restoreDrag();
        return;
      }
      if (event.button !== 0) return;
      // Native touch dragging can cancel the pointer before the hold timer fires.
      // Keep it disabled through release; a later mouse press restores desktop dragging.
      if (element.draggable) {
        element.draggable = false;
        dragDisabled = true;
      }
      clear();
      opened = false;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        opened = true;
        open();
      }, delay);
    };
    /** @param {PointerEvent} event */
    const move = (event) => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) clear();
    };
    /** @param {MouseEvent} event */
    const suppressClick = (event) => {
      if (!opened) return;
      opened = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    /** @param {MouseEvent} event */
    const suppressContextMenu = (event) => {
      if (!origin) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    element.addEventListener("pointerdown", start);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", clear);
    element.addEventListener("pointercancel", clear);
    element.addEventListener("click", suppressClick, true);
    element.addEventListener("contextmenu", suppressContextMenu, true);
    return () => {
      clear();
      restoreDrag();
      element.removeEventListener("pointerdown", start);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", clear);
      element.removeEventListener("pointercancel", clear);
      element.removeEventListener("click", suppressClick, true);
      element.removeEventListener("contextmenu", suppressContextMenu, true);
    };
  };
}
