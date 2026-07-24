import {
  activateServiceWorkerUpdate,
  currentNativeRequirement,
  subscribeToNativeUpgrade,
  subscribeToServiceWorkerUpdates,
} from "$lib/service-worker.js";

import { ClientCore } from "@iroh-fm/client/core";

class Updater {
  ready = $state(false);
  dismissed = $state(false);
  androidRestartRequired = $state(false);
  applying = $state(false);
  /** @type {ReturnType<typeof currentNativeRequirement>} */
  nativeUpgrade = $state(null);
  nativeBuild = ClientCore.buildInfo();

  watch = () => {
    const unsubscribeUpdates = subscribeToServiceWorkerUpdates((ready) => {
      this.ready = ready;
      if (!ready) this.dismissed = false;
    });
    const unsubscribeNative = subscribeToNativeUpgrade((upgrade) => (this.nativeUpgrade = upgrade));
    return () => {
      unsubscribeUpdates();
      unsubscribeNative();
    };
  };

  apply = async () => {
    if (this.applying) return;
    this.applying = true;
    try {
      const native = await this.nativeBuild;
      const reload = native?.platform !== "Android";
      if (!(await activateServiceWorkerUpdate({ reload }))) this.applying = false;
      else if (!reload) {
        this.applying = false;
        this.androidRestartRequired = true;
      }
    } catch (error) {
      this.applying = false;
      console.error("[web-update] activation failed", error);
    }
  };
}

export const Updates = new Updater();
