<script>
  import { goto } from "$app/navigation";
  import { asset, resolve } from "$app/paths";

  import { modal } from "$lib/modals/index.js";
  import SnippetModal from "$lib/modals/Snippet.svelte";
  import { App } from "$lib/runes/App.svelte.js";
  import { friendlyError, isProtocolVersionMismatch } from "$lib/utils.js";

  import ArrowIcon from "virtual:icons/ri/arrow-right-line";
  import CloseIcon from "virtual:icons/ri/close-line";
  import CopyIcon from "virtual:icons/ri/file-copy-line";
  import GithubIcon from "virtual:icons/ri/github-fill";
  import PlayIcon from "virtual:icons/ri/play-fill";
  import QrIcon from "virtual:icons/ri/qr-scan-2-line";
  import RefreshIcon from "virtual:icons/ri/refresh-line";
  import SearchIcon from "virtual:icons/ri/search-line";
  import StarIcon from "virtual:icons/ri/star-line";
  import PreviousIcon from "virtual:icons/ri/skip-back-fill";
  import NextIcon from "virtual:icons/ri/skip-forward-fill";

  const DEMO_TRACKS = [
    ["01", "Nacre", "Anywhere Between", "Still Light", "3:42"],
    ["02", "Nacre", "Glass Relay", "Still Light", "4:16"],
    ["03", "Low Current", "Soft Static", "Night Index", "2:58"],
    ["04", "Low Current", "Afterimage", "Night Index", "5:02"],
    ["05", "Mallow", "North Window", "Domestic Signals", "3:31"],
    ["06", "Mallow", "Parallel Lines", "Domestic Signals", "4:14"],
    ["07", "Aster Vale", "Folded Sky", "Long Distance", "3:57"],
    ["08", "Aster Vale", "Semaphore", "Long Distance", "3:05"],
    ["09", "Quiet Form", "Borrowed Color", "Soft Focus", "4:24"],
    ["10", "Quiet Form", "Room Tone", "Soft Focus", "2:43"],
    ["11", "Paloma Wire", "Overland", "Signals", "4:01"],
    ["12", "Paloma Wire", "Relay Bloom", "Signals", "3:38"],
  ];
  const DEMO_ALBUMS = [
    ["Still Light", "Nacre", "from-mauve/80 to-blue/30"],
    ["Night Index", "Low Current", "from-teal/70 to-surface0"],
    ["Domestic Signals", "Mallow", "from-peach/70 to-pink/20"],
    ["Long Distance", "Aster Vale", "from-sapphire/70 to-mauve/20"],
    ["Soft Focus", "Quiet Form", "from-green/60 to-teal/20"],
    ["Signals", "Paloma Wire", "from-red/60 to-yellow/20"],
  ];
  const repositoryUrl = "https://github.com/usagi-coffee/iroh-fm";
  const commitUrl =
    __BUILD_COMMIT__ === "development"
      ? `${repositoryUrl}/commits`
      : `${repositoryUrl}/commit/${__BUILD_COMMIT__}`;
  let loginTab = $state("ticket");
  let showSecret = $state(false);
  let ticketLinkCopied = $state(false);
  let endpointCopied = $state(false);
  const protocolVersionMismatch = $derived(isProtocolVersionMismatch(App.connection.error));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let ticketCopiedTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let endpointCopiedTimer;

  function cleanupCopiedTimers() {
    return () => {
      if (ticketCopiedTimer) clearTimeout(ticketCopiedTimer);
      if (endpointCopiedTimer) clearTimeout(endpointCopiedTimer);
    };
  }

  /** @param {'ticket' | 'endpoint'} kind */
  function showCopied(kind) {
    const timer = kind === "ticket" ? ticketCopiedTimer : endpointCopiedTimer;
    if (timer) clearTimeout(timer);
    if (kind === "ticket") ticketLinkCopied = true;
    else endpointCopied = true;
    const nextTimer = setTimeout(() => {
      if (kind === "ticket") ticketLinkCopied = false;
      else endpointCopied = false;
    }, 1600);
    if (kind === "ticket") ticketCopiedTimer = nextTimer;
    else endpointCopiedTimer = nextTimer;
  }

  /** @param {'ticket' | 'advanced'} tab */
  function selectLoginTab(tab) {
    loginTab = tab;
    if (tab === "advanced" && App.connection.ticket.trim())
      void App.connection.syncTicketAddress(App.connection.ticket);
  }

  async function copyTicketLink() {
    if (!(await App.connection.copyTicketLink())) return;
    showCopied("ticket");
  }

  async function copyEndpointId() {
    if (!(await App.connection.copyEndpointId())) return;
    showCopied("endpoint");
  }

  async function scanTicket() {
    try {
      const value = await modal(SnippetModal, {
        snippet: QrScanner,
        cancelValue: null,
        labelledBy: "qr-title",
        class: "w-full max-w-sm border border-surface1 bg-base shadow-float",
      });
      if (!value) return;
      App.connection.applyConnectionLink(App.connection.connectionFromScannedValue(value));
      if (loginTab === "advanced" && App.connection.ticket.trim())
        void App.connection.syncTicketAddress(App.connection.ticket);
    } catch (error) {
      App.connection.error = friendlyError(error, "Could not open the QR scanner.");
    }
  }

  async function connect() {
    if (await App.connection.connect(loginTab === "ticket")) await goto(resolve("/tracks"));
  }

  /**
   * @param {(value: string) => void} complete
   * @param {(reason: unknown) => void} fail
   * @returns {(video: HTMLVideoElement) => () => void}
   */
  function createQrScanner(complete, fail) {
    return (video) => {
      let active = true;
      /** @type {MediaStream | undefined} */
      let stream;
      /** @type {number | undefined} */
      let frame;
      const start = async () => {
        try {
          if (!navigator.mediaDevices?.getUserMedia)
            throw new Error("Camera access is not available in this browser.");
          if (!("BarcodeDetector" in window))
            throw new Error("QR scanning is not supported here. Paste the ticket instead.");
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          if (!active) return stream.getTracks().forEach((track) => track.stop());
          video.srcObject = stream;
          await video.play();
          const Detector =
            /** @type {new (options: { formats: string[] }) => { detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>> }} */ (
              window.BarcodeDetector
            );
          const detector = new Detector({ formats: ["qr_code"] });
          const next = async () => {
            if (!active) return;
            try {
              const value = (await detector.detect(video))[0]?.rawValue;
              if (value) return complete(value);
            } catch {
              // Individual frames can fail while the camera is settling.
            }
            frame = requestAnimationFrame(next);
          };
          void next();
        } catch (reason) {
          if (active) fail(reason);
        }
      };
      void start();
      return () => {
        active = false;
        if (frame) cancelAnimationFrame(frame);
        stream?.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      };
    };
  }
