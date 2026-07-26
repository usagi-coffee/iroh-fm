import { albumSort, cleanRelays, friendlyError, trackSort } from "$lib/utils.js";

import { ClientCore } from "@iroh-fm/client/core";

export class Connection {
  #startupTransport = Promise.withResolvers();

  ticket = $state("");
  endpoint = $state("");
  /** @type {string[]} */
  relays = $state([""]);
  secret = $state("");
  clientEndpointId = $state("");
  identityLoading = $state(true);
  connecting = $state(false);
  connectionStep = $state("Connecting to the iroh server…");
  connectionProgress = $state(5);
  error = $state("");
  /** @type {Awaited<ReturnType<typeof ClientCore.connect>> | null} */
  client = $state(null);
  /** @type {Awaited<ReturnType<typeof ClientCore.connect>> | null} */
  loadingClient = $state(null);
  info = $state.raw({ path_type: "unknown", address: "", received_bytes: 0 });
  receivedBytesPerSecond = $state(0);
  connectionSamples = new WeakMap();
  ticketParseGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  ticketParseTimer;
  identityGeneration = 0;
  operationGeneration = 0;
  autoConnectAttempted = false;
  startupTransportReady = this.#startupTransport.promise;

  /** @param {import('$lib/runes/App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
  }

  async prepareIdentity() {
    this.loadLocalState();
    this.importConnectionHash(location.hash);
    await this.initializeIdentity();
  }

  async connectStored() {
    try {
      await this.autoConnectOnce();
    } finally {
      this.#startupTransport.resolve(undefined);
    }
  }

  watch = () => {
    const client = this.loadingClient ?? this.client;
    if (!client) {
      this.info = { path_type: "unknown", address: "", received_bytes: 0 };
      this.receivedBytesPerSecond = 0;
      return;
    }

    let active = true;
    let updating = false;
    const update = async () => {
      if (!active || updating) return;
      updating = true;
      try {
        const info = await client.connectionInfo();
        if (!active) return;
        const now = performance.now();
        const previous = this.connectionSamples.get(client);
        if (previous) {
          const elapsed = now - previous.time;
          const received = Math.max(0, info.received_bytes - previous.bytes);
          this.receivedBytesPerSecond = elapsed > 0 ? (received * 1000) / elapsed : 0;
        } else {
          this.receivedBytesPerSecond = 0;
        }
        this.connectionSamples.set(client, { bytes: info.received_bytes, time: now });
        this.info = info;
        void this.app.player.refreshNativeState(client);
      } catch {
        // The connection may be closing while settings are applied.
      } finally {
        updating = false;
      }
    };
    void update();
    const interval = setInterval(() => void update(), this.loadingClient ? 250 : 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  };

  loadLocalState() {
    this.ticket = localStorage.getItem("iroh-fm-ticket") ?? "";
    this.endpoint = localStorage.getItem("iroh-fm-endpoint") ?? "";
    this.relays = this.readStoredRelays();
    this.secret = localStorage.getItem("iroh-fm-secret") ?? "";
    this.app.starredKey =
      localStorage.getItem("iroh-fm-starred-key") ??
      localStorage.getItem("iroh-fm-loved-key") ??
      "";
    const storedVolume = localStorage.getItem("iroh-fm-volume");
    if (storedVolume !== null) {
      const volume = Number(storedVolume);
      if (Number.isFinite(volume)) this.app.player.volume = Math.min(1, Math.max(0, volume));
    }
  }

  readStoredRelays() {
    try {
      const stored = JSON.parse(localStorage.getItem("iroh-fm-relays") ?? "null");
      if (Array.isArray(stored) && stored.length) return stored.map(String);
    } catch {
      // Fall through to the legacy single-relay setting.
    }
    return [localStorage.getItem("iroh-fm-relay") ?? ""];
  }

  /** @param {string} hash */
  importConnectionHash(hash) {
    this.applyConnectionLink(this.connectionFromHash(hash));
  }

