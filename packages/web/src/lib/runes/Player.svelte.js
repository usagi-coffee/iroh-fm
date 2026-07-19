import { tick } from "svelte";

import { friendlyError } from "../utils.js";

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
  volume = $state(0.8);
  repeat = $state(false);
  shuffle = $state(false);
  generation = 0;
  /** @type {number | null} */
  audioDownloadGeneration = null;

  /** @param {import('./App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
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
    const tracks = this.app.library
      .tracksForAlbum(album)
      .filter((track) => !this.app.library.offlineOnly || track.cached);
    if (tracks[0]) await this.play(tracks[0], tracks);
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
      .prefetchTrack(next.id, (received, total) =>
        next.updateProgress(received, total, downloadGeneration),
      )
      .then((cached) => {
        if (this.app.connection.client === client && cached) this.app.library.markCached(next);
        else if (this.app.connection.client === client) next.setCached(false);
        else next.stopDownload(downloadGeneration);
      })
      .catch((error) => {
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
    const downloadGeneration = track.cached ? null : track.startDownload();
    this.audioDownloadGeneration = downloadGeneration;
    try {
      const source = await client.trackSource(track.id, (received, total) => {
        if (downloadGeneration !== null) track.updateProgress(received, total, downloadGeneration);
      });
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
        (cached) => {
          if (this.app.connection.client !== client) return;
          if (cached && this.app.library.tracksById.get(track.id) === track)
            this.app.library.markCached(track);
          if (source.disposed || generation !== this.generation) return;
          if (cached) this.prefetchNext(track, sourceQueue, generation);
          else track.setCached(false);
          this.audioDownloadGeneration = null;
        },
        (error) => {
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
    if (this.currentTrack?.id === track.id && this.audioSource && !this.error) await this.toggle();
    else await this.play(track, queue);
  }

  stop() {
    this.generation += 1;
    const track = this.currentTrack;
    const downloadGeneration = this.audioDownloadGeneration;
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
    if (this.audio) this.audio.volume = this.volume;
  }
}
