import { mount, unmount } from "svelte";
import { createSubscriber } from "svelte/reactivity";

/** @type {(() => void) | undefined} */
let notifyPending;
let pendingModals = 0;
const subscribePending = createSubscriber((notify) => {
  notifyPending = notify;
  return () => {
    notifyPending = undefined;
  };
});

/**
 * Mount a component that implements the `dismiss(result)` modal contract.
 *
 * @template Result
 * @template {Record<string, any>} Options
 * @param {import('svelte').Component<Options & { dismiss: (result: Result) => void }>} component
 * @param {Options} options
 * @param {Map<any, any>} [context]
 * @returns {Promise<Result>}
 */
export function modal(component, options, context = new Map()) {
  return new Promise((resolve, reject) => {
    pendingModals += 1;
    notifyPending?.();
    let dismissed = false;
    /** @type {Record<string, any> | undefined} */
    let instance;
    /** @type {(result: Result) => void} */
    const dismiss = (result) => {
      if (dismissed) return;
      dismissed = true;
      resolve(result);
      if (instance) void unmount(instance);
      pendingModals -= 1;
      notifyPending?.();
    };
    try {
      instance = mount(component, {
        target: document.body,
        context,
        props: { ...options, dismiss },
      });
    } catch (error) {
      dismissed = true;
      pendingModals -= 1;
      notifyPending?.();
      reject(error);
    }
  });
}

/** @param {HTMLElement} element */
export function focusModal(element) {
  const previous = document.activeElement;
  element.focus();
  return () => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}

Object.defineProperty(modal, "pending", {
  get() {
    subscribePending();
    return pendingModals > 0;
  },
});
