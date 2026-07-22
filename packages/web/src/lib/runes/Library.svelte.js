import { SvelteSet } from "svelte/reactivity";

import { goto } from "$app/navigation";
import { resolve } from "$app/paths";

import { Track } from "$lib/runes/Track.svelte.js";
import { createTrackListItems } from "$lib/track-list-items.js";
import { filterTracks, friendlyError, indexTracksForSearch } from "$lib/utils.js";

export class Library {
  summary = $state.raw({ artist_count: 0, album_count: 0, track_count: 0 });
  /** @type {import('@iroh-fm/client/types').Album[]} */
  albums = $state.raw([]);
  /** @type {import('@iroh-fm/client/types').Artist[]} */
  artists = $state.raw([]);
  /** @type {Track[]} */
  tracks = $state.raw([]);
  /** @type {import('@iroh-fm/client/types').StarredSet} */
  starred = $state({ artists: [], albums: [], tracks: [] });
  offlineOnly = $state(false);
  starredTrackIds = $derived(new Set(this.starred.tracks.map((track) => track.id)));
  starredAlbumIds = $derived(new Set(this.starred.albums.map((album) => album.id)));
  cachedTracks = $derived(this.tracks.filter((track) => track.cached));
  /** @type {SvelteSet<string>} */
  cachingTrackIds = new SvelteSet();
  /** @type {SvelteSet<string>} */
  cachingAlbumIds = new SvelteSet();
  tracksById = $derived(new Map(this.tracks.map((track) => [track.id, track])));
  albumById = $derived(new Map(this.albums.map((album) => [album.id, album])));
  albumByTrackId = $derived.by(() => {
    /** @type {Map<string, import('@iroh-fm/client/types').Album>} */
    const albums = new Map();
    for (const album of this.albums) {
      for (const id of album.track_ids) albums.set(id, album);
    }
    return albums;
  });
  tracksByAlbum = $derived.by(() => {
    /** @type {Map<string, Track[]>} */
    const albums = new Map();
    for (const track of this.tracks) {
      const album = this.albumByTrackId.get(track.id);
      const key = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
      const tracks = albums.get(key) ?? [];
      tracks.push(track);
      albums.set(key, tracks);
    }
    return albums;
  });
  cachedTracksByAlbum = $derived.by(() => {
    /** @type {Map<string, Track[]>} */
    const albums = new Map();
    for (const [albumKey, tracks] of this.tracksByAlbum) {
      const cached = tracks.filter((track) => track.cached);
      if (cached.length) albums.set(albumKey, cached);
    }
    return albums;
  });
  allStarredTrackIds = $derived.by(() => {
    const selected = new Set(this.starred.tracks.map((track) => track.id));
    for (const album of this.starred.albums) {
      for (const id of album.track_ids) selected.add(id);
    }
    for (const artist of this.starred.artists) {
      for (const albumId of artist.album_ids) {
        for (const id of this.albumById.get(albumId)?.track_ids ?? []) selected.add(id);
      }
    }
    return selected;
  });
  starredTracks = $derived(this.tracks.filter((track) => this.allStarredTrackIds.has(track.id)));
  cachedStarredTracks = $derived(this.starredTracks.filter((track) => track.cached));
  availableTracks = $derived(this.offlineOnly ? this.cachedTracks : this.tracks);
  availableStarredTracks = $derived(
    this.offlineOnly ? this.cachedStarredTracks : this.starredTracks,
  );
  trackListItems = $derived(this.createTrackListItems(this.tracks, false));
  cachedTrackListItems = $derived(this.createTrackListItems(this.cachedTracks, true));
  starredTrackListItems = $derived(this.createTrackListItems(this.starredTracks, false));
  cachedStarredTrackListItems = $derived(this.createTrackListItems(this.cachedStarredTracks, true));
  availableTrackListItems = $derived(
    this.offlineOnly ? this.cachedTrackListItems : this.trackListItems,
  );
  availableStarredTrackListItems = $derived(
    this.offlineOnly ? this.cachedStarredTrackListItems : this.starredTrackListItems,
  );
  offlineAlbums = $derived(
    this.albums.filter((album) => (this.cachedTracksByAlbum.get(album.id)?.length ?? 0) > 0),
  );
  visibleAlbums = $derived(this.offlineOnly ? this.offlineAlbums : this.albums);
  fullyCachedAlbumIds = $derived(
    new Set(
      this.albums
        .filter(
          (album) =>
            album.track_ids.length > 0 &&
            this.cachedTracksByAlbum.get(album.id)?.length === album.track_ids.length,
        )
        .map((album) => album.id),
    ),
  );
  trackFilterFocusPending = $state(false);
  /** @type {string | null} */
  selectedTrackId = $state(null);
  /** @type {string | null} */
  pendingTrackFocusId = $state(null);

