import { Connection } from "#lib/runes/Connection.svelte.js";
import { Library } from "#lib/runes/Library.svelte.js";
import { Player } from "#lib/runes/Player.svelte.js";

export class Application {
  connection = new Connection(this);
  library = new Library(this);
  player = new Player(this);
  starredKey = $state("");
  #lyricsFurigana = $state(false);
  #lyricsMeanings = $state(false);
  identityInitialized = false;
  initialized = false;

  get lyricsFurigana() {
    return this.#lyricsFurigana;
  }

  /** @param {boolean} value */
  set lyricsFurigana(value) {
    this.#lyricsFurigana = value;
    localStorage.setItem("iroh-fm-lyrics-furigana", String(value));
  }

  get lyricsMeanings() {
    return this.#lyricsMeanings;
  }

  /** @param {boolean} value */
  set lyricsMeanings(value) {
    this.#lyricsMeanings = value;
    localStorage.setItem("iroh-fm-lyrics-meanings", String(value));
  }

  async prepareIdentity() {
    if (this.identityInitialized) return;
    // Local display preferences are shared across tracks, servers and identities.
    this.#lyricsFurigana = localStorage.getItem("iroh-fm-lyrics-furigana") === "true";
    this.#lyricsMeanings = localStorage.getItem("iroh-fm-lyrics-meanings") === "true";
    await this.connection.prepareIdentity();
    this.identityInitialized = true;
  }

  async initialize() {
    if (this.initialized) return;
    await this.prepareIdentity();
    await this.connection.connectStored();
    this.initialized = true;
  }
}

export const App = new Application();
