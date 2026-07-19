import { SvelteMap, SvelteSet } from "svelte/reactivity";

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
  /** @type {import('../types').TrackListItem[]} */
  trackListItems = $state.raw([]);
  /** @type {import('../types').StarredSet} */
  starred = $state({ artists: [], albums: [], tracks: [] });
  /** @type {Set<string>} */
  starredTrackIds = $derived.by(() => new Set(this.starred.tracks.map((track) => track.id)));
  /** @type {Set<string>} */
  cachedTrackIds = $derived.by(
    () => new Set(this.tracks.filter((track) => track.cached).map((track) => track.id)),
  );
  /** @type {SvelteSet<string>} */
  cachingTrackIds = new SvelteSet();
  /** @type {SvelteSet<string>} */
  cachingAlbumIds = new SvelteSet();
  /** @type {SvelteMap<string, Track>} */
  tracksById = new SvelteMap();
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
  /** @type {Set<string>} */
  allStarredTrackIds = $derived.by(() => {
    const selected = new Set(this.starred.tracks.map((track) => track.id));
    const albums = new Map(this.albums.map((album) => [album.id, album]));
    for (const album of this.starred.albums) {
      for (const id of album.track_ids) selected.add(id);
    }
    for (const artist of this.starred.artists) {
      for (const albumId of artist.album_ids) {
        for (const id of albums.get(albumId)?.track_ids ?? []) selected.add(id);
      }
    }
    return selected;
  });
  /** @type {Track[]} */
  starredTracks = $derived.by(() =>
    this.tracks.filter((track) => this.allStarredTrackIds.has(track.id)),
  );
  offlineOnly = $state(false);
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
    const present = new Set();
    const next = rawTracks.map((data) => {
      present.add(data.id);
      let track = this.tracksById.get(data.id);
      if (track) track.updateMetadata(data);
      else {
        track = new Track(data, cached.has(data.id));
        this.tracksById.set(data.id, track);
      }
      track.setCached(cached.has(data.id));
      return track;
    });
    for (const id of this.tracksById.keys()) {
      if (!present.has(id)) this.tracksById.delete(id);
    }
    this.tracks = next;
    this.trackListItems = this.createTrackListItems(next);
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
    const source = starredOnly ? this.starredTracks : this.tracks;
    const available = this.offlineOnly ? source.filter((track) => track.cached) : source;
    if (!query.trim()) return available;
    return filterTracks(available, query);
  }

  /** @param {Track[]} filtered */
  getTrackListItems(filtered) {
    if (filtered === this.tracks) return this.trackListItems;
    return this.createTrackListItems(filtered);
  }

  /** @param {Track[]} filtered */
  createTrackListItems(filtered) {
    /** @type {import('../types').TrackListItem[]} */
    const items = [];
    let previousAlbumKey;
    for (const [trackIndex, track] of filtered.entries()) {
      const album = this.albumByTrackId.get(track.id);
      const albumKey = album?.id ?? `${track.album}\u0000${track.album_artist ?? track.artist}`;
      if (albumKey !== previousAlbumKey) {
        const albumTracks = (this.tracksByAlbum.get(albumKey) ?? [track]).filter(
          (item) => !this.offlineOnly || item.cached,
        );
        items.push({
          kind: "album",
          key: `album:${albumKey}:${track.id}`,
          title: album?.title ?? track.album,
          artist: album?.album_artist ?? album?.artist ?? track.album_artist ?? track.artist,
          coverArtId: album?.cover_art_id ?? track.cover_art_id,
          durationSeconds:
            (!this.offlineOnly ? album?.duration_seconds : null) ??
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

  getVisibleAlbums() {
    return this.offlineOnly
      ? this.albums.filter(
          (album) =>
            album.track_ids.length > 0 &&
            album.track_ids.some((id) => this.cachedTrackIds.has(id)),
        )
      : this.albums;
  }

  /** Album cache state is derived exclusively from its individual track files. */
  /** @param {import('../types').AlbumData} album */
  isAlbumFullyCached(album) {
    return (
      album.track_ids.length > 0 &&
      album.track_ids.every((id) => this.cachedTrackIds.has(id))
    );
  }

  /** @param {import('../types').AlbumData} album */
  async selectAlbum(album) {
    const ids = new Set(album.track_ids);
    const first = this.tracks.find(
      (track) => ids.has(track.id) && (!this.offlineOnly || track.cached),
    );
    if (!first) return null;
    this.selectedTrackId = first.id;
    this.pendingTrackFocusId = first.id;
    await goto(resolve("/tracks"));
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
    return this.offlineOnly ? tracks.filter((track) => track.cached) : tracks;
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
    const starred = !this.starred.albums.some((item) => item.id === album.id);
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
