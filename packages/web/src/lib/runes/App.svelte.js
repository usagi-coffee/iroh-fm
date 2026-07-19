import { Connection } from "./Connection.svelte.js";
import { Library } from "./Library.svelte.js";
import { Player } from "./Player.svelte.js";

export class Application {
  connection = new Connection(this);
  library = new Library(this);
  player = new Player(this);
  starredKey = $state("");
  identityInitialized = false;
  initialized = false;

  async prepareIdentity() {
    if (this.identityInitialized) return;
    await this.connection.prepareIdentity();
    this.identityInitialized = true;
  }

  /** @param {() => void} [onConnected] */
  async initialize(onConnected) {
    if (this.initialized) {
      onConnected?.();
      return;
    }
    await this.prepareIdentity();
    await this.connection.connectStored(onConnected);
    this.initialized = true;
  }
}

export const App = new Application();
