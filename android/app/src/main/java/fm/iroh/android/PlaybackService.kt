package fm.iroh.android

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val prefetchExecutor = Executors.newSingleThreadExecutor()
    private val prefetchHandler = Handler(Looper.getMainLooper())
    private val prefetchLock = Any()
    private var prefetchWriter: CacheWriter? = null
    private var prefetchTrackId: String? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Playback service created")
        NativeCore.unwrap(NativeCore.initialize(applicationContext))
        NativeAudioCache.initialize(this)
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(NativeAudioCache.playbackDataSourceFactory()))
            .build()
        player.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            true,
        )
        player.setHandleAudioBecomingNoisy(true)
        player.setWakeMode(C.WAKE_MODE_NETWORK)
        // The web player wraps to the start of its queue unless repeat-one is enabled.
        player.repeatMode = Player.REPEAT_MODE_ALL
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (
                    events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) ||
                    events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED) ||
                    events.contains(Player.EVENT_IS_LOADING_CHANGED) ||
                    events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)
                ) {
                    Log.d(
                        TAG,
                        "Playback state: mediaId=${player.currentMediaItem?.mediaId} " +
                            "state=${player.playbackState} playWhenReady=${player.playWhenReady} " +
                            "playing=${player.isPlaying} loading=${player.isLoading} " +
                            "bufferedMs=${player.bufferedPosition}",
                    )
                }
                if (
                    events.contains(Player.EVENT_TIMELINE_CHANGED) ||
                    events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                    events.contains(Player.EVENT_IS_PLAYING_CHANGED) ||
                    events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED) ||
                    events.contains(Player.EVENT_REPEAT_MODE_CHANGED) ||
                    events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED)
                ) {
                    scheduleNextPrefetch(player)
                }
            }
        })
        session = MediaSession.Builder(this, player).build()
    }

    /** Keeps one complete queue item ahead of the player without relying on the TWA process. */
    private fun scheduleNextPrefetch(player: Player) {
        val currentItem = player.currentMediaItem
        val currentTrackId = currentItem?.mediaId
        val currentUri = currentItem?.localConfiguration?.uri
        if (NativeCore.offlineOnly || currentTrackId == null || currentUri == null) {
            cancelPrefetch()
            return
        }

        if (!NativeAudioCache.isPlaybackCached(NativeCore.activeRemoteId, currentTrackId)) {
            val activePrefetch = synchronized(prefetchLock) { prefetchTrackId }
            if (activePrefetch == currentTrackId) return
            if (activePrefetch != null) cancelPrefetch()
            // Let Media3 establish playback first, then aggressively fill the rest of this file.
            if (!player.isPlaying) return
            startCacheFill(currentTrackId, currentUri, "Current-track download")
            return
        }

        val nextIndex = player.nextMediaItemIndex
        val nextItem = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex)
        val nextTrackId = nextItem?.mediaId
        val nextUri = nextItem?.localConfiguration?.uri
        if (
            nextTrackId == null ||
            nextTrackId == currentTrackId ||
            nextUri == null
        ) {
            cancelPrefetch()
            return
        }

        if (NativeAudioCache.isOfflineCached(NativeCore.activeRemoteId, nextTrackId)) {
            cancelPrefetch()
            return
        }

        startCacheFill(nextTrackId, nextUri, "Next-track prefetch")
    }

    private fun startCacheFill(trackId: String, uri: Uri, operation: String) {
        synchronized(prefetchLock) {
            if (prefetchTrackId == trackId) return
            prefetchWriter?.cancel()
            prefetchWriter = null
            prefetchTrackId = trackId
        }
        prefetchExecutor.execute { cacheTrack(trackId, uri, operation) }
    }

    private fun cacheTrack(trackId: String, uri: Uri, operation: String) {
        val writer = CacheWriter(
            NativeAudioCache.rollingDataSource(),
            DataSpec.Builder()
                .setUri(uri)
                .setKey(NativeAudioCache.cacheKey(NativeCore.activeRemoteId, trackId))
                .build(),
            ByteArray(PREFETCH_BUFFER_BYTES),
            CacheWriter.ProgressListener { requestLength, bytesCached, _ ->
                NativeTransferProgress.update(trackId, bytesCached, requestLength)
            },
        )
        synchronized(prefetchLock) {
            if (prefetchTrackId != trackId) return
            prefetchWriter = writer
        }
        Log.d(TAG, "$operation started: mediaId=$trackId")
        var completed = false
        try {
            writer.cache()
            completed = true
            Log.d(TAG, "$operation complete: mediaId=$trackId")
        } catch (error: Exception) {
            if (synchronized(prefetchLock) { prefetchTrackId == trackId }) {
                Log.w(TAG, "$operation failed: mediaId=$trackId", error)
            }
        } finally {
            synchronized(prefetchLock) {
                if (prefetchTrackId == trackId) {
                    prefetchWriter = null
                    if (!completed) prefetchTrackId = null
                }
            }
            if (completed) {
                prefetchHandler.post { session?.player?.let(::scheduleNextPrefetch) }
            }
        }
    }

    private fun cancelPrefetch() = synchronized(prefetchLock) {
        prefetchWriter?.cancel()
        prefetchWriter = null
        prefetchTrackId = null
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        // Playback intentionally outlives the TWA task, like a conventional music player.
        Log.d(TAG, "TWA task removed; playback service retained")
    }

    override fun onDestroy() {
        Log.d(TAG, "Playback service destroyed")
        prefetchHandler.removeCallbacksAndMessages(null)
        cancelPrefetch()
        prefetchExecutor.shutdownNow()
        runCatching { prefetchExecutor.awaitTermination(2, TimeUnit.SECONDS) }
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "iroh.fm.playback"
        private const val PREFETCH_BUFFER_BYTES = 128 * 1024
    }
}
