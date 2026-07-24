import { Connection } from "$lib/runes/Connection.svelte.js";
import { Library } from "$lib/runes/Library.svelte.js";
import { Player } from "$lib/runes/Player.svelte.js";

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

  async initialize() {
    if (this.initialized) return;
    await this.prepareIdentity();
    await this.connection.connectStored();
    this.initialized = true;
  }
}

export const App = new Application();
