<script>
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";

  import { App } from "$lib/runes/App.svelte.js";
  import { cleanRelays, formatBytes, friendlyError } from "$lib/utils.js";

  import CloseIcon from "virtual:icons/ri/close-line";
  import CopyIcon from "virtual:icons/ri/file-copy-line";

  import { ClientCore } from "@iroh-fm/client/core";

  let settings = $state({
    ticket: App.connection.ticket,
    endpoint: App.connection.endpoint,
    relays: [...App.connection.relays],
    secret: App.connection.secret,
    starredKey: App.starredKey,
    showSecret: false,
    storage: {
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
    },
  });
  let ticketParseGeneration = 0;
  let endpointCopied = $state(false);
  let draftEndpointId = $derived(
    settings.secret.trim()
      ? ClientCore.endpointIdForSecret(settings.secret.trim())
      : Promise.resolve(""),
  );

  function initialize() {
    refreshStorageInfo();
    if (settings.ticket.trim()) syncTicketAddress(settings.ticket);
  }

  /** @param {string} value */
  function updateTicket(value) {
    settings.ticket = value;
    settings.endpoint = "";
    settings.relays = [""];
    syncTicketAddress(value);
  }

  /** @param {string} value */
  async function syncTicketAddress(value) {
    const generation = ++ticketParseGeneration;
    if (!value.trim()) return;
    try {
      const address = await ClientCore.parseTicket(value.trim());
      if (generation !== ticketParseGeneration) return;
      settings.endpoint = address.endpointId;
      settings.relays = address.relays.length ? address.relays : [""];
    } catch {
      // Keep the editor ready while the user is typing.
    }
  }

  function addRelay() {
    settings.relays.push("");
  }

  /** @param {number} index */
  function removeRelay(index) {
    settings.relays.splice(index, 1);
    if (!settings.relays.length) settings.relays.push("");
  }

  async function refreshStorageInfo() {
    const storage = settings.storage;
    storage.loading = true;
    storage.supported = Boolean(navigator.storage);
    try {
      const [cacheStats, estimate, persisted] = await Promise.all([
        App.connection.client?.cacheStats() ?? ClientCore.cacheStats(),
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
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return;
    settings.storage.requesting = true;
    try {
      await navigator.storage.persist();
    } finally {
      settings.storage.requesting = false;
      await refreshStorageInfo();
    }
  }

  async function save() {
    if (
      !(settings.endpoint.trim() ? cleanRelays(settings.relays).length : settings.ticket.trim()) ||
      App.connection.connecting
    )
      return;
    let secret = settings.secret.trim();
    try {
      if (secret) App.connection.clientEndpointId = await draftEndpointId;
      else {
        const identity = await ClientCore.generateIdentity();
        secret = identity.secret;
        App.connection.clientEndpointId = identity.endpointId;
      }
    } catch (error) {
      App.connection.error = friendlyError(error, "The client secret is invalid.");
      return;
    }
    App.connection.ticket = settings.ticket.trim();
    App.connection.endpoint = settings.endpoint.trim();
    App.connection.relays = [...settings.relays];
    App.connection.secret = secret;
    App.starredKey = settings.starredKey.trim();
    if (App.starredKey) localStorage.setItem("iroh-fm-starred-key", App.starredKey);
    else localStorage.removeItem("iroh-fm-starred-key");
    localStorage.removeItem("iroh-fm-loved-key");
    if (await App.connection.connect()) await goto(resolve("/tracks"));
  }

  async function copyDraftEndpoint() {
    try {
      const endpointId = await draftEndpointId;
      if (!endpointId) return;
      await navigator.clipboard.writeText(endpointId);
      endpointCopied = true;
      setTimeout(() => (endpointCopied = false), 1600);
    } catch (error) {
      App.connection.error = friendlyError(error, "Could not copy the client endpoint ID.");
    }
  }
</script>

<section {@attach initialize} class="bg-base text-text h-full overflow-y-auto">
  <form
    onsubmit={(event) => {
      event.preventDefault();
      save();
    }}
    class="mx-auto flex min-h-full w-full max-w-3xl flex-col"
  >
    <div
      class="border-surface0 bg-mantle flex shrink-0 items-center justify-between border-b px-5 py-4"
    >
      <div>
        <p class="text-3xs text-overlay0 font-mono tracking-[.16em] uppercase">Connection</p>
        <h1 class="mt-1 text-lg font-semibold">Client settings</h1>
      </div>
      <a
        href={resolve("/tracks")}
        class="text-overlay1 hover:bg-surface0 hover:text-text grid size-8 place-items-center"
        aria-label="Close settings"><CloseIcon class="text-base" /></a
      >
    </div>

    <div class="flex-1 space-y-5 p-5">
      <div>
        <label
          for="settings-ticket"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Server ticket</label
        ><textarea
          id="settings-ticket"
          value={settings.ticket}
          oninput={(event) => updateTicket(event.currentTarget.value)}
          rows="3"
          spellcheck="false"
          autocomplete="off"
          class="border-surface1 bg-mantle focus:border-mauve w-full resize-none border px-3 py-3 font-mono text-xs leading-5 outline-none"
        ></textarea>
      </div>
      <div class="text-4xs text-overlay0 flex items-center gap-3 tracking-wider uppercase">
        <span class="bg-surface0 h-px flex-1"></span>manual address override<span
          class="bg-surface0 h-px flex-1"
        ></span>
      </div>
      <div>
        <label
          for="settings-endpoint"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Server endpoint ID</label
        ><input
          id="settings-endpoint"
          bind:value={settings.endpoint}
          spellcheck="false"
          autocomplete="off"
          placeholder="Leave empty to use ticket"
          class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 font-mono text-xs outline-none"
        />
      </div>
      <div>
        <div class="mb-2 flex items-center justify-between">
          <label
            for="settings-relay-0"
            class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase">Relay URLs</label
          ><button
            type="button"
            onclick={addRelay}
            class="text-3xs text-mauve hover:text-pink font-mono">+ ADD RELAY</button
          >
        </div>
        <div class="space-y-2">
          {#each settings.relays as relayUrl, index}<div class="relative">
              <input
                id={`settings-relay-${index}`}
                bind:value={settings.relays[index]}
                spellcheck="false"
                autocomplete="url"
                placeholder="https://relay.example"
                class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 pr-10 font-mono text-xs outline-none"
              />{#if settings.relays.length > 1}<button
                  type="button"
                  onclick={() => removeRelay(index)}
                  class="text-overlay0 hover:text-red absolute inset-y-0 right-2 grid w-7 place-items-center"
                  aria-label={`Remove relay ${index + 1}`}><CloseIcon class="text-xs" /></button
                >{/if}
            </div>{/each}
        </div>
      </div>
      <div>
        <label
          for="settings-secret"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Client secret</label
        >
        <div class="relative">
          <input
            id="settings-secret"
            bind:value={settings.secret}
            type={settings.showSecret ? "text" : "password"}
            spellcheck="false"
            autocomplete="new-password"
            class="border-surface1 bg-mantle focus:border-mauve h-11 w-full border px-3 pr-14 font-mono text-xs outline-none"
          /><button
            type="button"
            onclick={() => (settings.showSecret = !settings.showSecret)}
            class="text-3xs text-overlay1 hover:text-mauve absolute inset-y-0 right-3 font-mono"
            >{settings.showSecret ? "HIDE" : "SHOW"}</button
          >
        </div>
        <div class="mt-3">
          <svelte:boundary>
            <div class="mb-2 flex items-center justify-between gap-3">
              <p class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase">
                Client endpoint ID
              </p>
              <button
                type="button"
                onclick={copyDraftEndpoint}
                disabled={!settings.secret.trim()}
                class="text-3xs text-mauve hover:text-pink disabled:text-overlay0 flex items-center gap-1.5 font-mono"
                ><CopyIcon class="text-xs" />{endpointCopied ? "COPIED" : "COPY"}</button
              >
            </div>
            <code class="text-2xs text-subtext0 block font-mono leading-5 break-all"
              >{settings.secret.trim()
                ? await draftEndpointId
                : "Generated automatically when settings are saved"}</code
            >
            {#snippet pending()}<code class="text-2xs text-overlay0 block font-mono leading-5"
                >Calculating endpoint ID…</code
              >{/snippet}
            {#snippet failed()}<code class="text-2xs text-red block font-mono leading-5"
                >Invalid client secret</code
              >{/snippet}
          </svelte:boundary>
        </div>
      </div>
      <div>
        <label
          for="settings-starred-key"
          class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
          >Starred collection key</label
        ><input
          id="settings-starred-key"
          bind:value={settings.starredKey}
          spellcheck="false"
          autocomplete="off"
          placeholder="Default: this client identity"
          class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-11 w-full border px-3 font-mono text-xs outline-none"
        />
        <p class="text-3xs text-overlay0 mt-1.5 leading-4">
          Leave empty for a private collection tied to the Client Endpoint ID. Use the same custom
          key on multiple clients to share one collection.
        </p>
      </div>

      <section aria-labelledby="storage-title">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p
              id="storage-title"
              class="text-4xs text-overlay0 font-mono tracking-[.14em] uppercase"
            >
              Offline cache
            </p>
            <p class="text-3xs text-overlay1 mt-1">
              Played and prefetched tracks are reused across visits.
            </p>
          </div>
          <button
            type="button"
            onclick={refreshStorageInfo}
            disabled={settings.storage.loading}
            class="text-4xs text-mauve hover:text-pink shrink-0 font-mono disabled:opacity-40"
            >{settings.storage.loading ? "READING…" : "REFRESH"}</button
          >
        </div>
        <div class="divide-surface0 mt-3 grid grid-cols-2 divide-x">
          <div class="pr-3">
            <p class="text-4xs text-overlay0 font-mono uppercase">Tracks</p>
            <p class="text-text mt-1 text-xs">
              {settings.storage.tracks} · {formatBytes(settings.storage.trackSize)}
            </p>
          </div>
          <div class="pl-3">
            <p class="text-4xs text-overlay0 font-mono uppercase">Covers</p>
            <p class="text-text mt-1 text-xs">
              {settings.storage.covers} · {formatBytes(settings.storage.coverSize)}
            </p>
          </div>
        </div>
        <div class="border-surface0 mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <div class="min-w-0">
            <p class="text-3xs text-subtext0">
              Browser storage: {formatBytes(settings.storage.usage)} / {formatBytes(
                settings.storage.quota,
              )}
            </p>
            <p class="text-4xs text-overlay0 mt-1">
              {settings.storage.persisted
                ? "Persistent storage granted; the browser should not evict this cache automatically."
                : "Storage may be evicted under pressure. Browser quota is managed automatically."}
            </p>
          </div>
          {#if settings.storage.supported && !settings.storage.persisted}<button
              type="button"
              onclick={requestPersistentStorage}
              disabled={settings.storage.requesting}
              class="border-mauve text-4xs text-mauve hover:bg-mauve hover:text-crust shrink-0 border px-2 py-1.5 font-mono disabled:opacity-40"
              >{settings.storage.requesting ? "REQUESTING…" : "KEEP OFFLINE"}</button
            >{/if}
        </div>
      </section>
      <div class="text-2xs text-overlay1 flex items-start justify-between gap-4 leading-5">
        <p>Credentials stay in this browser's localStorage. Saving restarts the iroh connection.</p>
        <p class="text-4xs text-overlay0 shrink-0 font-mono" title="Application build commit">
          BUILD {__BUILD_COMMIT__}
        </p>
      </div>
    </div>

    <div
      class="border-surface0 bg-mantle sticky bottom-0 flex shrink-0 justify-end gap-2 border-t px-5 py-3"
    >
      <a
        href={resolve("/tracks")}
        class="border-surface1 text-3xs text-subtext0 hover:bg-surface0 border px-4 py-2 font-mono"
        >CANCEL</a
      ><button
        type="submit"
        disabled={!(settings.endpoint.trim()
          ? cleanRelays(settings.relays).length
          : settings.ticket.trim()) || App.connection.connecting}
        class="bg-mauve text-3xs text-crust hover:bg-pink px-4 py-2 font-mono font-bold disabled:opacity-40"
        >SAVE & RECONNECT</button
      >
    </div>
  </form>
</section>
