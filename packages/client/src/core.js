import { MusicClient } from "./index.js";
import { NativeMusicClient, detectNative, isNative, nativeRequest } from "./native.js";

export class ClientCore {
  static async prepare() {
    if (!(await detectNative())) await MusicClient.prepare();
  }

  static async prepareCaches() {
    if (!isNative()) await MusicClient.prepareCaches();
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static connect(options) {
    return isNative() ? NativeMusicClient.connect(options) : MusicClient.connect(options);
  }

  /** @param {string} ticket */
  static parseTicket(ticket) {
    return isNative() ? nativeRequest("parseTicket", { ticket }) : MusicClient.parseTicket(ticket);
  }

  static generateIdentity() {
    return isNative() ? nativeRequest("identity") : MusicClient.generateIdentity();
  }

  /** @param {string} secret */
  static endpointIdForSecret(secret) {
    return isNative()
      ? nativeRequest("endpointId", { secret })
      : MusicClient.endpointIdForSecret(secret);
  }

  static cacheStats() {
    return isNative()
      ? Promise.resolve({ tracks: { count: 0, size: 0 }, covers: { count: 0, size: 0 } })
      : MusicClient.cacheStats();
  }
}

export { subscribeNativePlayerState } from "./native.js";
