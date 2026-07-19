package fm.iroh.android

import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.*
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import androidx.core.content.ContextCompat.getMainExecutor
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val worker = Executors.newFixedThreadPool(4)
    private lateinit var launchUri: Uri
    private lateinit var origin: Uri
    private var customTabsClient: CustomTabsClient? = null
    private var session: CustomTabsSession? = null
    private var channelReady = false
    private var relationshipValidated = false
    private var messageChannelReady = false
    private var readyDispatched = false
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null

    private val callback = object : CustomTabsCallback() {
        override fun onRelationshipValidationResult(
            relation: Int,
            requestedOrigin: Uri,
            result: Boolean,
            extras: Bundle?,
        ) {
            Log.d(TAG, "Relationship result: $result")
            relationshipValidated = result
            dispatchReadyIfNeeded()
        }

        override fun onNavigationEvent(event: Int, extras: Bundle?) {
            if (event != NAVIGATION_FINISHED) return
            readyDispatched = false
            channelReady = false
            messageChannelReady = false
            val delay = if (relationshipValidated) 200L else 1_000L
            if (!relationshipValidated)
                Log.d(TAG, "Scheduling postMessage after cold-start validation delay")
            Handler(Looper.getMainLooper()).postDelayed({
                val requested = session?.requestPostMessageChannel(origin, origin, Bundle()) ?: false
                Log.d(TAG, "Requested postMessage channel: $requested")
            }, delay)
        }

        override fun onMessageChannelReady(extras: Bundle?) {
            Log.d(TAG, "Message channel ready")
            messageChannelReady = true
            dispatchReadyIfNeeded()
        }

        override fun onPostMessage(message: String, extras: Bundle?) {
            handleMessage(message)
        }
    }

    private fun dispatchReadyIfNeeded() {
        if (!relationshipValidated || !messageChannelReady || readyDispatched) return
        readyDispatched = true
        channelReady = true
        send(JSONObject().put("module", "native").put("event", "ready").put("state", playerState()))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launchUri = Uri.parse(BuildConfig.LAUNCH_URL)
            .buildUpon()
            .appendQueryParameter("iroh-native", "1")
            .build()
        origin = Uri.parse(BuildConfig.WEB_ORIGIN)
        connectPlaybackController()
        bindTwa()
    }

    override fun onResume() {
        super.onResume()
        if (channelReady) send(JSONObject().put("module", "native").put("event", "state").put("state", playerState()))
    }

    override fun onDestroy() {
        controllerFuture?.let(MediaController::releaseFuture)
        worker.shutdown()
        super.onDestroy()
    }

    private fun bindTwa() {
        val browser = CustomTabsClient.getPackageName(this, null) ?: return
        CustomTabsClient.bindCustomTabsService(this, browser, object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                customTabsClient = client
                client.warmup(0)
                session = client.newSession(callback)
                TrustedWebActivityIntentBuilder(launchUri).build(session!!).launchTrustedWebActivity(this@MainActivity)
            }
            override fun onServiceDisconnected(name: ComponentName) { customTabsClient = null }
        })
    }

    private fun connectPlaybackController() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync().also { future ->
            future.addListener({
                controller = future.get().also { player ->
                    player.addListener(object : Player.Listener {
                        override fun onEvents(player: Player, events: Player.Events) {
                            send(JSONObject().put("module", "native").put("event", "state").put("state", playerState()))
                        }
                    })
                }
            }, getMainExecutor(this))
        }
    }

    private fun handleMessage(raw: String) {
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        if (message.optString("module") != "native") return
        val id = message.optString("id")
        val action = message.optString("action")
        val payload = message.optJSONObject("payload") ?: JSONObject()
        val background = action in setOf("connect", "request", "connectionInfo", "identity", "endpointId", "parseTicket", "close")
        val task = Runnable {
            runCatching { execute(action, payload) }
                .onSuccess { reply(id, it) }
                .onFailure { replyError(id, it.message ?: "native operation failed") }
        }
        if (background) worker.execute(task) else runOnUiThread(task)
    }

    private fun execute(action: String, payload: JSONObject): Any = when (action) {
        "connect" -> JSONObject(NativeCore.unwrap(NativeCore.connect(payload.toString()))).also {
            NativeCore.activeClientHandle = it.getLong("handle")
        }
        "request" -> JSONTokener(NativeCore.unwrap(NativeCore.request(payload.getLong("handle"), encodeJson(payload.get("request"))))).nextValue()
        "connectionInfo" -> JSONObject(NativeCore.unwrap(NativeCore.connectionInfo(payload.getLong("handle"))))
        "identity" -> JSONObject(NativeCore.unwrap(NativeCore.generateIdentity()))
        "endpointId" -> NativeCore.unwrap(NativeCore.endpointIdForSecret(payload.getString("secret")))
        "parseTicket" -> JSONObject(NativeCore.unwrap(NativeCore.parseTicket(payload.getString("ticket"))))
        "close" -> { NativeCore.closeClient(payload.getLong("handle")); JSONObject() }
        "play" -> play(payload)
        "playerCommand" -> playerCommand(payload)
        "playerState" -> playerState()
        else -> error("unsupported native action: $action")
    }

    private fun play(payload: JSONObject): JSONObject {
        val player = controller ?: error("native player is starting")
        val queue = payload.getJSONArray("queue")
        val items = (0 until queue.length()).map { index ->
            val track = queue.getJSONObject(index)
            MediaItem.Builder()
                .setMediaId(track.getString("id"))
                .setUri("iroh-fm://track/${Uri.encode(track.getString("id"))}")
                .setMediaMetadata(MediaMetadata.Builder()
                    .setTitle(track.optString("title"))
                    .setArtist(track.optString("artist"))
                    .setAlbumTitle(track.optString("album"))
                    .build())
                .build()
        }
        val selected = items.indexOfFirst { it.mediaId == payload.getString("trackId") }.coerceAtLeast(0)
        player.setMediaItems(items, selected, 0)
        player.prepare()
        player.play()
        return playerState()
    }

    private fun playerCommand(payload: JSONObject): JSONObject {
        val player = controller ?: error("native player is starting")
        when (payload.getString("command")) {
            "toggle" -> if (player.isPlaying) player.pause() else player.play()
            "next" -> player.seekToNextMediaItem()
            "previous" -> player.seekToPreviousMediaItem()
            "seek" -> player.seekTo((payload.getDouble("seconds") * 1000).toLong())
            "volume" -> player.volume = payload.getDouble("value").toFloat()
            "repeat" -> player.repeatMode = if (payload.getBoolean("enabled")) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            "shuffle" -> player.shuffleModeEnabled = payload.getBoolean("enabled")
            "stop" -> { player.stop(); player.clearMediaItems() }
        }
        return playerState()
    }

    private fun playerState(): JSONObject {
        val player = controller
        return JSONObject()
            .put("trackId", player?.currentMediaItem?.mediaId ?: JSONObject.NULL)
            .put("playing", player?.isPlaying == true)
            .put("loading", player?.playbackState == Player.STATE_BUFFERING)
            .put("position", (player?.currentPosition ?: 0L) / 1000.0)
            .put("duration", (player?.duration ?: 0L).coerceAtLeast(0L) / 1000.0)
            .put("repeat", player?.repeatMode == Player.REPEAT_MODE_ONE)
            .put("shuffle", player?.shuffleModeEnabled == true)
            .put("volume", player?.volume ?: 0.5f)
    }

    private fun reply(id: String, result: Any) = send(JSONObject().put("module", "native").put("id", id).put("result", result))
    private fun replyError(id: String, error: String) = send(JSONObject().put("module", "native").put("id", id).put("error", error))
    private fun send(message: JSONObject) {
        if (channelReady) session?.postMessage(message.toString(), null)
    }

    private fun encodeJson(value: Any): String = if (value is String) JSONObject.quote(value) else value.toString()

    companion object { private const val TAG = "iroh.fm" }
}
