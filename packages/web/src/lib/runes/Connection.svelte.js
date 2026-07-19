import { albumSort, cleanRelays, friendlyError, trackSort, variant } from "../utils.js";

import { MusicClient } from "@iroh-fm/client";

export class Connection {
  ticket = $state("");
  endpoint = $state("");
  /** @type {string[]} */
  relays = $state([""]);
  secret = $state("");
  clientEndpointId = $state("");
  identityLoading = $state(true);
  connecting = $state(false);
  connectionStep = $state("Connecting to the iroh server…");
  error = $state("");
  /** @type {MusicClient | null} */
  client = $state(null);
  /** @type {import('../types').ConnectionInfo} */
  info = $state({ path_type: "unknown", address: "", received_bytes: 0 });
  ticketParseGeneration = 0;
  identityGeneration = 0;
  operationGeneration = 0;
  autoConnectAttempted = false;

  /** @param {import('./App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
  }

  async prepareIdentity() {
    this.loadLocalState();
    this.importConnectionHash(location.hash);
    await this.initializeIdentity();
  }

  /** @param {() => void} [onConnected] */
  async connectStored(onConnected) {
    await this.autoConnectOnce(onConnected);
  }

  attachHashChanges = () => {
    const importConnection = () => this.importConnectionHash(location.hash);
    window.addEventListener("hashchange", importConnection);
    return () => window.removeEventListener("hashchange", importConnection);
  };

  /** @param {MusicClient | null} client */
  monitor(client) {
    return () => {
      if (!client) {
        this.info = { path_type: "unknown", address: "", received_bytes: 0 };
        return;
      }
      const update = () => {
        try {
          this.info = client.connectionInfo();
        } catch {
          // The connection may be closing while settings are applied.
        }
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    };
  }

  loadLocalState() {
    this.ticket = localStorage.getItem("iroh-fm-ticket") ?? "";
    this.endpoint = localStorage.getItem("iroh-fm-endpoint") ?? "";
    this.relays = this.readStoredRelays();
    this.secret = localStorage.getItem("iroh-fm-secret") ?? "";
    this.app.starredKey =
      localStorage.getItem("iroh-fm-starred-key") ??
      localStorage.getItem("iroh-fm-loved-key") ??
      "";
    const storedVolume = Number(localStorage.getItem("iroh-fm-volume"));
    if (Number.isFinite(storedVolume))
      this.app.player.volume = Math.min(1, Math.max(0, storedVolume));
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

  /** @param {string} value @param {boolean} [parseAddress] */
  updateLoginTicket(value, parseAddress = false) {
    this.ticket = value;
    if (!parseAddress) return;
    this.endpoint = "";
    this.relays = [""];
    void this.syncTicketAddress(value);
  }

  /** @param {string} value */
  async syncTicketAddress(value) {
    const generation = ++this.ticketParseGeneration;
    if (!value.trim()) return;
    try {
      const address = await MusicClient.parseTicket(value.trim());
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
        const endpointId = await MusicClient.endpointIdForSecret(this.secret);
        if (generation === this.identityGeneration) this.clientEndpointId = endpointId;
      } else {
        const identity = await MusicClient.generateIdentity();
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
      const endpointId = await MusicClient.endpointIdForSecret(secret);
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
      const identity = await MusicClient.generateIdentity();
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

  /** @param {() => void} [onConnected] */
  async autoConnectOnce(onConnected) {
    if (this.autoConnectAttempted || !this.clientEndpointId) {
      onConnected?.();
      return;
    }
    const forceTicket = Boolean(this.ticket.trim());
    if (!this.canConnect(forceTicket)) {
      onConnected?.();
      return;
    }
    this.autoConnectAttempted = true;
    await this.connect(forceTicket, onConnected);
  }

  /** @param {boolean} [forceTicket] */
  canConnect(forceTicket = false) {
    if (forceTicket) return Boolean(this.ticket.trim());
    return this.endpoint.trim() ? cleanRelays(this.relays).length > 0 : Boolean(this.ticket.trim());
  }

  /** @param {boolean} [forceTicket] @param {() => void} [onConnected] @returns {Promise<boolean>} */
  async connect(forceTicket = false, onConnected) {
    if (!this.canConnect(forceTicket) || this.connecting) {
      onConnected?.();
      return false;
    }
    let connectionReported = false;
    const reportConnected = () => {
      if (connectionReported) return;
      connectionReported = true;
      onConnected?.();
    };
    const operation = ++this.operationGeneration;
    this.connecting = true;
    this.error = "";
    this.connectionStep = "Connecting to the iroh server…";
    const previousClient = this.client;
    /** @type {MusicClient | undefined} */
    let nextClient;
    try {
      if (!this.secret.trim()) {
        const identity = await MusicClient.generateIdentity();
        if (operation !== this.operationGeneration) return false;
        this.identityGeneration += 1;
        this.secret = identity.secret;
        this.clientEndpointId = identity.endpointId;
      }
      this.persist();
      nextClient = await MusicClient.connect({
        ticket: this.ticket.trim(),
        endpoint: forceTicket ? "" : this.endpoint.trim(),
        relays: cleanRelays(this.relays),
        secret: this.secret,
      });
      if (operation !== this.operationGeneration) {
        await nextClient.close().catch(() => {});
        return false;
      }
      reportConnected();
      this.connectionStep = "Indexing the remote library…";
      const data = await nextClient.bootstrap(this.app.starredKey);
      this.connectionStep = "Reading the offline track cache…";
      const cachedIds = await nextClient.cachedTrackIds();
      if (operation !== this.operationGeneration) {
        await nextClient.close().catch(() => {});
        return false;
      }
      this.connectionStep = "Preparing the music player…";
      this.app.player.stop();
      nextClient.setOfflineOnly(this.app.library.offlineOnly);
      this.client = nextClient;
      /** @type {import('../types').AlbumData[]} */
      const albums = /** @type {import('../types').AlbumData[]} */ (
        variant(data.albums, "Albums", [])
      ).sort(albumSort);
      /** @type {Map<string, number>} */
      const albumOrderByTrackId = new Map();
      for (const [albumIndex, album] of albums.entries()) {
        for (const trackId of album.track_ids) albumOrderByTrackId.set(trackId, albumIndex);
      }
      /** @type {import('../types').TrackData[]} */
      const tracks = /** @type {import('../types').TrackData[]} */ (
        variant(data.tracks, "Tracks", [])
      );
      tracks.sort(
        (left, right) =>
          (albumOrderByTrackId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (albumOrderByTrackId.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
          trackSort(left, right),
      );
      this.app.library.summary = variant(data.summary, "LibrarySummary", this.app.library.summary);
      this.app.library.albums = albums;
      this.app.library.artists = variant(data.artists, "Artists", []);
      this.app.library.replaceTracks(tracks, cachedIds);
      this.app.library.starred = variant(data.starred, "Starred", this.app.library.starred);
      if (previousClient && previousClient !== nextClient)
        await previousClient.close().catch(() => {});
      return true;
    } catch (error) {
      await nextClient?.close().catch(() => {});
      if (operation !== this.operationGeneration) return false;
      this.error = friendlyError(error, "Could not reach this iroh-fm server.");
      this.client = previousClient;
      return false;
    } finally {
      reportConnected();
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
