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
    private var prefetchScheduleGeneration = 0
    private var waitingForTrackId: String? = null

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
        val generation = ++prefetchScheduleGeneration
        val currentTrackId = player.currentMediaItem?.mediaId
        val nextIndex = player.nextMediaItemIndex
        val nextItem = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex)
        val nextTrackId = nextItem?.mediaId
        val nextUri = nextItem?.localConfiguration?.uri
        if (
            NativeCore.offlineOnly ||
            currentTrackId == null ||
            nextTrackId == null ||
            nextTrackId == currentTrackId ||
            nextUri == null
        ) {
            waitingForTrackId = null
            cancelPrefetch()
            return
        }

        if (!NativeAudioCache.isPlaybackCached(NativeCore.activeRemoteId, currentTrackId)) {
            val activePrefetch = synchronized(prefetchLock) { prefetchTrackId }
            if (activePrefetch != null && activePrefetch != currentTrackId) cancelPrefetch()
            if (waitingForTrackId != currentTrackId) {
                waitingForTrackId = currentTrackId
                Log.d(TAG, "Waiting for current download before next-track prefetch: mediaId=$currentTrackId")
            }
            if (!player.playWhenReady) return
            prefetchHandler.postDelayed(
                {
                    if (prefetchScheduleGeneration == generation) scheduleNextPrefetch(player)
                },
                PREFETCH_READINESS_POLL_MS,
            )
            return
        }
        if (waitingForTrackId == currentTrackId) {
            Log.d(TAG, "Current download complete; next-track prefetch is eligible: mediaId=$currentTrackId")
        }
        waitingForTrackId = null

        if (NativeAudioCache.isOfflineCached(NativeCore.activeRemoteId, nextTrackId)) {
            cancelPrefetch()
            return
        }

        synchronized(prefetchLock) {
            if (prefetchTrackId == nextTrackId) return
            prefetchWriter?.cancel()
            prefetchWriter = null
            prefetchTrackId = nextTrackId
        }
        prefetchExecutor.execute { prefetch(nextTrackId, nextUri) }
    }

    private fun prefetch(trackId: String, uri: Uri) {
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
        Log.d(TAG, "Next-track prefetch started: mediaId=$trackId")
        try {
            writer.cache()
            Log.d(TAG, "Next-track prefetch complete: mediaId=$trackId")
        } catch (error: Exception) {
            if (synchronized(prefetchLock) { prefetchTrackId == trackId }) {
                Log.w(TAG, "Next-track prefetch failed: mediaId=$trackId", error)
            }
        } finally {
            synchronized(prefetchLock) {
                if (prefetchTrackId == trackId) {
                    prefetchWriter = null
                }
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
        prefetchScheduleGeneration += 1
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
        private const val PREFETCH_READINESS_POLL_MS = 500L
    }
}
