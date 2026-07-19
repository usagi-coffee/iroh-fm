package fm.iroh.android

import android.util.Log
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Playback service created")
        val dataSource = DefaultDataSource.Factory(this, IrohDataSource.Factory())
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
            .build()
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
            }
        })
        session = MediaSession.Builder(this, player).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        // Playback intentionally outlives the TWA task, like a conventional music player.
        Log.d(TAG, "TWA task removed; playback service retained")
    }

    override fun onDestroy() {
        Log.d(TAG, "Playback service destroyed")
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    companion object { private const val TAG = "iroh.fm.playback" }
}
