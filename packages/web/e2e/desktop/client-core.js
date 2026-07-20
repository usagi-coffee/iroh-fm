import { fixtureCore, NativeFixtureClient } from "../fixtures.js";

class DesktopMusicClient extends NativeFixtureClient {
  native = false;
}

export const ClientCore = fixtureCore(DesktopMusicClient);

export function subscribeNativePlayerState() {
  return () => {};
}
