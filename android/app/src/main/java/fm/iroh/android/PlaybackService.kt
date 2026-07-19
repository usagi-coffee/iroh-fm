package fm.iroh.android

import android.net.Uri
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private lateinit var audioCache: SimpleCache
    private lateinit var cacheDataSource: CacheDataSource.Factory
    private val prefetchExecutor = Executors.newSingleThreadExecutor()
    private val prefetchLock = Any()
    private var prefetchWriter: CacheWriter? = null
    private var prefetchTrackId: String? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Playback service created")
        NativeCore.unwrap(NativeCore.initialize(applicationContext))
        audioCache = SimpleCache(
            File(cacheDir, "iroh-audio"),
            LeastRecentlyUsedCacheEvictor(AUDIO_CACHE_BYTES),
            StandaloneDatabaseProvider(this),
        )
        cacheDataSource = CacheDataSource.Factory()
            .setCache(audioCache)
            .setUpstreamDataSourceFactory(IrohDataSource.Factory())
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(cacheDataSource))
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
        val nextIndex = player.nextMediaItemIndex
        val nextItem = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex)
        val nextTrackId = nextItem?.mediaId
        val nextUri = nextItem?.localConfiguration?.uri
        if (nextTrackId == null || nextTrackId == player.currentMediaItem?.mediaId || nextUri == null) {
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
            cacheDataSource.createDataSourceForDownloading(),
            DataSpec.Builder().setUri(uri).build(),
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
        cancelPrefetch()
        prefetchExecutor.shutdownNow()
        runCatching { prefetchExecutor.awaitTermination(2, TimeUnit.SECONDS) }
        session?.run {
            player.release()
            release()
        }
        session = null
        if (::audioCache.isInitialized) audioCache.release()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "iroh.fm.playback"
        private const val AUDIO_CACHE_BYTES = 1024L * 1024L * 1024L
        private const val PREFETCH_BUFFER_BYTES = 128 * 1024
    }
}