  /** @param {import('$lib/runes/App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
  }

  /**
   * @param {import('@iroh-fm/client/types').TrackData[]} rawTracks
   * @param {Iterable<string>} cachedIds
   */
  replaceTracks(rawTracks, cachedIds) {
    const cached = new Set(cachedIds);
    const previousTracksById = this.tracksById;
    const next = rawTracks.map((data) => {
      let track = previousTracksById.get(data.id);
      if (track) track.updateMetadata(data);
      else track = new Track(data, cached.has(data.id));
      track.setCached(cached.has(data.id));
      track.setMemoryCached(false);
      return track;
    });
    this.tracks = next;
  }

  prepareIndexes() {
    indexTracksForSearch(this.tracks);
    void this.starredTrackIds.size;
    void this.starredAlbumIds.size;
    void this.trackListItems.length;
    void this.cachedTrackListItems.length;
    void this.starredTrackListItems.length;
    void this.cachedStarredTrackListItems.length;
    void this.visibleAlbums.length;
    void this.fullyCachedAlbumIds.size;
  }

  /** @param {Iterable<string>} ids */
  replaceCachedIds(ids) {
    const cached = new Set(ids);
    for (const track of this.tracks) track.setCached(cached.has(track.id));
  }

  /** @param {Track} track */
  markCached(track) {
    track.setCached(true);
  }

  /** @param {Track} track */
  markMemoryCached(track) {
    track.setMemoryCached(true);
  }

  /**
   * @param {boolean} [starredOnly]
   * @param {string} [query]
   */
  getFilteredTracks(starredOnly = false, query = "") {
    const source = starredOnly ? this.availableStarredTracks : this.availableTracks;
    if (!query.trim()) return source;
    return filterTracks(source, query);
  }

  /** @param {Track[]} filtered */
  getTrackListItems(filtered) {
    if (filtered === this.availableTracks) return this.availableTrackListItems;
    if (filtered === this.availableStarredTracks) return this.availableStarredTrackListItems;
    return this.createTrackListItems(filtered);
  }

  /**
   * @param {Track[]} filtered
   * @param {boolean} [offlineOnly]
   */
  createTrackListItems(filtered, offlineOnly = this.offlineOnly) {
    return createTrackListItems(
      filtered,
      offlineOnly,
      this.albumByTrackId,
      this.tracksByAlbum,
      this.cachedTracksByAlbum,
    );
  }

  /** @param {Track | null} track */
  requestTrackFocus(track) {
    if (!track) return;
    this.selectedTrackId = track.id;
    this.pendingTrackFocusId = track.id;
  }

  /** @param {Track} track */
  async focusTrack(track) {
    this.requestTrackFocus(track);
    await goto(resolve("/tracks"));
  }

  /** Album cache state is derived exclusively from its individual track files. */
  /** @param {import('@iroh-fm/client/types').Album} album */
  isAlbumFullyCached(album) {
    return this.fullyCachedAlbumIds.has(album.id);
  }

  /** @param {import('@iroh-fm/client/types').Album} album */
  firstAvailableTrackForAlbum(album) {
    const ids = new Set(album.track_ids);
    return this.tracks.find((track) => ids.has(track.id) && (!this.offlineOnly || track.cached));
  }

  /** @param {import('@iroh-fm/client/types').Album} album */
  async selectAlbum(album) {
    const first = this.firstAvailableTrackForAlbum(album);
    if (!first) return null;
    await this.focusTrack(first);
    return first;
  }

  /** @param {import('@iroh-fm/client/types').Album} album */
  async activateAlbum(album) {
    const first = await this.selectAlbum(album);
    if (first && window.matchMedia("(max-width: 1023px)").matches)
      await this.app.player.playAlbum(album);
  }

  /** @param {import('@iroh-fm/client/types').Album} album */
  async playAndSelectAlbum(album) {
    const first = await this.selectAlbum(album);
    if (!first) return;
    await this.app.player.playAlbum(album);
  }

  /**
   * @param {Track} track
   * @param {{ stopPropagation(): void } | undefined} [event]
   */
  async toggleStar(track, event) {
    event?.stopPropagation();
    const client = this.app.connection.client;
    if (!client) return;
    const starred = !this.starredTrackIds.has(track.id);
    try {
      await client.setStarred(track.id, starred, this.app.starredKey);
      if (this.app.connection.client !== client) return;
      this.starred.tracks = starred
        ? [track, ...this.starred.tracks.filter((item) => item.id !== track.id)]
        : this.starred.tracks.filter((item) => item.id !== track.id);
    } catch (error) {
      if (this.app.connection.client === client)
        this.app.connection.error = friendlyError(error, "Could not update the starred track.");
    }
  }

