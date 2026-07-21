import { SvelteSet } from "svelte/reactivity";

import { goto } from "$app/navigation";
import { resolve } from "$app/paths";

import { filterTracks, friendlyError } from "../utils.js";
import { Track } from "./Track.svelte.js";

export class Library {
  /** @type {import('../types').LibrarySummary} */
  summary = $state({ artist_count: 0, album_count: 0, track_count: 0 });
  /** @type {import('../types').AlbumData[]} */
  albums = $state([]);
  /** @type {import('../types').ArtistData[]} */
  artists = $state([]);
  /** @type {Track[]} */
  tracks = $state([]);
  /** @type {import('../types').StarredSet} */
  starred = $state({ artists: [], albums: [], tracks: [] });
  offlineOnly = $state(false);
  /** @type {Set<string>} */
  starredTrackIds = $derived(new Set(this.starred.tracks.map((track) => track.id)));
  /** @type {Set<string>} */
  starredAlbumIds = $derived(new Set(this.starred.albums.map((album) => album.id)));
  /** @type {Track[]} */
  cachedTracks = $derived(this.tracks.filter((track) => track.cached));
  /** @type {Set<string>} */
  cachedTrackIds = $derived(new Set(this.cachedTracks.map((track) => track.id)));
  /** @type {SvelteSet<string>} */
  cachingTrackIds = new SvelteSet();
  /** @type {SvelteSet<string>} */
  cachingAlbumIds = new SvelteSet();
  /** @type {Map<string, Track>} */
  tracksById = $derived(new Map(this.tracks.map((track) => [track.id, track])));
  /** @type {Map<string, import('../types').AlbumData>} */
  albumById = $derived(new Map(this.albums.map((album) => [album.id, album])));
  /** @type {Map<string, import('../types').AlbumData>} */
  albumByTrackId = $derived.by(() => {
    /** @type {Map<string, import('../types').AlbumData>} */
    const albums = new Map();
    for (const album of this.albums) {
      for (const id of album.track_ids) albums.set(id, album);
    }
    return albums;
  });
  /** @type {Map<string, Track[]>} */
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
  /** @type {Map<string, Track[]>} */
  cachedTracksByAlbum = $derived.by(() => {
    /** @type {Map<string, Track[]>} */
    const albums = new Map();
    for (const [albumKey, tracks] of this.tracksByAlbum) {
      const cached = tracks.filter((track) => track.cached);
      if (cached.length) albums.set(albumKey, cached);
    }
    return albums;
  });
  /** @type {Set<string>} */
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
  /** @type {Track[]} */
  starredTracks = $derived(this.tracks.filter((track) => this.allStarredTrackIds.has(track.id)));
  /** @type {Track[]} */
  cachedStarredTracks = $derived(this.starredTracks.filter((track) => track.cached));
  /** @type {Track[]} */
  availableTracks = $derived(this.offlineOnly ? this.cachedTracks : this.tracks);
  /** @type {Track[]} */
  availableStarredTracks = $derived(
    this.offlineOnly ? this.cachedStarredTracks : this.starredTracks,
  );
  /** @type {import('../types').TrackListItem[]} */
  trackListItems = $derived(this.createTrackListItems(this.tracks, false));
  /** @type {import('../types').TrackListItem[]} */
  cachedTrackListItems = $derived(this.createTrackListItems(this.cachedTracks, true));
  /** @type {import('../types').TrackListItem[]} */
  starredTrackListItems = $derived(this.createTrackListItems(this.starredTracks, false));
  /** @type {import('../types').TrackListItem[]} */
  cachedStarredTrackListItems = $derived(this.createTrackListItems(this.cachedStarredTracks, true));
  /** @type {import('../types').TrackListItem[]} */
  availableTrackListItems = $derived(
    this.offlineOnly ? this.cachedTrackListItems : this.trackListItems,
  );
  /** @type {import('../types').TrackListItem[]} */
  availableStarredTrackListItems = $derived(
    this.offlineOnly ? this.cachedStarredTrackListItems : this.starredTrackListItems,
  );
  trackFilterQuery = $state("");
  /** @type {Track[]} */
  filteredTracks = $derived(
    this.trackFilterQuery.trim()
      ? filterTracks(this.availableTracks, this.trackFilterQuery)
      : this.availableTracks,
  );
  /** @type {import('../types').TrackListItem[]} */
  filteredTrackListItems = $derived(
    this.trackFilterQuery.trim()
      ? this.createTrackListItems(this.filteredTracks)
      : this.availableTrackListItems,
  );
  /** @type {import('../types').AlbumData[]} */
  offlineAlbums = $derived(
    this.albums.filter(
      (album) =>
        album.track_ids.length > 0 && album.track_ids.some((id) => this.cachedTrackIds.has(id)),
    ),
  );
  /** @type {import('../types').AlbumData[]} */
  visibleAlbums = $derived(this.offlineOnly ? this.offlineAlbums : this.albums);
  /** @type {Set<string>} */
  fullyCachedAlbumIds = $derived(
    new Set(
      this.albums
        .filter(
          (album) =>
            album.track_ids.length > 0 &&
            album.track_ids.every((id) => this.cachedTrackIds.has(id)),
        )
        .map((album) => album.id),
    ),
  );
  trackFilterFocusPending = $state(false);
  /** @type {string | null} */
  selectedTrackId = $state(null);
  /** @type {string | null} */
  pendingTrackFocusId = $state(null);