  /** @param {{ ticket: string, secret: string }} linked */
  applyConnectionLink(linked) {
    if (linked.ticket) this.ticket = linked.ticket;
    if (linked.secret) {
      this.secret = linked.secret;
      localStorage.setItem("iroh-fm-secret", linked.secret);
      void this.updateIdentity(linked.secret);
    }
  }

  /** @param {string} hash @returns {{ ticket: string, secret: string }} */
  connectionFromHash(hash) {
    const fragment = hash.replace(/^#/, "").trim();
    if (!fragment) return { ticket: "", secret: "" };
    const parameters = new URLSearchParams(fragment);
    const ticket = parameters.get("ticket")?.trim() ?? "";
    const secret = parameters.get("secret")?.trim() ?? "";
    if (ticket || secret) return { ticket, secret };
    try {
      const raw = decodeURIComponent(fragment);
      return { ticket: raw.startsWith("endpoint") ? raw : "", secret: "" };
    } catch {
      return { ticket: "", secret: "" };
    }
  }

  /** @param {string} value @returns {{ ticket: string, secret: string }} */
  connectionFromScannedValue(value) {
    try {
      const linked = this.connectionFromHash(new URL(value).hash);
      return linked.ticket || linked.secret ? linked : { ticket: value.trim(), secret: "" };
    } catch {
      const linked = this.connectionFromHash(value);
      return linked.ticket || linked.secret ? linked : { ticket: value.trim(), secret: "" };
    }
  }

  async copyTicketLink() {
    if (!this.ticket.trim()) return false;
    try {
      const url = new URL(location.href);
      const setup = new URLSearchParams({ ticket: this.ticket.trim() });
      if (this.secret.trim()) setup.set("secret", this.secret.trim());
      url.hash = setup.toString();
      await navigator.clipboard.writeText(url.toString());
      return true;
    } catch (error) {
      this.error = friendlyError(error, "Could not copy the ticket link.");
      return false;
    }
  }

  /**
   * @param {string} value
   * @param {boolean} [parseAddress]
   */
  updateLoginTicket(value, parseAddress = false) {
    this.ticket = value;
    if (!parseAddress) return;
    this.endpoint = "";
    this.relays = [""];
    if (this.ticketParseTimer) clearTimeout(this.ticketParseTimer);
    this.ticketParseGeneration += 1;
    if (!value.trim()) return;
    this.ticketParseTimer = setTimeout(() => {
      this.ticketParseTimer = undefined;
      void this.syncTicketAddress(value);
    }, 180);
  }

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
      this.relays = address.relays.length ? address.relays : [""];
    } catch {
      // Tickets are invalid while the user is still typing.
    }
  }

  addRelay() {
    this.relays.push("");
  }

  /** @param {number} index */
  removeRelay(index) {
    this.relays.splice(index, 1);
    if (!this.relays.length) this.relays.push("");
  }

  async initializeIdentity() {
    const generation = ++this.identityGeneration;
    this.identityLoading = true;
    try {
      if (this.secret.trim()) {
        const endpointId = await ClientCore.endpointIdForSecret(this.secret);
        if (generation === this.identityGeneration) this.clientEndpointId = endpointId;
      } else {
        const identity = await ClientCore.generateIdentity();
        if (generation !== this.identityGeneration) return;
        this.secret = identity.secret;
        this.clientEndpointId = identity.endpointId;
        localStorage.setItem("iroh-fm-secret", identity.secret);
      }
    } catch (error) {
      if (generation === this.identityGeneration)
        this.error = friendlyError(error, "Could not prepare a browser identity.");
    } finally {
      if (generation === this.identityGeneration) this.identityLoading = false;
    }
  }

  /** @param {string} secret */
  async updateIdentity(secret) {
    const generation = ++this.identityGeneration;
    this.secret = secret;
    this.clientEndpointId = "";
    this.identityLoading = Boolean(secret.trim());
    if (!secret.trim()) return;
    try {
      const endpointId = await ClientCore.endpointIdForSecret(secret);
      if (generation === this.identityGeneration) this.clientEndpointId = endpointId;
    } catch {
      // Validation is reported when connecting.
    } finally {
      if (generation === this.identityGeneration) this.identityLoading = false;
    }
  }

  async generateIdentity() {
    if (this.identityLoading || this.connecting) return;
    const generation = ++this.identityGeneration;
    this.identityLoading = true;
    this.error = "";
    try {
      const identity = await ClientCore.generateIdentity();
      if (generation !== this.identityGeneration) return;
      this.secret = identity.secret;
      this.clientEndpointId = identity.endpointId;
      localStorage.setItem("iroh-fm-secret", identity.secret);
    } catch (error) {
      if (generation === this.identityGeneration)
        this.error = friendlyError(error, "Could not generate a new client identity.");
    } finally {
      if (generation === this.identityGeneration) this.identityLoading = false;
    }
  }

  async autoConnectOnce() {
    if (this.autoConnectAttempted || !this.clientEndpointId) return;
    const forceTicket = Boolean(this.ticket.trim());
    if (!this.canConnect(forceTicket)) return;
    this.autoConnectAttempted = true;
    await this.connect(forceTicket);
  }

  /** @param {boolean} [forceTicket] */
  canConnect(forceTicket = false) {
    if (forceTicket) return Boolean(this.ticket.trim());
    return this.endpoint.trim() ? cleanRelays(this.relays).length > 0 : Boolean(this.ticket.trim());
  }

  /** @param {number} operation */
  async ensureConnectionIdentity(operation) {
    if (this.secret.trim()) return true;
    const identity = await ClientCore.generateIdentity();
    if (operation !== this.operationGeneration) return false;
    this.identityGeneration += 1;
    this.secret = identity.secret;
    this.clientEndpointId = identity.endpointId;
    return true;
  }

  /** @param {string} text @param {number} progress */
  setConnectionStep(text, progress) {
    this.connectionStep = text;
    this.connectionProgress = progress;
  }

  /** @param {boolean} forceTicket */
  connectionOptions(forceTicket) {
    return {
      ticket: this.ticket.trim(),
      endpoint: forceTicket ? "" : this.endpoint.trim(),
      relays: cleanRelays(this.relays),
      secret: this.secret,
    };
  }

  /**
   * @param {Awaited<ReturnType<typeof ClientCore.connect>>} client
   * @param {number} operation
   */
  async readLibrarySnapshot(client, operation) {
    this.setConnectionStep("Indexing the remote library…", 6);
    const data = await client.bootstrap(this.app.starredKey);
    if (operation !== this.operationGeneration) return null;
    this.setConnectionStep("Reading the offline track cache…", 7);
    const cachedIds = await client.cachedTrackIds();
    if (operation !== this.operationGeneration) return null;
    return { data, cachedIds };
  }

  /** @param {NonNullable<Awaited<ReturnType<Connection['readLibrarySnapshot']>>>} snapshot */
  installLibrarySnapshot({ data, cachedIds }) {
    const albums = data.albums.sort(albumSort);
    /** @type {Map<string, number>} */
    const albumOrderByTrackId = new Map();
    for (const [albumIndex, album] of albums.entries()) {
      for (const trackId of album.track_ids) albumOrderByTrackId.set(trackId, albumIndex);
    }

    const tracks = data.tracks;
    tracks.sort(
      (left, right) =>
        (albumOrderByTrackId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (albumOrderByTrackId.get(right.id) ?? Number.MAX_SAFE_INTEGER) || trackSort(left, right),
    );

    this.app.library.summary = data.summary;
    this.app.library.albums = albums;
    this.app.library.artists = data.artists;
    this.app.library.replaceTracks(tracks, cachedIds);
    this.app.library.starred = data.starred;
    this.app.library.playlists = data.playlists ?? [];

    // Search metadata and starred/list indexes are intentionally paid for while
    // the startup loader still owns the screen.
    this.setConnectionStep("Preparing the library indexes…", 9);
    this.app.library.prepareIndexes();
  }

  /**
   * @param {boolean} [forceTicket]
   * @returns {Promise<boolean>}
   */
  async connect(forceTicket = false) {
    if (!this.canConnect(forceTicket) || this.connecting) return false;

    const operation = ++this.operationGeneration;
    this.connecting = true;
    this.error = "";
    this.setConnectionStep("Connecting to the iroh server…", 5);
    const previousClient = this.client;
    /** @type {Awaited<ReturnType<typeof ClientCore.connect>> | undefined} */
    let nextClient;

    try {
      // Resolve and persist identity before opening either a ticket-based or
      // endpoint-and-relays connection.
      if (!(await this.ensureConnectionIdentity(operation))) return false;
      this.persist();
      nextClient = await ClientCore.connect(this.connectionOptions(forceTicket));
      if (operation !== this.operationGeneration) {
        await nextClient.close().catch(() => {});
        return false;
      }
      this.loadingClient = nextClient;
      this.#startupTransport.resolve(undefined);

      // Bootstrap the candidate without disturbing the active client. Every
      // await is followed by an operation check so disconnect/reconnect wins.
      const snapshot = await this.readLibrarySnapshot(nextClient, operation);
      if (!snapshot) {
        await nextClient.close().catch(() => {});
        return false;
      }
      this.setConnectionStep("Preparing the music player…", 8);
      await nextClient.setOfflineOnly(this.app.library.offlineOnly);
      if (operation !== this.operationGeneration) {
        await nextClient.close().catch(() => {});
        return false;
      }

      // Commit only after the candidate is fully configured. Until this point,
      // a failure leaves the previous client and its playback untouched.
      this.app.player.stop();
      this.installLibrarySnapshot(snapshot);
      this.client = nextClient;
      if (previousClient && previousClient !== nextClient)
        await previousClient.close().catch(() => {});
      return true;
    } catch (error) {
      // Roll back the unpublished candidate and retain the last usable client.
      await nextClient?.close().catch(() => {});
      if (operation !== this.operationGeneration) return false;
      this.error = friendlyError(error, "Could not reach this iroh-fm server.");
      this.client = previousClient;
      return false;
    } finally {
      if (this.loadingClient === nextClient) this.loadingClient = null;
      if (operation === this.operationGeneration) this.connecting = false;
    }
  }

  persist() {
    localStorage.setItem("iroh-fm-ticket", this.ticket.trim());
    if (this.endpoint.trim()) localStorage.setItem("iroh-fm-endpoint", this.endpoint.trim());
    else localStorage.removeItem("iroh-fm-endpoint");
    const relays = cleanRelays(this.relays);
    if (relays.length) localStorage.setItem("iroh-fm-relays", JSON.stringify(relays));
    else localStorage.removeItem("iroh-fm-relays");
    localStorage.removeItem("iroh-fm-relay");
    if (this.secret.trim()) localStorage.setItem("iroh-fm-secret", this.secret.trim());
    else localStorage.removeItem("iroh-fm-secret");
  }

  async disconnect() {
    this.operationGeneration += 1;
    this.connecting = false;
    this.loadingClient = null;
    this.app.player.stop();
    const previous = this.client;
    this.client = null;
    this.ticket = "";
    this.endpoint = "";
    this.relays = [""];
    localStorage.removeItem("iroh-fm-ticket");
    localStorage.removeItem("iroh-fm-endpoint");
    localStorage.removeItem("iroh-fm-relays");
    localStorage.removeItem("iroh-fm-relay");
    if (previous) await previous.close().catch(() => {});
  }

  async copyEndpointId() {
    try {
      await navigator.clipboard.writeText(this.client?.endpointId || this.clientEndpointId);
      return true;
    } catch (error) {
      this.error = friendlyError(error, "Could not copy the client endpoint ID.");
      return false;
    }
  }
}
