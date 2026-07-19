import { tick } from "svelte";

import { friendlyError } from "../utils.js";

import { subscribeNativePlayerState } from "@iroh-fm/client/core";

export class Player {
  /** @type {HTMLAudioElement | null} */
  audio = null;
  audioSrc = $state("");
  /** @type {Awaited<ReturnType<import('@iroh-fm/client').MusicClient['trackSource']>> | null} */
  audioSource = $state(null);
  /** @type {import('./Track.svelte.js').Track | null} */
  currentTrack = $state(null);
  /** @type {import('./Track.svelte.js').Track[]} */
  queue = $state([]);
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

  /** @param {import('./App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
    subscribeNativePlayerState((/** @type {any} */ state) => this.applyNativeState(state));
  }

  /** @param {HTMLAudioElement} element */
  attachAudio = (element) => {
    this.audio = element;
    element.volume = this.volume;
    return () => {
      if (this.audio === element) this.audio = null;
    };
  };

  /** @param {import('../types').AlbumData} album */
  async playAlbum(album) {
    await this.playAlbumTracks(
      this.app.library.tracksForAlbum(album),
      this.app.library.getFilteredTracks(),
    );
  }

  /** @param {import('./Track.svelte.js').Track[]} albumTracks @param {import('./Track.svelte.js').Track[]} sourceQueue */
  async playAlbumTracks(albumTracks, sourceQueue) {
    const albumTrackIds = new Set(albumTracks.map((track) => track.id));
    const first = sourceQueue.find((track) => albumTrackIds.has(track.id));
    if (first) await this.play(first, sourceQueue);
  }

  /** @param {import('./Track.svelte.js').Track} track @param {import('./Track.svelte.js').Track[]} queue @param {number} generation */
  prefetchNext(track, queue, generation) {
    if (generation !== this.generation || this.shuffle || this.repeat || queue.length < 2) return;
    const client = this.app.connection.client;
    if (!client) return;
    const index = queue.findIndex((item) => item.id === track.id);
    const next = queue[(index + 1) % queue.length];
    if (!next || next.id === track.id || next.cached || next.downloading) return;
    const downloadGeneration = next.startDownload();
    client
      .prefetchTrack(next.id, (/** @type {number} */ received, /** @type {number} */ total) =>
        next.updateProgress(received, total, downloadGeneration),
      )
      .then((/** @type {boolean} */ cached) => {
        if (this.app.connection.client === client && cached) this.app.library.markCached(next);
        else if (this.app.connection.client === client) next.setCached(false);
        else next.stopDownload(downloadGeneration);
      })
      .catch((/** @type {unknown} */ error) => {
        next.stopDownload(downloadGeneration);
        console.warn("[player] next-track prefetch failed", error);
      });
  }

  /** @param {import('./Track.svelte.js').Track} track @param {import('./Track.svelte.js').Track[]} [sourceQueue] */
  async play(track, sourceQueue = this.app.library.tracks) {
    const client = this.app.connection.client;
    if (!client) return;
    const generation = ++this.generation;
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
    if (client.native) {
      const downloadGeneration = track.startDownload();
      try {
        this.applyNativeState(await client.playNative(track, sourceQueue));
      } catch (error) {
        if (generation === this.generation) {
          track.stopDownload(downloadGeneration);
          this.audioLoading = false;
          this.error = friendlyError(error, "This track could not be played.");
        }
      }
      return;
    }
    const downloadGeneration = track.cached ? null : track.startDownload();
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
        (/** @type {boolean} */ cached) => {
          if (this.app.connection.client !== client) return;
          if (cached && this.app.library.tracksById.get(track.id) === track)
            this.app.library.markCached(track);
          if (source.disposed || generation !== this.generation) return;
          if (cached) this.prefetchNext(track, sourceQueue, generation);
          else track.setCached(false);
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

  /** @param {import('./Track.svelte.js').Track} track @param {import('./Track.svelte.js').Track[]} queue */
  async playFromTrackList(track, queue) {
    this.app.library.selectedTrackId = track.id;
    if (
      this.currentTrack?.id === track.id &&
      (this.app.connection.client?.native || this.audioSource) &&
      !this.error
    )
      await this.toggle();
    else await this.play(track, queue);
  }

  stop() {
    this.generation += 1;
    const track = this.currentTrack;
    const downloadGeneration = this.audioDownloadGeneration;
    if (this.app.connection.client?.native)
      void this.app.connection.client.playerCommand("stop").catch(() => {});
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
    if (this.app.connection.client?.native) {
      if (!this.currentTrack) return;
      this.applyNativeState(await this.app.connection.client.playerCommand("toggle"));
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
    if (this.app.connection.client?.native) {
      this.applyNativeState(
        await this.app.connection.client.playerCommand(direction < 0 ? "previous" : "next"),
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
    if (this.app.connection.client?.native) {
      void this.app.connection.client
        .playerCommand("seek", { seconds: Number(value) })
        .then((/** @type {any} */ state) => this.applyNativeState(state));
      return;
    }
    const audio = this.audio;
    const duration = Number.isFinite(audio?.duration)
      ? audio?.duration
      : this.currentTrack?.duration_seconds;
    if (duration && audio) audio.currentTime = Math.min(Number(value), duration);
  }

  /** @param {string | number} value */
  changeVolume(value) {
    this.volume = Math.min(1, Math.max(0, Number(value)));
    localStorage.setItem("iroh-fm-volume", String(this.volume));
    if (this.app.connection.client?.native) {
      void this.app.connection.client.playerCommand("volume", { value: this.volume });
      return;
    }
    if (this.audio) this.audio.volume = this.volume;
  }

  toggleRepeat() {
    this.repeat = !this.repeat;
    if (this.app.connection.client?.native)
      void this.app.connection.client.playerCommand("repeat", { enabled: this.repeat });
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.app.connection.client?.native)
      void this.app.connection.client.playerCommand("shuffle", { enabled: this.shuffle });
  }

  async refreshNativeState(client = this.app.connection.client) {
    if (!client?.native || this.nativeStatePending) return;
    this.nativeStatePending = true;
    try {
      this.applyNativeState(await client.playerState());
    } catch {
      // The activity or message channel can be transitioning while the TWA wakes.
    } finally {
      this.nativeStatePending = false;
    }
  }

  /** @param {any} state */
  applyNativeState(state) {
    if (!state || !this.app.connection.client?.native) return;
    const track = state.trackId ? this.app.library.tracksById.get(state.trackId) : null;
    const nativeQueue = Array.isArray(state.queue)
      ? state.queue
          .map((/** @type {string} */ id) => this.app.library.tracksById.get(id))
          .filter(Boolean)
      : [];
    if (track) {
      this.currentTrack = track;
      this.app.library.selectedTrackId = track.id;
      if (nativeQueue.length) this.queue = nativeQueue;
      else if (!this.queue.length) this.queue = [...this.app.library.tracks];
    } else if (!state.trackId) {
      this.currentTrack = null;
      this.queue = [];
    }
    this.playing = Boolean(state.playing);
    this.audioLoading = Boolean(state.loading);
    this.currentTime = Number(state.position) || 0;
    this.duration = Number(state.duration) || track?.duration_seconds || 0;
    if (state.transfers && typeof state.transfers === "object") {
      for (const [id, transfer] of Object.entries(state.transfers)) {
        const queuedTrack = this.app.library.tracksById.get(id);
        if (!queuedTrack || !transfer || typeof transfer !== "object") continue;
        const received = Math.max(0, Number(transfer.received) || 0);
        const total = Math.max(0, Number(transfer.total) || Number(queuedTrack.file_size) || 0);
        queuedTrack.updateProgress(received, total);
        queuedTrack.downloading = Boolean(transfer.active) && (total <= 0 || received < total);
      }
    } else if (track) {
      const received = Math.max(0, Number(state.transferReceived) || 0);
      const total = Math.max(0, Number(state.transferTotal) || Number(track.file_size) || 0);
      track.updateProgress(received, total);
      track.downloading = Boolean(state.transferring) && (total <= 0 || received < total);
    }
    this.repeat = Boolean(state.repeat);
    this.shuffle = Boolean(state.shuffle);
    if (Number.isFinite(Number(state.volume))) this.volume = Number(state.volume);
  }
}