  /** @param {import('./App.svelte.js').Application} app */
  constructor(app) {
    this.app = app;
  }

  /** @param {import('../types').TrackData[]} rawTracks @param {Iterable<string>} cachedIds */
  replaceTracks(rawTracks, cachedIds) {
    const cached = new Set(cachedIds);
    const previousTracksById = this.tracksById;
    const next = rawTracks.map((data) => {
      let track = previousTracksById.get(data.id);
      if (track) track.updateMetadata(data);
      else track = new Track(data, cached.has(data.id));
      track.setCached(cached.has(data.id));
      return track;
    });
    this.tracks = next;
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

  /** @param {boolean} [starredOnly] @param {string} [query] */
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

  /** @param {Track[]} filtered @param {boolean} [offlineOnly] */
  createTrackListItems(filtered, offlineOnly = this.offlineOnly) {
    /** @type {import('../types').TrackListItem[]} */
    const items = [];
    let previousAlbumKey;
    for (const [trackIndex, track] of filtered.entries()) {
      const album = this.albumByTrackId.get(track.id);
      const albumKey = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
      if (albumKey !== previousAlbumKey) {
        const allAlbumTracks = this.tracksByAlbum.get(albumKey) ?? [track];
        const albumTracks = offlineOnly
          ? (this.cachedTracksByAlbum.get(albumKey) ?? [])
          : allAlbumTracks;
        items.push({
          kind: "album",
          key: `album:${albumKey}:${track.id}`,
          title: album?.title ?? track.album,
          artist: album?.album_artist ?? album?.artist ?? track.album_artist ?? track.artist,
          coverArtId: album?.cover_art_id ?? track.cover_art_id,
          durationSeconds:
            (!offlineOnly ? album?.duration_seconds : null) ??
            albumTracks.reduce((total, item) => total + (item.duration_seconds ?? 0), 0),
          tracks: albumTracks,
          album,
        });
        previousAlbumKey = albumKey;
      }
      items.push({ kind: "track", key: `track:${track.id}`, track, trackIndex });
    }
    return items;
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

  /** @param {string} character */
  async focusTrackFilter(character) {
    this.trackFilterQuery += character;
    this.trackFilterFocusPending = true;
    await goto(resolve("/tracks"));
  }

  /** Album cache state is derived exclusively from its individual track files. */
  /** @param {import('../types').AlbumData} album */
  isAlbumFullyCached(album) {
    return this.fullyCachedAlbumIds.has(album.id);
  }

  /** @param {import('../types').AlbumData} album */
  async selectAlbum(album) {
    const ids = new Set(album.track_ids);
    const first = this.tracks.find(
      (track) => ids.has(track.id) && (!this.offlineOnly || track.cached),
    );
    if (!first) return null;
    await this.focusTrack(first);
    return first;
  }

  /** @param {import('../types').AlbumData} album */
  async activateAlbum(album) {
    const first = await this.selectAlbum(album);
    if (first && window.matchMedia("(max-width: 1023px)").matches)
      await this.app.player.playAlbum(album);
  }

  /** @param {import('../types').AlbumData} album */
  async playAndSelectAlbum(album) {
    const first = await this.selectAlbum(album);
    if (first) await this.app.player.playAlbum(album);
  }

  /** @param {Track} track @param {{ stopPropagation(): void } | undefined} [event] */
  async toggleStar(track, event) {
    event?.stopPropagation();
    const client = this.app.connection.client;
    if (!client) return;
    const starred = !this.starredTrackIds.has(track.id);
    try {
      await client.request(
        this.app.starredKey
          ? { SetStarredWithKey: { id: track.id, starred, key: this.app.starredKey } }
          : { SetStarred: { id: track.id, starred } },
      );
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
      const cached = await client.prefetchTrack(
        track.id,
        (/** @type {number} */ received, /** @type {number} */ total) =>
          track.updateProgress(received, total, downloadGeneration),
      );
      if (!cached) throw new Error("The browser could not store this track for offline playback.");
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

  /** @param {import('../types').AlbumData} album */
  tracksForAlbum(album) {
    const tracks = this.tracksByAlbum.get(album.id) ?? [];
    return this.offlineOnly ? (this.cachedTracksByAlbum.get(album.id) ?? []) : tracks;
  }

  /** @param {Track[]} tracks @param {string} cacheKey */
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
        const cached = await client.prefetchTrack(
          track.id,
          (/** @type {number} */ received, /** @type {number} */ total) =>
            track.updateProgress(received, total, downloadGeneration),
        );
        if (!cached)
          throw new Error("The browser could not store this track for offline playback.");
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

  /** @param {import('../types').AlbumData | null | undefined} album */
  async toggleStarAlbum(album) {
    if (!album) return;
    const client = this.app.connection.client;
    if (!client) return;
    const starred = !this.starredAlbumIds.has(album.id);
    try {
      await client.request(
        this.app.starredKey
          ? { SetStarredWithKey: { id: album.id, starred, key: this.app.starredKey } }
          : { SetStarred: { id: album.id, starred } },
      );
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
