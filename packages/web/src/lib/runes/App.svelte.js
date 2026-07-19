import { Connection } from './Connection.svelte.js';
import { Library } from './Library.svelte.js';
import { Player } from './Player.svelte.js';

export class Application {
	connection = new Connection(this);
	library = new Library(this);
	player = new Player(this);
	starredKey = $state('');
	initialized = false;

	/** @param {Promise<unknown> | undefined} serviceWorkerReady */
	async initialize(serviceWorkerReady) {
		try {
			await serviceWorkerReady;
		} catch (error) {
			console.warn('[sw] offline support is unavailable', error);
		}
		if (this.initialized) return true;
		await this.connection.initialize();
		this.initialized = true;
		return true;
	}

}

export const App = new Application();
