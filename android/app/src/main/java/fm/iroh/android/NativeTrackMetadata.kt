package fm.iroh.android

import org.json.JSONObject

/** Compact Android-side projection of the track library used by Media3 notifications. */
object NativeTrackMetadata {
    data class Track(
        val title: String,
        val artist: String,
        val album: String,
    )

    private val lock = Any()
    private val tracksByRemote = mutableMapOf<String, Map<String, Track>>()

    fun replaceFromListTracks(remoteId: String, response: Any) {
        val tracks = (response as? JSONObject)?.optJSONArray("Tracks") ?: return
        val indexed = buildMap {
            for (index in 0 until tracks.length()) {
                val track = tracks.optJSONObject(index) ?: continue
                val id = track.optString("id")
                if (id.isBlank()) continue
                put(
                    id,
                    Track(
                        title = track.optString("title"),
                        artist = track.optString("artist"),
                        album = track.optString("album"),
                    ),
                )
            }
        }
        synchronized(lock) { tracksByRemote[remoteId] = indexed }
    }

    fun get(remoteId: String, trackId: String): Track? = synchronized(lock) {
        tracksByRemote[remoteId]?.get(trackId)
    }
}
