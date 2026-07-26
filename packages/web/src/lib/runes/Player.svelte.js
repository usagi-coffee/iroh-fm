import { tick, untrack } from "svelte";

import { friendlyError } from "$lib/utils.js";

import { subscribeNativePlayerState } from "@iroh-fm/client/core";

const NATIVE_STATE_MAX_AGE_MS = 200;

export class Player {
  /** @type {HTMLAudioElement | null} */
  audio = null;
  audioSrc = $state("");
  /** @type {Awaited<ReturnType<import('@iroh-fm/client').MusicClient['trackSource']>> | null} */
  audioSource = $state(null);
  /** @type {import('$lib/runes/Track.svelte.js').Track | null} */
  currentTrack = $state(null);
  /** @type {import('$lib/runes/Track.svelte.js').Track[]} */
  queue = $state.raw([]);
  playing = $state(false);
  audioLoading = $state(false);
  downloadProgress = $derived(this.currentTrack?.progress ?? 0);
  error = $state("");
  currentTime = $state(0);
  duration = $state(0);
  volume = $state(0.5);
  repeat = $state(false);
  shuffle = $state(false);
  generation = 0;
  /** @type {number | null} */
  audioDownloadGeneration = null;
  nativeStatePending = false;
  nativeSeekGeneration = 0;
  nativeSeekPending = false;
  /** The latest native playback instance observed from the desktop player. */
  nativePlaybackGeneration = 0;
  /** @type {string | null} */
  nativePlayPendingTrackId = null;

