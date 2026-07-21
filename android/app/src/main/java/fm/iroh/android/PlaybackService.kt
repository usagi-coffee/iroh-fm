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
    private var activePrefetchStream = 0L

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
            override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
                scheduleQueuePrefetch(player)
            }
        })
        session = MediaSession.Builder(this, player).build()
    }

    private fun scheduleQueuePrefetch(player: Player) {
        val currentId = player.currentMediaItem?.mediaId
        val currentIndex = player.currentMediaItemIndex
        val nextIndex = if (currentIndex != C.INDEX_UNSET && player.mediaItemCount > 1) {
            (currentIndex + 1) % player.mediaItemCount
        } else {
            C.INDEX_UNSET
        }
        val nextId = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex).mediaId
        val trackIds = listOfNotNull(currentId, nextId).distinct()
        val clientHandle = NativeCore.activeClientHandle
        val remoteId = NativeCore.activeRemoteId
        if (
            currentId == null ||
            clientHandle == 0L ||
            remoteId.isBlank() ||
            NativeCore.offlineOnly
        ) {
            Log.d(
                TAG,
                "RAM LRU queue prefetch unavailable: currentId=$currentId nextId=$nextId " +
                    "clientConnected=${clientHandle != 0L} remoteKnown=${remoteId.isNotBlank()} " +
                    "offlineOnly=${NativeCore.offlineOnly}",
            )
            val streamToCancel = synchronized(prefetchLock) {
                prefetchGeneration++
                prefetchPlan = null
                activePrefetchStream.also { activePrefetchStream = 0L }
            }
            if (streamToCancel != 0L) {
                Log.d(TAG, "Cancelling active RAM LRU prefetch stream: handle=$streamToCancel")
                NativeCore.closeStream(streamToCancel)
            }
            return
        }

        val plan = "$clientHandle:$remoteId:${trackIds.joinToString(":")}"
        var streamToCancel = 0L
        val generation = synchronized(prefetchLock) {
            if (prefetchPlan == plan) {
                Log.d(TAG, "RAM LRU queue prefetch plan unchanged: tracks=$trackIds")
                return
            }
            streamToCancel = activePrefetchStream
            activePrefetchStream = 0L
            prefetchPlan = plan
            ++prefetchGeneration
        }
        Log.d(
            TAG,
            "RAM LRU queue prefetch scheduled: generation=$generation tracks=$trackIds",
        )
        if (streamToCancel != 0L) {
            Log.d(TAG, "Cancelling superseded RAM LRU prefetch stream: handle=$streamToCancel")
            NativeCore.closeStream(streamToCancel)
        }
        prefetchExecutor.execute {
            if (!isPrefetchCurrent(generation, clientHandle, remoteId)) {
                Log.d(TAG, "RAM LRU queue prefetch skipped; stale plan: generation=$generation")
                return@execute
            }
            for ((index, trackId) in trackIds.withIndex()) {
                if (!isPrefetchCurrent(generation, clientHandle, remoteId)) {
                    Log.d(
                        TAG,
                        "RAM LRU queue prefetch stopped; stale plan: generation=$generation trackId=$trackId",
                    )
                    break
                }
                val role = if (index == 0) "selected" else "next"
                if (NativeAudioCache.isOfflineCached(remoteId, trackId)) {
                    Log.d(TAG, "RAM LRU prefetch skipped; $role track is cached on disk: trackId=$trackId")
                    continue
                }
                if (NativeAudioCache.isMemoryCached(remoteId, trackId)) {
                    Log.d(TAG, "RAM LRU prefetch skipped; $role track is already in RAM: trackId=$trackId")
                    continue
                }
                var openedStream = 0L
                runCatching {
                    NativeAudioCache.prefetchTrack(
                        clientHandle,
                        remoteId,
                        trackId,
                        shouldContinue = {
                            isPrefetchCurrent(generation, clientHandle, remoteId)
                        },
                        onStreamOpened = { streamHandle ->
                            openedStream = streamHandle
                            val stale = synchronized(prefetchLock) {
                                if (generation == prefetchGeneration) {
                                    activePrefetchStream = streamHandle
                                    false
                                } else {
                                    true
                                }
                            }
                            if (stale) NativeCore.closeStream(streamHandle)
                        },
                    ).also { cached ->
                        Log.d(
                            TAG,
                            "RAM LRU prefetch result: generation=$generation role=$role " +
                                "trackId=$trackId cached=$cached",
                        )
                    }
                }.onFailure {
                    Log.w(TAG, "RAM LRU $role-track prefetch failed: mediaId=$trackId", it)
                }
                synchronized(prefetchLock) {
                    if (activePrefetchStream == openedStream) activePrefetchStream = 0L
                }
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
        val streamToCancel = synchronized(prefetchLock) {
            prefetchGeneration++
            prefetchPlan = null
            activePrefetchStream.also { activePrefetchStream = 0L }
        }
        if (streamToCancel != 0L) NativeCore.closeStream(streamToCancel)
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
