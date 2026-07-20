/// <reference types="unplugin-icons/types/svelte" />

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  const __BUILD_COMMIT__: string;
  const __BUILD_VERSION__: string;
  const __DESKTOP_EPOCH__: number;
  const __DESKTOP_EPOCH_COMMIT__: string;
  const __ANDROID_EPOCH__: number;
  const __ANDROID_EPOCH_COMMIT__: string;

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState {
      focusTrackId?: string;
    }
    // interface Platform {}
  }
}

export {};
