import { longPress } from "../src/lib/ui/long-press.js";

import assert from "node:assert/strict";
import { test } from "node:test";

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const element = new EventTarget();
  element.draggable = true;
  let opens = 0;
  const cleanup = longPress(() => opens++)(element);
  t.after(cleanup);
  const pointer = (type, pointerType = "touch", clientX = 0) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerType, button: 0, clientX, clientY: 0 });
    element.dispatchEvent(event);
    return event;
  };
  return { element, pointer, cleanup, opens: () => opens };
}

for (const pointerType of ["touch", "pen"]) {
  test(`${pointerType} hold disables native dragging and opens actions`, (t) => {
    const { element, pointer, opens } = setup(t);
    pointer("pointerdown", pointerType);
    assert.equal(element.draggable, false);
    t.mock.timers.tick(500);
    assert.equal(opens(), 1);
    pointer("pointerup", pointerType);
    assert.equal(pointer("click", pointerType).defaultPrevented, true);
    pointer("pointerdown", "mouse");
    assert.equal(element.draggable, true);
    t.mock.timers.tick(500);
    assert.equal(opens(), 1);
  });
}

for (const end of ["pointerup", "pointercancel", "pointermove"]) {
  test(`${end} cancels a pending hold without blocking scrolling`, (t) => {
    const { pointer, opens } = setup(t);
    assert.equal(pointer("pointerdown").defaultPrevented, false);
    assert.equal(pointer(end, "touch", 20).defaultPrevented, false);
    t.mock.timers.tick(500);
    assert.equal(opens(), 0);
  });
}

test("cleanup restores dragging and cancels the hold", (t) => {
  const { element, pointer, cleanup, opens } = setup(t);
  pointer("pointerdown");
  cleanup();
  assert.equal(element.draggable, true);
  t.mock.timers.tick(500);
  assert.equal(opens(), 0);
});
