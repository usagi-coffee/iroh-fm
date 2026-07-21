package fm.iroh.android

import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.util.concurrent.Executors

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val prefetchExecutor = Executors.newSingleThreadExecutor()
    private val prefetchLock = Any()
    private var prefetchGeneration = 0L
    private var prefetchPlan: String? = null

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
        player.repeatMode = Player.REPEAT_MODE_ALL
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                scheduleNextPrefetch(player)
            }
        })
        session = MediaSession.Builder(this, player).build()
    }

    private fun scheduleNextPrefetch(player: Player) {
        val currentId = player.currentMediaItem?.mediaId
        val nextIndex = player.nextMediaItemIndex
        val nextId = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex).mediaId
        val clientHandle = NativeCore.activeClientHandle
        val remoteId = NativeCore.activeRemoteId
        if (
            currentId == null ||
            nextId == null ||
            nextId == currentId ||
            clientHandle == 0L ||
            remoteId.isBlank() ||
            NativeCore.offlineOnly
        ) {
            synchronized(prefetchLock) {
                prefetchGeneration++
                prefetchPlan = null
            }
            return
        }

        val plan = "$clientHandle:$remoteId:$currentId:$nextId"
        val generation = synchronized(prefetchLock) {
            if (prefetchPlan == plan) return
            prefetchPlan = plan
            ++prefetchGeneration
        }
        prefetchExecutor.execute {
            if (!isPrefetchCurrent(generation, clientHandle, remoteId)) return@execute
            if (
                NativeAudioCache.isOfflineCached(remoteId, nextId) ||
                NativeAudioCache.isMemoryCached(remoteId, nextId)
            ) return@execute
            runCatching {
                NativeAudioCache.prefetchTrack(clientHandle, remoteId, nextId) {
                    isPrefetchCurrent(generation, clientHandle, remoteId)
                }
            }.onFailure {
                Log.w(TAG, "Next-track RAM prefetch failed: mediaId=$nextId", it)
            }
        }
    }

    private fun isPrefetchCurrent(generation: Long, clientHandle: Long, remoteId: String): Boolean =
        synchronized(prefetchLock) {
            generation == prefetchGeneration &&
                NativeCore.activeClientHandle == clientHandle &&
                NativeCore.activeRemoteId == remoteId &&
                !NativeCore.offlineOnly
        }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        Log.d(TAG, "TWA task removed; stopping playback service")
        session?.player?.run {
            stop()
            clearMediaItems()
        }
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.d(TAG, "Playback service destroyed")
        synchronized(prefetchLock) {
            prefetchGeneration++
            prefetchPlan = null
        }
        prefetchExecutor.shutdownNow()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "iroh.fm.playback"
    }
}
