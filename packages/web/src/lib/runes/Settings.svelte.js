import { goto } from "$app/navigation";
import { resolve } from "$app/paths";

import { App } from "$lib/runes/App.svelte.js";
import { cleanRelays, friendlyError } from "$lib/utils.js";

import { ClientCore } from "@iroh-fm/client/core";

export const MIN_MEMORY_CACHE_MIB = 32;
export const MAX_MEMORY_CACHE_MIB = Math.round(ClientCore.memoryCacheMaxSize() / 1024 / 1024);

export class Settings {
  #ticket = $state(App.connection.ticket);
  #secret = $state(App.connection.secret);
  #memoryCacheMiB = $state(Math.round(ClientCore.memoryCacheSize() / 1024 / 1024));
  endpoint = $state(App.connection.endpoint);
  relays = $state([...App.connection.relays]);
  starredKey = $state(App.starredKey);
  storage = $state({
    loading: true,
    requesting: false,
    tracks: 0,
    trackSize: 0,
    covers: 0,
    coverSize: 0,
    usage: 0,
    quota: 0,
    persisted: false,
    supported: false,
    clearing: "",
    error: "",
  });
  /** @type {Promise<string>} */
  draftEndpointId = $state(this.endpointIdForSecret(this.#secret));
  canSave = $derived(
    Boolean(this.endpoint.trim() ? cleanRelays(this.relays).length : this.#ticket.trim()) &&
      !App.connection.connecting,
  );
  ticketParseGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  ticketParseTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  endpointIdTimer;
  /** @type {{ resolve: (value: string) => void, reject: (reason: unknown) => void }[]} */
  endpointIdWaiters = [];

  get ticket() {
    return this.#ticket;
  }

  /** @param {string} value */
  set ticket(value) {
    this.#ticket = value;
    this.endpoint = "";
    this.relays.splice(0, this.relays.length, "");
    if (this.ticketParseTimer) clearTimeout(this.ticketParseTimer);
    this.ticketParseGeneration += 1;
    if (!value.trim()) return;
    this.ticketParseTimer = setTimeout(() => {
      this.ticketParseTimer = undefined;
      void this.syncTicketAddress(value);
    }, 180);
  }

  get secret() {
    return this.#secret;
  }

  /** @param {string} value */
  set secret(value) {
    this.#secret = value;
    if (this.endpointIdTimer) clearTimeout(this.endpointIdTimer);
    const secret = value.trim();
    if (!secret) {
      this.endpointIdTimer = undefined;
      for (const waiter of this.endpointIdWaiters.splice(0)) waiter.resolve("");
      this.draftEndpointId = Promise.resolve("");
      return;
    }
    this.draftEndpointId = new Promise((resolve, reject) => {
      this.endpointIdWaiters.push({ resolve, reject });
      this.endpointIdTimer = setTimeout(() => {
        this.endpointIdTimer = undefined;
        const waiters = this.endpointIdWaiters.splice(0);
        Promise.resolve(ClientCore.endpointIdForSecret(secret)).then(
          (endpointId) => {
            for (const waiter of waiters) waiter.resolve(endpointId);
          },
          (error) => {
            for (const waiter of waiters) waiter.reject(error);
          },
        );
      }, 180);
    });
  }

  get memoryCacheMiB() {
    return this.#memoryCacheMiB;
  }

  /** @param {string | number} value */
  set memoryCacheMiB(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.#memoryCacheMiB = Math.min(
      MAX_MEMORY_CACHE_MIB,
      Math.max(MIN_MEMORY_CACHE_MIB, Math.round(parsed)),
    );
  }

  /** @param {string} secret */
  endpointIdForSecret(secret) {
    const value = secret.trim();
    return value ? Promise.resolve(ClientCore.endpointIdForSecret(value)) : Promise.resolve("");
  }

  initialize = () => {
    void this.refreshStorageInfo();
    if (this.#ticket.trim()) void this.syncTicketAddress(this.#ticket);
    return () => {
      if (this.ticketParseTimer) clearTimeout(this.ticketParseTimer);
      if (this.endpointIdTimer) clearTimeout(this.endpointIdTimer);
      for (const waiter of this.endpointIdWaiters.splice(0)) waiter.resolve("");
    };
  };

  /** @param {string} value */
  async syncTicketAddress(value) {
    if (this.ticketParseTimer) {
      clearTimeout(this.ticketParseTimer);
      this.ticketParseTimer = undefined;
    }
    const generation = ++this.ticketParseGeneration;
    if (!value.trim()) return;
    try {
      const address = await ClientCore.parseTicket(value.trim());
      if (generation !== this.ticketParseGeneration) return;
      this.endpoint = address.endpointId;
      this.relays.splice(0, this.relays.length, ...(address.relays.length ? address.relays : [""]));
    } catch {
      // Keep the editor ready while the user is typing.
    }
  }

  addRelay = () => this.relays.push("");

  /** @param {number} index */
  removeRelay(index) {
    this.relays.splice(index, 1);
    if (!this.relays.length) this.relays.push("");
  }

  refreshStorageInfo = async () => {
    const storage = this.storage;
    storage.loading = true;
    storage.supported = Boolean(navigator.storage);
    try {
      const [cacheStats, estimate, persisted] = await Promise.all([
        App.connection.client?.cacheStats?.() ?? ClientCore.cacheStats(),
        navigator.storage?.estimate?.() ?? Promise.resolve({}),
        navigator.storage?.persisted?.() ?? Promise.resolve(false),
      ]);
      Object.assign(storage, {
        loading: false,
        tracks: cacheStats.tracks.count,
        trackSize: cacheStats.tracks.size,
        covers: cacheStats.covers.count,
        coverSize: cacheStats.covers.size,
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
        persisted,
      });
    } catch (error) {
      console.warn("[storage] could not read cache statistics", error);
      storage.loading = false;
    }
  };

  requestPersistentStorage = async () => {
    if (!navigator.storage?.persist) return;
    this.storage.requesting = true;
    try {
      await navigator.storage.persist();
    } finally {
      this.storage.requesting = false;
      await this.refreshStorageInfo();
    }
  };

  /** @param {'tracks' | 'covers'} kind */
  clearOfflineCache = async (kind) => {
    const client = App.connection.client;
    if (!client || this.storage.clearing) return;
    this.storage.clearing = kind;
    this.storage.error = "";
    try {
      await client.clearCache(kind);
      if (kind === "tracks") await App.library.refreshCachedTracks();
    } catch (error) {
      this.storage.error = friendlyError(error, `Could not clear the offline ${kind} cache.`);
    } finally {
      this.storage.clearing = "";
      await this.refreshStorageInfo();
    }
  };

  save = async () => {
    if (!this.canSave) return;
    let secret = this.#secret.trim();
    try {
      if (secret) App.connection.clientEndpointId = await this.draftEndpointId;
      else {
        const identity = await ClientCore.generateIdentity();
        secret = identity.secret;
        App.connection.clientEndpointId = identity.endpointId;
      }
    } catch (error) {
      App.connection.error = friendlyError(error, "The client secret is invalid.");
      return;
    }
    App.connection.ticket = this.#ticket.trim();
    App.connection.endpoint = this.endpoint.trim();
    App.connection.relays = [...this.relays];
    App.connection.secret = secret;
    App.starredKey = this.starredKey.trim();
    const memoryCacheBytes = ClientCore.setMemoryCacheSize(this.#memoryCacheMiB);
    if (App.connection.client) await App.connection.client.setMemoryCacheSize(memoryCacheBytes);
    if (App.starredKey) localStorage.setItem("iroh-fm-starred-key", App.starredKey);
    else localStorage.removeItem("iroh-fm-starred-key");
    localStorage.removeItem("iroh-fm-loved-key");
    if (await App.connection.connect()) await goto(resolve("/tracks"));
  };
}