  async refreshCachedTracks() {
    const client = this.app.connection.client;
    if (!client) return;
    const ids = await client.cachedTrackIds();
    if (this.app.connection.client === client) this.replaceCachedIds(ids);
  }

  async toggleOfflineOnly() {
    if (!this.offlineOnly) await this.refreshCachedTracks();
    const client = this.app.connection.client;
    if (!client) return;
    const offlineOnly = !this.offlineOnly;
    try {
      await client.setOfflineOnly(offlineOnly);
    } catch (error) {
      if (this.app.connection.client === client)
        this.app.connection.error = friendlyError(error, "Could not change offline mode.");
      return;
    }
    if (this.app.connection.client !== client) return;
    this.offlineOnly = offlineOnly;
    if (offlineOnly && this.app.player.currentTrack && !this.app.player.currentTrack.cached)
      this.app.player.stop();
  }

  /** @param {Track} track */
  async cacheTrack(track) {
    if (this.offlineOnly || track.cached || track.downloading || this.cachingTrackIds.has(track.id))
      return;
    const client = this.app.connection.client;
    if (!client) return;
    this.cachingTrackIds.add(track.id);
    const downloadGeneration = track.startDownload();
    try {
      const cached = await client.cacheTrack(
        track.id,
        (/** @type {number} */ received, /** @type {number} */ total) =>
          track.updateProgress(received, total, downloadGeneration),
      );
      if (!cached) throw new Error("The client could not store this track for offline playback.");
      if (this.app.connection.client === client) this.markCached(track);
      else track.stopDownload(downloadGeneration);
    } catch (error) {
      track.stopDownload(downloadGeneration);
      if (this.app.connection.client === client)
        this.app.connection.error = friendlyError(error, "Could not cache this track.");
    } finally {
      this.cachingTrackIds.delete(track.id);
    }
  }

  /** @param {import('@iroh-fm/client/types').Album} album */
  tracksForAlbum(album) {
    const tracks = this.tracksByAlbum.get(album.id) ?? [];
    return this.offlineOnly ? (this.cachedTracksByAlbum.get(album.id) ?? []) : tracks;
  }

  /**
   * @param {Track[]} tracks
   * @param {string} cacheKey
   */
  async cacheAlbum(tracks, cacheKey) {
    if (this.offlineOnly || this.cachingAlbumIds.has(cacheKey)) return;
    const client = this.app.connection.client;
    if (!client) return;
    const missing = tracks.filter((track) => !track.cached && !track.downloading);
    if (!missing.length) return;
    this.cachingAlbumIds.add(cacheKey);
    /** @type {Map<Track, number>} */
    const downloads = new Map();
    try {
      for (const track of missing) {
        this.cachingTrackIds.add(track.id);
        const downloadGeneration = track.startDownload();
        downloads.set(track, downloadGeneration);
        const cached = await client.cacheTrack(
          track.id,
          (/** @type {number} */ received, /** @type {number} */ total) =>
            track.updateProgress(received, total, downloadGeneration),
        );
        if (!cached) throw new Error("The client could not store this track for offline playback.");
        if (this.app.connection.client !== client) {
          for (const [pending, generation] of downloads) pending.stopDownload(generation);
          return;
        }
        this.markCached(track);
        this.cachingTrackIds.delete(track.id);
      }
    } catch (error) {
      for (const [track, generation] of downloads) track.stopDownload(generation);
      if (this.app.connection.client === client)
        this.app.connection.error = friendlyError(error, "Could not cache this album.");
    } finally {
      for (const track of missing) this.cachingTrackIds.delete(track.id);
      this.cachingAlbumIds.delete(cacheKey);
    }
  }

  /** @param {import('@iroh-fm/client/types').Album | null | undefined} album */
  async toggleStarAlbum(album) {
    if (!album) return;
    const client = this.app.connection.client;
    if (!client) return;
    const starred = !this.starredAlbumIds.has(album.id);
    try {
      await client.setStarred(album.id, starred, this.app.starredKey);
      if (this.app.connection.client !== client) return;
      this.starred.albums = starred
        ? [album, ...this.starred.albums.filter((item) => item.id !== album.id)]
        : this.starred.albums.filter((item) => item.id !== album.id);
    } catch (error) {
      if (this.app.connection.client === client)
        this.app.connection.error = friendlyError(error, "Could not update the starred album.");
    }
  }
}
