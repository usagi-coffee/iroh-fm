import { nativeBuildInfo } from "$lib/runtime.js";
import {
  activateServiceWorkerUpdate,
  currentNativeRequirement,
  ensure_service_worker,
  subscribeToNativeUpgrade,
  subscribeToServiceWorkerUpdates,
} from "$lib/service-worker.js";

class UpdateManager {
  ready = $state(false);
  dismissed = $state(false);
  applying = $state(false);
  /** @type {ReturnType<typeof currentNativeRequirement>} */
  nativeUpgrade = $state(null);
  /** @type {"web" | ReturnType<typeof currentNativeRequirement>} */
  block = $state(null);
  build = nativeBuildInfo;
  start = this.build.then(async (build) => {
    const requirement = currentNativeRequirement(build);
    const worker = await ensure_service_worker(build);
    if (requirement) {
      this.block = requirement;
      throw new Error("The native application is out of date.");
    }
    if (worker.updateReady && worker.nativeNewerThanWeb && !worker.nativeUpgrade) {
      this.block = "web";
      throw new Error("The cached web application is out of date.");
    }
  });

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
      if (!(await activateServiceWorkerUpdate())) this.applying = false;
    } catch (error) {
      this.applying = false;
      console.error("[web-update] activation failed", error);
    }
  };
}

export const Updater = new UpdateManager();