</script>

<main {@attach cleanupCopiedTimers} class="bg-base text-text relative h-dvh overflow-hidden">
  <div
    class="tablet-xl:flex absolute inset-0 hidden flex-col opacity-65 select-none"
    aria-hidden="true"
  >
    <header class="border-surface0 bg-crust text-2xs flex h-9 shrink-0 items-center border-b">
      <div class="border-surface0 grid h-full w-10 shrink-0 place-items-center border-r">
        <img src={asset("/pwa-icon-192.png")} alt="" class="size-6 rounded-md" />
      </div>
      <span class="border-surface0 bg-surface0 border-r px-4 py-2 font-semibold">TRACKS</span><span
        class="text-overlay1 grid w-9 place-items-center"><StarIcon class="text-sm" /></span
      ><span class="text-overlay0 ml-auto px-4 font-mono">REMOTE LIBRARY</span>
    </header>
    <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(21rem,1fr)]">
      <section class="border-surface0 bg-base min-h-0 border-r">
        <div
          class="border-surface0 bg-mantle text-overlay0 flex h-10 items-center gap-3 border-b px-3"
        >
          <SearchIcon class="text-sm" /><span class="font-mono text-xs"
            >Filter artist, title, album…</span
          ><span class="text-3xs ml-auto font-mono">128 TRACKS</span>
        </div>
        <div
          class="border-surface0 bg-mantle text-4xs text-overlay0 grid h-7 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b px-2 font-mono tracking-wider uppercase"
        >
          <span>#</span><span>Album</span><span>Title</span><span>Artist</span><span>Time</span>
        </div>
        {#each DEMO_TRACKS as track}<div
            class="border-surface0/40 text-2xs grid h-7 grid-cols-[2.25rem_minmax(7rem,.55fr)_minmax(10rem,1fr)_minmax(7rem,.5fr)_3.2rem] items-center border-b px-2"
          >
            <span class="text-overlay0 font-mono">{track[0]}</span><span
              class="text-mauve truncate pr-2">{track[3]}</span
            ><span class="text-teal truncate pr-2">{track[2]}</span><span
              class="text-subtext0 truncate pr-2">{track[1]}</span
            ><span class="text-overlay0 font-mono">{track[4]}</span>
          </div>{/each}
      </section>
      <aside class="bg-mantle min-h-0 p-3">
        <div class="mb-3 flex h-7 items-center justify-between">
          <strong class="text-xs">ALBUMS</strong><span class="text-3xs text-overlay0 font-mono"
            >24</span
          >
        </div>
        <div class="grid grid-cols-3 gap-x-3 gap-y-5">
          {#each DEMO_ALBUMS as album}<article class="min-w-0">
              <div class={`grid aspect-square place-items-center bg-gradient-to-br ${album[2]}`}>
                <div
                  class="border-crust/20 bg-crust/25 grid size-1/2 place-items-center rounded-full border"
                >
                  <div class="bg-text/50 size-2 rounded-full"></div>
                </div>
              </div>
              <h3 class="text-2xs mt-2 truncate font-semibold">{album[0]}</h3>
              <p class="text-3xs text-overlay1 truncate">{album[1]}</p>
            </article>{/each}
        </div>
      </aside>
    </div>
    <footer class="border-surface1 bg-crust h-18 shrink-0 border-t">
      <div class="bg-surface0 h-1"><div class="bg-mauve h-full w-1/3"></div></div>
      <div class="grid h-17 grid-cols-[auto_1fr_auto] items-center gap-4 px-5">
        <div class="text-overlay1 flex items-center gap-2">
          <PreviousIcon class="text-base" /><span
            class="bg-text text-crust grid size-10 place-items-center"
            ><PlayIcon class="text-sm" /></span
          ><NextIcon class="text-base" />
        </div>
        <div>
          <p class="text-xs font-semibold">Anywhere Between</p>
          <p class="text-3xs text-overlay1 mt-1">Nacre · Still Light</p>
        </div>
        <span class="text-3xs text-overlay0 font-mono">1:12 / 3:42</span>
      </div>
    </footer>
  </div>

  <div class="bg-crust tablet-xl:bg-crust/35 tablet-xl:backdrop-blur-xs absolute inset-0"></div>
  <section class="tablet-xl:p-8 absolute inset-0 z-10 grid place-items-center overflow-y-auto p-4">
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
      class="border-surface1 bg-base shadow-float my-auto w-[calc(100vw-2rem)] max-w-[29rem] border"
    >
      <div class="border-surface0 bg-mantle border-b px-5 pt-5">
        <div class="mb-5 flex items-start gap-3">
          <img src={asset("/pwa-icon-192.png")} alt="iroh.fm" class="size-12 rounded-xl" />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center">
              <h1 class="text-text text-base font-semibold">iroh.fm</h1>
              <a
                href={commitUrl}
                target="_blank"
                rel="noreferrer"
                class="text-4xs text-overlay0 hover:text-mauve ml-auto shrink-0 font-mono leading-none transition"
                title={`View commit ${__BUILD_COMMIT__} on GitHub`}>{__BUILD_COMMIT__}</a
              ><a
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
                class="text-overlay0 hover:text-mauve ml-2 grid size-5 shrink-0 place-items-center transition"
                title="Open the iroh-fm repository on GitHub"
                aria-label="Open the iroh-fm repository on GitHub"><GithubIcon class="text-sm" /></a
              >
            </div>
            <p class="text-2xs text-overlay1 mt-0.5 leading-5">Your music, anywhere with iroh.</p>
          </div>
        </div>
        <div class="text-3xs flex gap-5 font-mono font-bold tracking-wider uppercase">
          <button
            type="button"
            onclick={() => selectLoginTab("ticket")}
            class="border-b-2 pb-3 {loginTab === 'ticket'
              ? 'border-mauve text-mauve'
              : 'text-overlay1 hover:text-text border-transparent'}">Ticket</button
          ><button
            type="button"
            onclick={() => selectLoginTab("advanced")}
            class="border-b-2 pb-3 {loginTab === 'advanced'
              ? 'border-mauve text-mauve'
              : 'text-overlay1 hover:text-text border-transparent'}">Advanced</button
          >
        </div>
      </div>

      <div class="flex flex-col gap-3 p-5">
        <div>
          <div class="mb-2 flex items-center justify-between gap-3">
            <label for="ticket" class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase"
              >Server ticket</label
            >
            <div class="flex items-center gap-3">
              <button
                type="button"
                onclick={copyTicketLink}
                disabled={!App.connection.ticket.trim()}
                title="Copy setup link including the client secret"
                class="text-3xs text-mauve hover:text-pink disabled:text-overlay0 flex items-center gap-1.5 font-mono"
                ><CopyIcon class="text-xs" />{ticketLinkCopied ? "COPIED" : "COPY"}</button
              >{#if loginTab === "ticket"}<button
                  type="button"
                  onclick={scanTicket}
                  class="text-3xs text-mauve hover:text-pink flex items-center gap-1.5 font-mono"
                  ><QrIcon class="text-xs" /> SCAN QR</button
                >{/if}
            </div>
          </div>
          <textarea
            id="ticket"
            bind:value={
              () => App.connection.ticket,
              (value) => App.connection.updateLoginTicket(value, loginTab === "advanced")
            }
            rows={loginTab === "ticket" ? 3 : 2}
            spellcheck="false"
            autocomplete="off"
            placeholder="endpointaa…"
            class="border-surface1 bg-mantle text-text placeholder:text-overlay0 focus:border-mauve w-full resize-none border px-3 py-3 font-mono text-xs leading-5 outline-none"
          ></textarea>
        </div>

        {#if loginTab === "advanced"}
          <div>
            <label
              for="endpoint"
              class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
              >Server endpoint ID</label
            ><input
              id="endpoint"
              bind:value={App.connection.endpoint}
              spellcheck="false"
              autocomplete="off"
              placeholder="Public endpoint ID"
              class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-10 w-full border px-3 font-mono text-xs outline-none"
            />
          </div>
          <div>
            <div class="mb-2 flex items-center justify-between">
              <label
                for="relay-0"
                class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase"
                >Relay URLs</label
              ><button
                type="button"
                onclick={() => App.connection.addRelay()}
                class="text-3xs text-mauve hover:text-pink font-mono">+ ADD RELAY</button
              >
            </div>
            <div class="space-y-2">
              {#each App.connection.relays as relayUrl, index}<div class="relative">
                  <input
                    id={`relay-${index}`}
                    bind:value={App.connection.relays[index]}
                    spellcheck="false"
                    autocomplete="url"
                    placeholder="https://relay.example"
                    class="border-surface1 bg-mantle placeholder:text-overlay0 focus:border-mauve h-10 w-full border px-3 pr-10 font-mono text-xs outline-none"
                  />{#if App.connection.relays.length > 1}<button
                      type="button"
                      onclick={() => App.connection.removeRelay(index)}
                      class="text-overlay0 hover:text-red absolute inset-y-0 right-2 grid w-7 place-items-center"
                      aria-label={`Remove relay ${index + 1}`}><CloseIcon class="text-xs" /></button
                    >{/if}
                </div>{/each}
            </div>
          </div>
          <div>
            <label
              for="secret"
              class="text-3xs text-subtext0 mb-2 block font-mono tracking-[.14em] uppercase"
              >Client secret</label
            >
            <div class="relative">
              <input
                id="secret"
                bind:value={
                  () => App.connection.secret, (value) => void App.connection.updateIdentity(value)
                }
                type={showSecret ? "text" : "password"}
                spellcheck="false"
                autocomplete="new-password"
                class="border-surface1 bg-mantle focus:border-mauve h-10 w-full border px-3 pr-14 font-mono text-xs outline-none"
              /><button
                type="button"
                onclick={() => (showSecret = !showSecret)}
                class="text-3xs text-overlay1 hover:text-mauve absolute inset-y-0 right-3 font-mono"
                >{showSecret ? "HIDE" : "SHOW"}</button
              >
            </div>
          </div>
        {/if}

        <div>
          <div class="mb-2 flex items-center justify-between gap-3">
            <p class="text-3xs text-subtext0 font-mono tracking-[.14em] uppercase">
              Client endpoint ID
            </p>
            <div class="flex items-center gap-3">
              <button
                type="button"
                onclick={() => App.connection.generateIdentity()}
                disabled={App.connection.identityLoading || App.connection.connecting}
                class="text-3xs text-mauve hover:text-pink disabled:text-overlay0 flex items-center gap-1.5 font-mono"
                ><RefreshIcon class="text-xs" />GENERATE</button
              ><button
                type="button"
                onclick={copyEndpointId}
                disabled={!App.connection.clientEndpointId}
                class="text-3xs text-mauve hover:text-pink disabled:text-overlay0 flex items-center gap-1.5 font-mono"
                ><CopyIcon class="text-xs" />{endpointCopied ? "COPIED" : "COPY"}</button
              >
            </div>
          </div>
          <div class="border-surface0 bg-mantle/70 border px-3 py-2.5">
            <code class="text-3xs text-subtext0 block truncate"
              >{App.connection.identityLoading
                ? "Generating secure identity…"
                : App.connection.clientEndpointId || "Invalid client secret"}</code
            >
          </div>
        </div>

        {#if App.connection.error}<div
            class="border-red bg-red/10 text-red border-l-2 px-3 py-2 text-xs leading-5"
            role="alert"
          >
            <p>
              <strong>Connection failed.</strong>
              {App.connection.error}
            </p>
            {#if protocolVersionMismatch}
              <p class="border-red/25 mt-2 border-t pt-2">
                <strong>Protocol version mismatch.</strong>
                The app and server use different protocol versions. Upgrade both to the newest
                iroh.fm version, then try again.
              </p>
            {/if}
          </div>{/if}
        <div>
          <button
            type="submit"
            disabled={!App.connection.canConnect(loginTab === "ticket") ||
              App.connection.connecting ||
              App.connection.identityLoading}
            class="bg-mauve text-crust hover:bg-pink flex h-11 w-full items-center justify-center gap-3 font-mono text-xs font-bold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40"
            >{#if App.connection.connecting}<span
                class="border-crust/25 border-t-crust size-3 animate-spin rounded-full border-2"
              ></span>{App.connection.connectionStep}{:else}CONNECT <ArrowIcon
                class="text-sm"
              />{/if}</button
          >
        </div>
      </div>
    </form>
  </section>
</main>

{#snippet QrScanner(/** @type {{ dismiss: (value: string | null) => void }} */ { dismiss })}
  {let error = $state("")}
  {const scan = $derived(
    createQrScanner(
      dismiss,
      (reason) => (error = friendlyError(reason, "Could not start the camera.")),
    ),
  )}
  <div class="border-surface0 bg-mantle flex items-center justify-between border-b px-4 py-3">
    <div>
      <h2 id="qr-title" class="text-sm font-semibold">Scan server ticket</h2>
      <p class="text-3xs text-overlay1 mt-0.5">Point the camera at a ticket QR code</p>
    </div>
    <button
      type="button"
      onclick={() => dismiss(null)}
      class="text-overlay1 hover:bg-surface0 hover:text-text grid size-8 place-items-center"
      ><CloseIcon class="text-sm" /></button
    >
  </div>
  <div class="p-4">
    <div class="bg-crust relative aspect-square overflow-hidden">
      <video {@attach scan} muted playsinline class="h-full w-full object-cover"></video>
      <div class="border-mauve/80 pointer-events-none absolute inset-8 border"></div>
    </div>
    {#if error}<p class="text-red mt-3 text-xs leading-5">{error}</p>{/if}
  </div>
{/snippet}