  /** @param {import('$lib/runes/App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
    subscribeNativePlayerState((/** @type {any} */ state) => this.applyNativeState(state));
  }

  nativePlayback(client = this.app.connection.client) {
    return Boolean(
      client?.native || (client && "nativePlayback" in client && client.nativePlayback),
    );
  }

  /** @param {HTMLAudioElement} element */
  attachAudio = (element) => {
    this.audio = element;
    element.volume = this.volume;
    return () => {
      if (this.audio === element) this.audio = null;
    };
  };

  /** @param {import('@iroh-fm/client/types').Album} album */
  async playAlbum(album) {
    await this.playAlbumTracks(
      this.app.library.tracksForAlbum(album),
      this.app.library.getFilteredTracks(),
    );
  }

  /**
   * @param {import('$lib/runes/Track.svelte.js').Track[]} albumTracks
   * @param {import('$lib/runes/Track.svelte.js').Track[]} sourceQueue
   */
  async playAlbumTracks(albumTracks, sourceQueue) {
    const albumTrackIds = new Set(albumTracks.map((track) => track.id));
    const first = sourceQueue.find((track) => albumTrackIds.has(track.id));
    if (first) await this.play(first, sourceQueue);
  }

  /**
   * @param {import('$lib/runes/Track.svelte.js').Track} track
   * @param {import('$lib/runes/Track.svelte.js').Track[]} queue
   * @param {number} generation
   */
  prefetchNext(track, queue, generation) {
    if (generation !== this.generation || this.shuffle || this.repeat || queue.length < 2) return;
    const client = this.app.connection.client;
    if (!client) return;
    const index = queue.findIndex((item) => item.id === track.id);
    const next = queue[(index + 1) % queue.length];
    if (!next || next.id === track.id || next.cached || next.memoryCached || next.downloading)
      return;
    const downloadGeneration = next.startDownload();
    client
      .prefetchTrack(next.id, (/** @type {number} */ received, /** @type {number} */ total) =>
        next.updateProgress(received, total, downloadGeneration),
      )
      .then((/** @type {{cached: boolean, persistent: boolean}} */ result) => {
        if (this.app.connection.client === client && result?.persistent)
          this.app.library.markCached(next);
        else if (this.app.connection.client === client && result?.cached)
          this.app.library.markMemoryCached(next);
        else if (this.app.connection.client === client) next.setMemoryCached(false);
        else next.stopDownload(downloadGeneration);
      })
      .catch((/** @type {unknown} */ error) => {
        next.stopDownload(downloadGeneration);
        console.warn("[player] next-track prefetch failed", error);
      });
  }

  /**
   * @param {import('$lib/runes/Track.svelte.js').Track} track
   * @param {import('$lib/runes/Track.svelte.js').Track[]} [sourceQueue]
   */
  async play(track, sourceQueue = this.app.library.tracks) {
    const client = this.app.connection.client;
    if (!client) {
      console.warn(`[player] play ignored without a client: trackId=${track.id}`);
      return;
    }
    const generation = ++this.generation;
    console.info(
      `[player] play started: trackId=${track.id} generation=${generation} native=${this.nativePlayback(client)}`,
    );
    const previousTrack = this.currentTrack;
    const previousDownloadGeneration = this.audioDownloadGeneration;
    this.audio?.pause();
    this.audioSource?.dispose();
    if (previousTrack && !previousTrack.cached && previousDownloadGeneration !== null)
      previousTrack.stopDownload(previousDownloadGeneration);
    this.audioSource = null;
    this.audioDownloadGeneration = null;
    this.audioSrc = "";
    this.currentTrack = track;
    this.app.library.selectedTrackId = track.id;
    this.queue = [...sourceQueue];
    this.error = "";
    this.currentTime = 0;
    this.duration = track.duration_seconds || 0;
    this.audioLoading = true;
    this.playing = false;
    if (this.nativePlayback(client)) {
      if (track.downloading) track.stopDownload();
      const downloadGeneration = /** @type {number | null} */ (null);
      this.nativePlayPendingTrackId = track.id;
      let progressPending = false;
      const progressTimer = setInterval(() => {
        if (progressPending) return;
        progressPending = true;
        void client
          .playerState()
          .then((/** @type {any} */ state) => {
            if (
              generation === this.generation &&
              this.nativePlayPendingTrackId === track.id &&
              this.app.connection.client === client
            )
              this.applyNativeState(state, false, client);
          })
          .catch(() => {})
          .finally(() => (progressPending = false));
      }, 200);
      try {
        console.info(`[player] calling native play: trackId=${track.id} generation=${generation}`);
        const state = await client.playNative(
          track,
          sourceQueue,
          (/** @type {number} */ received, /** @type {number} */ total) => {
            if (downloadGeneration !== null)
              track.updateProgress(received, total, downloadGeneration);
          },
        );
        console.info(`[player] native play resolved: trackId=${track.id} generation=${generation}`);
        if (generation === this.generation) {
          this.nativePlayPendingTrackId = null;
          this.applyNativeState(state, false, client);
          if ("nativePlayback" in client && client.nativePlayback && !client.native)
            this.prefetchNext(track, sourceQueue, generation);
        }
      } catch (error) {
        console.error(
          `[player] native play failed: trackId=${track.id} generation=${generation}`,
          error,
        );
        if (generation === this.generation) {
          this.nativePlayPendingTrackId = null;
          if (downloadGeneration !== null) track.stopDownload(downloadGeneration);
          this.audioLoading = false;
          this.error = friendlyError(error, "This track could not be played.");
        }
      } finally {
        clearInterval(progressTimer);
      }
      return;
    }
    if (!("trackSource" in client)) throw new Error("browser playback is unavailable");
    const downloadGeneration = track.cached || track.memoryCached ? null : track.startDownload();
    this.audioDownloadGeneration = downloadGeneration;
    try {
      const source = await client.trackSource(
        track.id,
        (/** @type {number} */ received, /** @type {number} */ total) => {
          if (downloadGeneration !== null)
            track.updateProgress(received, total, downloadGeneration);
        },
      );
      if (generation !== this.generation) return source.dispose();
      this.audioSource = source;
      this.audioSrc = source.url;
      await tick();
      const audio = this.audio;
      if (!audio) throw new Error("The audio element is not available.");
      audio.load();
      await source.start(audio);
      if (generation !== this.generation) return;
      void source.done.then(
        (/** @type {string | false} */ cacheKind) => {
          if (this.app.connection.client !== client) return;
          if (cacheKind === "disk" && this.app.library.tracksById.get(track.id) === track)
            this.app.library.markCached(track);
          else if (cacheKind === "memory" && this.app.library.tracksById.get(track.id) === track)
            this.app.library.markMemoryCached(track);
          if (source.disposed || generation !== this.generation) return;
          if (cacheKind) this.prefetchNext(track, sourceQueue, generation);
          else track.setMemoryCached(false);
          this.audioDownloadGeneration = null;
        },
        (/** @type {unknown} */ error) => {
          if (generation === this.generation && this.audioSource === source && !source.disposed) {
            if (downloadGeneration !== null) track.stopDownload(downloadGeneration);
            this.audioDownloadGeneration = null;
            this.error = friendlyError(error, "Stream interrupted.");
          }
        },
      );
      await audio.play();
    } catch (error) {
      if (generation === this.generation) {
        if (downloadGeneration !== null) track.stopDownload(downloadGeneration);
        this.audioSource?.dispose();
        this.audioSource = null;
        this.audioDownloadGeneration = null;
        this.audioSrc = "";
        this.error = friendlyError(error, "This track could not be played.");
      }
    } finally {
      if (generation === this.generation) this.audioLoading = false;
    }
  }

  /**
   * @param {import('$lib/runes/Track.svelte.js').Track} track
   * @param {import('$lib/runes/Track.svelte.js').Track[]} queue
   */
  async playFromTrackList(track, queue) {
    this.app.library.selectedTrackId = track.id;
    if (
      this.currentTrack?.id === track.id &&
      (this.nativePlayback() || this.audioSource) &&
      !this.error
    )
      await this.toggle();
    else await this.play(track, queue);
  }

  stop() {
    this.generation += 1;
    this.nativePlayPendingTrackId = null;
    const track = this.currentTrack;
    const downloadGeneration = this.audioDownloadGeneration;
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client)) void client.playerCommand("stop").catch(() => {});
    this.audio?.pause();
    this.audioSource?.dispose();
    if (track && !track.cached && downloadGeneration !== null)
      track.stopDownload(downloadGeneration);
    this.audioSource = null;
    this.audioDownloadGeneration = null;
    this.audioSrc = "";
    this.currentTrack = null;
    this.queue = [];
    this.playing = false;
    this.audioLoading = false;
    this.error = "";
    this.currentTime = 0;
    this.duration = 0;
  }

  async toggle() {
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client)) {
      if (!this.currentTrack) return;
      this.applyNativeState(await client.playerCommand("toggle"), false, client);
      return;
    }
    if (!this.audio || this.audioLoading || !this.currentTrack) return;
    if (this.audio.paused)
      await this.audio
        .play()
        .catch((error) => (this.error = friendlyError(error, "Playback was blocked.")));
    else this.audio.pause();
  }

  /** @param {number} direction */
  adjacent(direction) {
    if (!this.currentTrack || !this.queue.length) return null;
    const currentId = this.currentTrack.id;
    if (this.shuffle && this.queue.some((track) => track.id !== currentId)) {
      const candidates = this.queue.filter((track) => track.id !== currentId);
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    const index = this.queue.findIndex((track) => track.id === currentId);
    return this.queue[(index + direction + this.queue.length) % this.queue.length];
  }

  /** @param {number} direction */
  async skip(direction) {
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client)) {
      this.applyNativeState(
        await client.playerCommand(direction < 0 ? "previous" : "next"),
        false,
        client,
      );
      return;
    }
    const next = this.adjacent(direction);
    if (next) await this.play(next, this.queue);
  }

  onEnded() {
    if (this.repeat && this.audio) {
      this.audio.currentTime = 0;
      void this.audio
        .play()
        .catch((error) => (this.error = friendlyError(error, "Playback was blocked.")));
    } else void this.skip(1);
  }

  /** @param {string | number} value */
  seek(value) {
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client)) {
      const generation = ++this.nativeSeekGeneration;
      this.nativeSeekPending = true;
      void client
        .playerCommand("seek", { seconds: Number(value) })
        .then((/** @type {any} */ state) => {
          if (generation === this.nativeSeekGeneration) this.applyNativeState(state, true, client);
        })
        .catch((/** @type {unknown} */ error) => {
          if (generation === this.nativeSeekGeneration)
            this.error = friendlyError(error, "Could not seek in this track.");
        })
        .finally(() => {
          if (generation === this.nativeSeekGeneration) this.nativeSeekPending = false;
        });
      return;
    }
    const audio = this.audio;
    const duration = Number.isFinite(audio?.duration)
      ? audio?.duration
      : this.currentTrack?.duration_seconds;
    if (duration && audio) audio.currentTime = Math.min(Number(value), duration);
  }

  get position() {
    return this.currentTime;
  }

  /** @param {string | number} value */
  set position(value) {
    this.seek(value);
  }

  /** @param {number} seconds */
  seekBy(seconds) {
    if (!this.currentTrack) return;
    const duration =
      this.duration || this.currentTrack.duration_seconds || Number.POSITIVE_INFINITY;
    const position = Math.max(0, Math.min(duration, this.currentTime + seconds));
    this.currentTime = position;
    this.seek(position);
  }

  /** @param {string | number} value */
  changeVolume(value) {
    this.volume = Math.min(1, Math.max(0, Number(value)));
    localStorage.setItem("iroh-fm-volume", String(this.volume));
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client)) {
      void client.playerCommand("volume", { value: this.volume });
      return;
    }
    if (this.audio) this.audio.volume = this.volume;
  }

  get playbackVolume() {
    return Math.sqrt(this.volume);
  }

  /** @param {string | number} value */
  set playbackVolume(value) {
    const sliderPosition = Math.min(1, Math.max(0, Number(value)));
    this.changeVolume(sliderPosition ** 2);
  }

  toggleRepeat() {
    this.repeat = !this.repeat;
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client))
      void client.playerCommand("repeat", { enabled: this.repeat });
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const client = this.app.connection.client;
    if (client && this.nativePlayback(client))
      void client.playerCommand("shuffle", { enabled: this.shuffle });
  }

  async refreshNativeState(client = this.app.connection.client) {
    if (!client || !this.nativePlayback(client) || this.nativeStatePending) return;
    const generation = this.generation;
    const pendingTrackId = this.nativePlayPendingTrackId;
    this.nativeStatePending = true;
    try {
      const state = await client.playerState(
        client.native ? { includeQueue: untrack(() => this.queue.length === 0) } : undefined,
      );
      if (
        this.app.connection.client !== client ||
        generation !== this.generation ||
        pendingTrackId !== this.nativePlayPendingTrackId
      )
        return;
      this.applyNativeState(state, false, client);
    } catch {
      // The activity or message channel can be transitioning while the TWA wakes.
    } finally {
      this.nativeStatePending = false;
    }
  }

  /**
   * @param {any} state
   * @param {boolean} [applySeekPosition]
   * @param {any} [client]
   */
  applyNativeState(state, applySeekPosition = false, client = this.app.connection.client) {
    if (!state || !this.nativePlayback(client)) return;
    const nativeGeneration = Number(state.generation);
    if (Number.isSafeInteger(nativeGeneration) && nativeGeneration < this.nativePlaybackGeneration)
      return;
    if (Number.isSafeInteger(nativeGeneration)) this.nativePlaybackGeneration = nativeGeneration;
    const timestamp = Number(state.timestamp);
    if (
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      Date.now() - timestamp > NATIVE_STATE_MAX_AGE_MS
    )
      return;
    this.applyNativeTransfers(state);
    if (this.nativePlayPendingTrackId && state.trackId !== this.nativePlayPendingTrackId) return;
    const track = state.trackId ? this.app.library.tracksById.get(state.trackId) : null;
    const nativeQueue = Array.isArray(state.queue)
      ? state.queue
          .map((/** @type {string} */ id) => this.app.library.tracksById.get(id))
          .filter(Boolean)
      : [];
    if (track) {
      const trackChanged = this.currentTrack?.id !== track.id;
      this.currentTrack = track;
      if (trackChanged) this.app.library.selectedTrackId = track.id;
      if (nativeQueue.length) this.queue = nativeQueue;
      else if (!this.queue.length) this.queue = [...this.app.library.tracks];
    } else if (!state.trackId) {
      this.currentTrack = null;
      this.queue = [];
    }
    this.playing = Boolean(state.playing);
    this.audioLoading = Boolean(state.loading);
    if (!this.nativeSeekPending || applySeekPosition)
      this.currentTime = Number(state.position) || 0;
    this.duration = Number(state.duration) || track?.duration_seconds || 0;
    this.repeat = Boolean(state.repeat);
    this.shuffle = Boolean(state.shuffle);
    if (Number.isFinite(Number(state.volume))) this.volume = Number(state.volume);
  }

  /** @param {any} state */
  applyNativeTransfers(state) {
    if (state.transfers && typeof state.transfers === "object") {
      for (const [id, transfer] of Object.entries(state.transfers)) {
        const queuedTrack = this.app.library.tracksById.get(id);
        if (!queuedTrack || !transfer || typeof transfer !== "object") continue;
        if (queuedTrack.cached) continue;
        if (transfer.cached) {
          this.app.library.markCached(queuedTrack);
          continue;
        }
        if (transfer.memoryCached) {
          this.app.library.markMemoryCached(queuedTrack);
          continue;
        }
        if ("memoryCached" in transfer) queuedTrack.setMemoryCached(false);
        const received = Math.max(0, Number(transfer.received) || 0);
        const total = Math.max(0, Number(transfer.total) || Number(queuedTrack.file_size) || 0);
        queuedTrack.updateProgress(received, total);
        queuedTrack.downloading = Boolean(transfer.active) && (total <= 0 || received < total);
      }
    } else if (state.trackId) {
      const track = this.app.library.tracksById.get(state.trackId);
      if (!track?.cached) {
        const received = Math.max(0, Number(state.transferReceived) || 0);
        const total = Math.max(0, Number(state.transferTotal) || Number(track?.file_size) || 0);
        track?.updateProgress(received, total);
        if (track)
          track.downloading = Boolean(state.transferring) && (total <= 0 || received < total);
      }
    }
  }
}
