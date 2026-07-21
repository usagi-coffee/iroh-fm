import {
  connectDesktop,
  desktopBuildInfo,
  desktopEndpointIdForSecret,
  generateDesktopIdentity,
  isDesktop,
  parseDesktopTicket,
} from "./desktop.js";
import { MusicClient } from "./index.js";
import { NativeMusicClient, detectNative, isNative, nativeRequest } from "./native.js";

export class ClientCore {
  static async prepare() {
    if (!isDesktop() && !(await detectNative())) await MusicClient.prepare();
  }

  static async prepareCaches() {
    if (!isNative()) await MusicClient.prepareCaches();
  }

  static async buildInfo() {
    if (isDesktop()) return desktopBuildInfo();
    return isNative() || (await detectNative()) ? nativeRequest("buildInfo") : null;
  }

  /** @param {{ticket?: string, endpoint?: string, relays?: string[], secret?: string}} options */
  static connect(options) {
    if (isDesktop()) return connectDesktop(options);
    if (!isNative()) return MusicClient.connect(options);
    return NativeMusicClient.connect(options).then((client) => {
      void client.setMemoryCacheSize(MusicClient.memoryCacheSize());
      return client;
    });
  }

  /** @param {string} ticket */
  static parseTicket(ticket) {
    if (isDesktop()) return parseDesktopTicket(ticket);
    return isNative() ? nativeRequest("parseTicket", { ticket }) : MusicClient.parseTicket(ticket);
  }

  static generateIdentity() {
    if (isDesktop()) return generateDesktopIdentity();
    return isNative() ? nativeRequest("identity") : MusicClient.generateIdentity();
  }

  /** @param {string} secret */
  static endpointIdForSecret(secret) {
    if (isDesktop()) return desktopEndpointIdForSecret(secret);
    return isNative()
      ? nativeRequest("endpointId", { secret })
      : MusicClient.endpointIdForSecret(secret);
  }

  static cacheStats() {
    return isNative() ? nativeRequest("cacheStats") : MusicClient.cacheStats();
  }

  static memoryCacheSize() {
    return MusicClient.memoryCacheSize();
  }

  /** @param {number} megabytes */
  static setMemoryCacheSize(megabytes) {
    return MusicClient.setMemoryCacheSize(megabytes);
  }
}

export { subscribeNativePlayerState } from "./native.js";
