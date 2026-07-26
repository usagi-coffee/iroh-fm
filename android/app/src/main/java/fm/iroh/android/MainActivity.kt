package fm.iroh.android

import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
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
import org.json.JSONArray
import org.json.JSONTokener
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
    private data class IncomingRequestTransfer(
        val parts: Array<String?>,
        var received: Int = 0,
        var chars: Int = 0,
    )

    private val worker = Executors.newFixedThreadPool(4)
    private lateinit var launchUri: Uri
    private lateinit var origin: Uri
    private val mainHandler = Handler(Looper.getMainLooper())
    private var customTabsClient: CustomTabsClient? = null
    private var session: CustomTabsSession? = null
    private var channelReady = false
    private var twaRelationshipValidated = false
    private var postMessageRelationshipValidated = false
    private var messageChannelReady = false
    private var readyDispatched = false
    private var navigationGeneration = 0
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val sendLock = Any()
    private var transferSequence = 0L
    private val incomingRequestTransfers = mutableMapOf<String, IncomingRequestTransfer>()
    private val transferStatePending = AtomicBoolean(false)
    private val memoryCacheStatePending = AtomicBoolean(false)
    private val pendingMemoryCacheTrackIds = mutableSetOf<String>()
    private val transferStateListener: () -> Unit = {
        if (transferStatePending.compareAndSet(false, true)) {
            mainHandler.post {
                transferStatePending.set(false)
                if (channelReady)
                    send(JSONObject().put("module", "native").put("event", "state").put("state", playerState()))
            }
        }
    }
    private val memoryCacheListener: (String, String) -> Unit = { remoteId, trackId ->
        if (remoteId == NativeCore.activeRemoteId) {
            synchronized(pendingMemoryCacheTrackIds) {
                pendingMemoryCacheTrackIds += trackId
            }
            if (memoryCacheStatePending.compareAndSet(false, true)) {
                mainHandler.post(::dispatchMemoryCacheState)
            }
        }
    }

    private fun dispatchMemoryCacheState() {
        val changedTrackIds = synchronized(pendingMemoryCacheTrackIds) {
            val changed = pendingMemoryCacheTrackIds.toSet()
            pendingMemoryCacheTrackIds.clear()
            changed
        }
        if (channelReady && changedTrackIds.isNotEmpty()) {
            send(
                JSONObject()
                    .put("module", "native")
                    .put("event", "state")
                    .put("state", playerState(memoryCacheTrackIds = changedTrackIds)),
            )
        }
        memoryCacheStatePending.set(false)
        val morePending = synchronized(pendingMemoryCacheTrackIds) {
            pendingMemoryCacheTrackIds.isNotEmpty()
        }
        if (morePending && memoryCacheStatePending.compareAndSet(false, true))
            mainHandler.post(::dispatchMemoryCacheState)
    }

    private val callback = object : CustomTabsCallback() {
        override fun onRelationshipValidationResult(
            relation: Int,
            requestedOrigin: Uri,
            result: Boolean,
            extras: Bundle?,
        ) {
            val relationName = when (relation) {
                CustomTabsService.RELATION_USE_AS_ORIGIN -> "use_as_origin"
                CustomTabsService.RELATION_HANDLE_ALL_URLS -> "handle_all_urls"
                else -> "unknown"
            }
            Log.d(TAG, "Relationship result: relation=$relationName($relation) origin=$requestedOrigin result=$result")
            when (relation) {
                CustomTabsService.RELATION_USE_AS_ORIGIN -> {
                    postMessageRelationshipValidated = result
                }
                CustomTabsService.RELATION_HANDLE_ALL_URLS -> twaRelationshipValidated = result
            }
            dispatchReadyIfNeeded()
        }

        override fun onNavigationEvent(event: Int, extras: Bundle?) {
            if (event != NAVIGATION_FINISHED) return
            closeActiveClient("navigation finished")
            readyDispatched = false
            channelReady = false
            messageChannelReady = false
            postMessageRelationshipValidated = false
            val generation = ++navigationGeneration
            session?.validateRelationship(
                CustomTabsService.RELATION_USE_AS_ORIGIN,
                origin,
                Bundle(),
            )
            val delay = if (twaRelationshipValidated) 200L else 1_000L
            if (!twaRelationshipValidated)
                Log.d(TAG, "Scheduling postMessage after cold-start validation delay")
            mainHandler.postDelayed({ requestPostMessageChannel(generation, 1) }, delay)
        }

        override fun onMessageChannelReady(extras: Bundle?) {
            Log.d(TAG, "Message channel ready")
            messageChannelReady = true
            dispatchReadyIfNeeded()
        }

        override fun onPostMessage(message: String, extras: Bundle?) {
            Log.d(
                TAG,
                "Custom Tabs postMessage callback: chars=${message.length} channelReady=$channelReady",
            )
            handleMessage(message)
        }
    }

    private fun dispatchReadyIfNeeded() {
        if (
            !postMessageRelationshipValidated ||
            !messageChannelReady ||
            readyDispatched
        ) return
        channelReady = true
        val result = send(JSONObject().put("module", "native").put("event", "ready").put("state", playerState(includeQueue = true)))
        readyDispatched = result == CustomTabsService.RESULT_SUCCESS
        Log.d(TAG, "Native bridge ready dispatched: result=$result")
        if (!readyDispatched) channelReady = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        NativeCore.unwrap(NativeCore.initialize(applicationContext))
        NativeAudioCache.initialize(applicationContext)
        NativeAudioCache.addMemoryCacheListener(memoryCacheListener)
        NativeTransferProgress.addListener(transferStateListener)
        Log.d(TAG, "Native Android context initialized")
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
        Log.d(TAG, "Bridge activity resumed: channelReady=$channelReady")
        if (channelReady)
            send(JSONObject().put("module", "native").put("event", "state").put("state", playerState(includeQueue = true)))
    }

    override fun onDestroy() {
        Log.d(
            TAG,
            "Launcher activity destroyed; retaining bridge for active TWA: " +
                "channelReady=$channelReady messageChannelReady=$messageChannelReady",
        )
        // The launcher Activity normally dies while its Trusted Web Activity remains open.
        // The Custom Tabs session still owns this callback and continues delivering RPCs,
        // so bridge resources must live until Android terminates the application process.
        super.onDestroy()
    }

    private fun bindTwa() {
        val browser = CustomTabsClient.getPackageName(
            this,
            CHROMIUM_CUSTOM_TABS_PACKAGES,
            true,
        )
        if (browser == null) {
            Log.e(TAG, "No supported Chromium Custom Tabs provider is installed")
            Toast.makeText(
                this,
                "Install Chrome or another Chromium-based browser to run iroh.fm.",
                Toast.LENGTH_LONG,
            ).show()
            finish()
            return
        }
        Log.d(TAG, "Binding Custom Tabs provider: $browser")
        CustomTabsClient.bindCustomTabsService(this, browser, object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                Log.d(TAG, "Custom Tabs service connected: ${name.packageName}/${name.className}")
                customTabsClient = client
                client.warmup(0)
                session = client.newSession(callback)
                val validationRequested = session?.validateRelationship(
                    CustomTabsService.RELATION_USE_AS_ORIGIN,
                    origin,
                    Bundle(),
                ) ?: false
                Log.d(TAG, "Requested use_as_origin validation: $validationRequested")
                TrustedWebActivityIntentBuilder(launchUri).build(session!!).launchTrustedWebActivity(this@MainActivity)
            }
            override fun onServiceDisconnected(name: ComponentName) { customTabsClient = null }
        })
    }

    private fun requestPostMessageChannel(generation: Int, attempt: Int) {
        if (generation != navigationGeneration || messageChannelReady) return
        val requested = session?.requestPostMessageChannel(origin) ?: false
        Log.d(TAG, "Requested postMessage channel: accepted=$requested attempt=$attempt")
        if (!messageChannelReady && !requested && attempt < POST_MESSAGE_ATTEMPTS) {
            mainHandler.postDelayed(
                { requestPostMessageChannel(generation, attempt + 1) },
                POST_MESSAGE_RETRY_DELAY_MS,
            )
        }
    }

    private fun connectPlaybackController() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync().also { future ->
            future.addListener({
                val connected = runCatching(future::get).getOrElse {
                    Log.w(TAG, "Playback controller failed to connect", it)
                    return@addListener
                }
                controller = connected.also { player ->
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
        val message = runCatching { JSONObject(raw) }.getOrElse {
            Log.w(TAG, "Dropping malformed Custom Tabs postMessage: chars=${raw.length}", it)
            return
        }
        if (message.optString("module") != "native") {
            Log.d(TAG, "Ignoring non-native Custom Tabs postMessage")
            return
        }
        if (message.optString("event") == "requestChunk") {
            receiveRequestChunk(message)
            return
        }
        val id = message.optString("id")
        val action = message.optString("action")
        val logRequest = action != "cacheProgress"
        if (logRequest) Log.d(TAG, "Native request received: action=$action id=$id")
        val payload = message.optJSONObject("payload") ?: JSONObject()
        val background = action in setOf(
            "connect",
            "request",
            "coverArt",
            "connectionInfo",
            "identity",
            "endpointId",
            "parseTicket",
            "close",
            "prefetchTrack",
            "cacheTrack",
            "cachedTrackIds",
            "cacheStats",
            "clearCache",
            "setMemoryCacheSize",
        )
        val task = Runnable {
            val startedAt = SystemClock.elapsedRealtime()
            runCatching { execute(action, payload) }
                .onSuccess {
                    val replyResult = reply(id, it)
                    if (logRequest) {
                        Log.d(
                            TAG,
                            "Native request completed: action=$action id=$id " +
                                "durationMs=${SystemClock.elapsedRealtime() - startedAt} replyResult=$replyResult",
                        )
                    }
                }
                .onFailure {
                    val error = it.message ?: "native operation failed"
                    val replyResult = replyError(id, error)
                    Log.e(
                        TAG,
                        "Native request failed: action=$action id=$id " +
                            "durationMs=${SystemClock.elapsedRealtime() - startedAt} " +
                            "replyResult=$replyResult error=$error",
                    )
                }
        }
        if (background) {
            worker.execute(task)
        } else {
            mainHandler.post(task)
        }
    }

    private fun receiveRequestChunk(message: JSONObject) {
        val transferId = message.optString("transferId")
        val index = message.optInt("index", -1)
        val total = message.optInt("total", -1)
        val data = message.optString("data", null) ?: return
        if (
            transferId.isBlank() ||
            total !in 1..MAX_REQUEST_CHUNKS ||
            index !in 0 until total
        ) return
        val transfer = incomingRequestTransfers.getOrPut(transferId) {
            mainHandler.postDelayed(
                { incomingRequestTransfers.remove(transferId) },
                REQUEST_TRANSFER_TIMEOUT_MS,
            )
            IncomingRequestTransfer(arrayOfNulls(total))
        }
        if (transfer.parts.size != total || transfer.parts[index] != null) return
        transfer.parts[index] = data
        transfer.received += 1
        transfer.chars += data.length
        if (transfer.chars > MAX_REQUEST_CHARS) {
            incomingRequestTransfers.remove(transferId)
            return
        }
        if (transfer.received != total) return
        incomingRequestTransfers.remove(transferId)
        val reassembled = transfer.parts.joinToString("") { it ?: "" }
        Log.d(TAG, "Reassembled native request: transfer=$transferId chars=${reassembled.length} chunks=$total")
        handleMessage(reassembled)
    }

    private fun execute(action: String, payload: JSONObject): Any = when (action) {
        "buildInfo" -> JSONObject()
            .put("platform", "Android")
            .put("commit", BuildConfig.BUILD_COMMIT)
            .put("epoch", BuildConfig.EPOCH)
            .put("epochCommit", BuildConfig.EPOCH_COMMIT)
        "connect" -> {
            closeActiveClient("superseded by new connection")
            JSONObject(NativeCore.unwrap(NativeCore.connect(payload.toString()))).also {
                NativeCore.activeClientHandle = it.getLong("handle")
                NativeCore.activeRemoteId = it.getString("remoteId")
                NativeCore.offlineOnly = false
                it.put("compactQueue", true)
                it.put("requestChunks", true)
            }
        }
        "request" -> executeBackendRequest(payload)
        "coverArt" -> JSONObject(
            NativeCore.unwrap(
                NativeCore.coverArt(
                    payload.getLong("handle"),
                    payload.getString("coverArtId"),
                    payload.optBoolean("fullQuality", false),
                ),
            ),
        )
        "connectionInfo" -> JSONObject(NativeCore.unwrap(NativeCore.connectionInfo(payload.getLong("handle"))))
        "identity" -> JSONObject(NativeCore.unwrap(NativeCore.generateIdentity()))
        "endpointId" -> NativeCore.unwrap(NativeCore.endpointIdForSecret(payload.getString("secret")))
        "parseTicket" -> JSONObject(NativeCore.unwrap(NativeCore.parseTicket(payload.getString("ticket"))))
        "close" -> {
            val handle = payload.getLong("handle")
            if (NativeCore.activeClientHandle == handle) closeActiveClient("web request")
            else NativeCore.closeClient(handle)
            JSONObject()
        }
        "cachedTrackIds" -> JSONArray(
            NativeAudioCache.cachedTrackIds(payload.getString("remoteId")).toList(),
        )
        "prefetchTrack" -> {
            check(payload.getLong("handle") == NativeCore.activeClientHandle) {
                "native client is no longer active"
            }
            check(payload.getString("remoteId") == NativeCore.activeRemoteId) {
                "native server changed while caching track"
            }
            JSONObject().put(
                "cached",
                NativeAudioCache.prefetchTrack(
                    payload.getLong("handle"),
                    payload.getString("remoteId"),
                    payload.getString("trackId"),
                ),
            )
        }
        "cacheTrack" -> {
            check(payload.getLong("handle") == NativeCore.activeClientHandle) {
                "native client is no longer active"
            }
            check(payload.getString("remoteId") == NativeCore.activeRemoteId) {
                "native server changed while caching track"
            }
            JSONObject().put(
                "cached",
                NativeAudioCache.cacheTrack(
                    payload.getString("remoteId"),
                    payload.getString("trackId"),
                ),
            )
        }
        "cacheProgress" -> NativeTransferProgress.snapshot(payload.getString("trackId"))?.let {
            JSONObject()
                .put("received", it.receivedBytes)
                .put("total", it.totalBytes)
                .put("active", it.active)
        } ?: JSONObject().put("received", 0).put("total", 0).put("active", false)
        "cacheStats" -> NativeAudioCache.offlineStats().let {
            JSONObject()
                .put("tracks", JSONObject().put("count", it.count).put("size", it.size))
                .put("covers", JSONObject().put("count", 0).put("size", 0))
        }
        "clearCache" -> {
            when (val kind = payload.getString("kind")) {
                "tracks" -> NativeAudioCache.clearOfflineTracks()
                "covers" -> Unit
                else -> error("unknown offline cache kind: $kind")
            }
            JSONObject()
        }
        "setMemoryCacheSize" -> {
            NativeAudioCache.resizeMemoryCache(payload.getLong("bytes"))
            JSONObject()
        }
        "setOfflineOnly" -> setOfflineOnly(payload.getBoolean("enabled"))
        "play" -> play(payload)
        "playerCommand" -> playerCommand(payload)
        "playerState" -> playerState(payload.optBoolean("includeQueue", false))
        else -> error("unsupported native action: $action")
    }

    private fun closeActiveClient(reason: String) {
        val handle = NativeCore.activeClientHandle
        if (handle == 0L) return
        Log.d(TAG, "Closing active native client: reason=$reason handle=$handle")
        NativeCore.closeClient(handle)
        NativeCore.activeClientHandle = 0L
        NativeCore.activeRemoteId = ""
        NativeCore.offlineOnly = false
    }

    private fun executeBackendRequest(payload: JSONObject): Any {
        val request = payload.get("request")
        val response = JSONTokener(
            NativeCore.unwrap(
                NativeCore.request(payload.getLong("handle"), encodeJson(request)),
            ),
        ).nextValue()
        if (request == "ListTracks") {
            NativeTrackMetadata.replaceFromListTracks(NativeCore.activeRemoteId, response)
            Log.d(TAG, "Native track metadata indexed for Media3")
        }
        return response
    }

    private fun play(payload: JSONObject): JSONObject {
        val player = controller ?: error("native player is starting")
        val selectedTrackId = payload.getString("trackId")
        if (NativeCore.offlineOnly) {
            check(NativeAudioCache.isPlaybackCached(NativeCore.activeRemoteId, selectedTrackId)) {
                "track is not available in the Android offline cache"
            }
        }
        val queue = payload.optJSONArray("queue")
        if (queue == null) {
            val selected = (0 until player.mediaItemCount)
                .firstOrNull { player.getMediaItemAt(it).mediaId == selectedTrackId }
                ?: error("native queue is not available")
            player.seekTo(selected, 0L)
            player.prepare()
            player.play()
            return playerState()
        }
        val items = (0 until queue.length())
            .map { index ->
                val embedded = queue.optJSONObject(index)
                val trackId = embedded?.optString("id") ?: queue.getString(index)
                val metadata = NativeTrackMetadata.get(NativeCore.activeRemoteId, trackId)
                MediaItem.Builder()
                    .setMediaId(trackId)
                    .setUri("iroh-fm://track/${Uri.encode(trackId)}")
                    .setCustomCacheKey(
                        NativeAudioCache.cacheKey(NativeCore.activeRemoteId, trackId),
                    )
                    .setMediaMetadata(MediaMetadata.Builder()
                        .setTitle(metadata?.title ?: embedded?.optString("title") ?: trackId)
                        .setArtist(metadata?.artist ?: embedded?.optString("artist") ?: "")
                        .setAlbumTitle(metadata?.album ?: embedded?.optString("album") ?: "")
                        .build())
                    .build()
            }
            .filter {
                !NativeCore.offlineOnly ||
                    NativeAudioCache.isPlaybackCached(NativeCore.activeRemoteId, it.mediaId)
            }
        val selected = items.indexOfFirst { it.mediaId == selectedTrackId }.coerceAtLeast(0)
        player.setMediaItems(items, selected, 0)
        player.prepare()
        player.play()
        return playerState()
    }

    private fun setOfflineOnly(enabled: Boolean): JSONObject {
        NativeCore.offlineOnly = enabled
        if (!enabled) return playerState()
        val player = controller ?: return playerState()
        val currentTrackId = player.currentMediaItem?.mediaId
        val retained = (0 until player.mediaItemCount)
            .map(player::getMediaItemAt)
            .filter {
                NativeAudioCache.isPlaybackCached(NativeCore.activeRemoteId, it.mediaId)
            }
        val selected = retained.indexOfFirst { it.mediaId == currentTrackId }
        if (selected < 0) {
            player.stop()
            player.clearMediaItems()
            return playerState()
        }
        val position = player.currentPosition.coerceAtLeast(0L)
        val playWhenReady = player.playWhenReady
        player.setMediaItems(retained, selected, position)
        player.prepare()
        if (playWhenReady) player.play()
        Log.d(TAG, "Offline mode retained ${retained.size} downloaded queue items")
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
            "repeat" -> player.repeatMode =
                if (payload.getBoolean("enabled")) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
            "shuffle" -> player.shuffleModeEnabled = payload.getBoolean("enabled")
            "stop" -> { player.stop(); player.clearMediaItems() }
        }
        return playerState()
    }

    private fun playerState(
        includeQueue: Boolean = false,
        memoryCacheTrackIds: Set<String> = emptySet(),
    ): JSONObject {
        val player = controller
        val trackId = player?.currentMediaItem?.mediaId
        val transfer = NativeTransferProgress.snapshot(trackId)
        val queue = JSONArray()
        val transfers = JSONObject()
        if (player != null) {
            for (index in 0 until player.mediaItemCount) {
                val id = player.getMediaItemAt(index).mediaId
                if (includeQueue) queue.put(id)
                val snapshot = NativeTransferProgress.snapshot(id)
                val memoryCached = NativeAudioCache.isMemoryCached(NativeCore.activeRemoteId, id)
                val cached =
                    (includeQueue || snapshot != null || memoryCached) &&
                        NativeAudioCache.isOfflineCached(NativeCore.activeRemoteId, id)
                if (includeQueue || snapshot != null || cached || memoryCached || id in memoryCacheTrackIds) {
                    transfers.put(
                        id,
                        JSONObject()
                            .put("received", snapshot?.receivedBytes ?: 0L)
                            .put("total", snapshot?.totalBytes ?: 0L)
                            .put("active", snapshot?.active == true && !cached && !memoryCached)
                            .put("cached", cached)
                            .put("memoryCached", memoryCached),
                    )
                }
            }
        }
        for (id in memoryCacheTrackIds) {
            if (transfers.has(id)) continue
            val snapshot = NativeTransferProgress.snapshot(id)
            transfers.put(
                id,
                JSONObject()
                    .put("received", snapshot?.receivedBytes ?: 0L)
                    .put("total", snapshot?.totalBytes ?: 0L)
                    .put("active", false)
                    .put("cached", NativeAudioCache.isOfflineCached(NativeCore.activeRemoteId, id))
                    .put("memoryCached", NativeAudioCache.isMemoryCached(NativeCore.activeRemoteId, id)),
            )
        }
        return JSONObject()
            .put("timestamp", System.currentTimeMillis())
            .put("trackId", trackId ?: JSONObject.NULL)
            .put("currentIndex", player?.currentMediaItemIndex ?: 0)
            .put("playing", player?.isPlaying == true)
            .put("loading", player?.playbackState == Player.STATE_BUFFERING)
            .put("transferring", transfer?.active == true)
            .put("position", (player?.currentPosition ?: 0L) / 1000.0)
            .put("bufferedPosition", (player?.bufferedPosition ?: 0L) / 1000.0)
            .put("duration", (player?.duration ?: 0L).coerceAtLeast(0L) / 1000.0)
            .put("transferReceived", transfer?.receivedBytes ?: 0L)
            .put("transferTotal", transfer?.totalBytes ?: 0L)
            .put("transfers", transfers)
            .put("repeat", player?.repeatMode == Player.REPEAT_MODE_ONE)
            .put("shuffle", player?.shuffleModeEnabled == true)
            .put("volume", player?.volume ?: 0.5f)
            .also {
                if (includeQueue) {
                    it.put("queue", queue)
                }
            }
    }

    private fun reply(id: String, result: Any) = send(JSONObject().put("module", "native").put("id", id).put("result", result))
    private fun replyError(id: String, error: String) = send(JSONObject().put("module", "native").put("id", id).put("error", error))
    private fun send(message: JSONObject): Int? {
        val description = when {
            message.has("id") -> "reply id=${message.optString("id")}"
            message.has("event") -> "event=${message.optString("event")}"
            else -> "message"
        }
        val raw = message.toString()
        synchronized(sendLock) {
            if (!channelReady) {
                Log.w(TAG, "Cannot send native $description: postMessage channel is not ready")
                return null
            }
            val activeSession = session ?: run {
                Log.w(TAG, "Cannot send native $description: Custom Tabs session is missing")
                return null
            }
            if (raw.length <= POST_MESSAGE_CHUNK_CHARS) {
                val result = activeSession.postMessage(raw, null)
                if (result != CustomTabsService.RESULT_SUCCESS)
                    Log.w(TAG, "Native $description postMessage failed: result=$result")
                return result
            }

            val transferId = "${SystemClock.elapsedRealtimeNanos()}-${++transferSequence}"
            val total = (raw.length + POST_MESSAGE_CHUNK_CHARS - 1) / POST_MESSAGE_CHUNK_CHARS
            Log.d(TAG, "Sending chunked native message: transfer=$transferId chars=${raw.length} chunks=$total")
            for (index in 0 until total) {
                val start = index * POST_MESSAGE_CHUNK_CHARS
                val chunk = JSONObject()
                    .put("module", "native")
                    .put("event", "chunk")
                    .put("transferId", transferId)
                    .put("index", index)
                    .put("total", total)
                    .put("data", raw.substring(start, minOf(start + POST_MESSAGE_CHUNK_CHARS, raw.length)))
                val result = activeSession.postMessage(chunk.toString(), null)
                if (result != CustomTabsService.RESULT_SUCCESS) {
                    Log.e(TAG, "Native message chunk failed: transfer=$transferId index=$index/$total result=$result")
                    return result
                }
            }
            return CustomTabsService.RESULT_SUCCESS
        }
    }

    private fun encodeJson(value: Any): String = if (value is String) JSONObject.quote(value) else value.toString()

    companion object {
        private const val TAG = "iroh.fm"
        private val CHROMIUM_CUSTOM_TABS_PACKAGES = listOf(
            "com.android.chrome",
            "app.vanadium.browser",
            "org.chromium.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
            "org.bromite.bromite",
            "org.cromite.cromite",
            "com.brave.browser",
            "com.brave.browser_beta",
            "com.brave.browser_nightly",
            "com.microsoft.emmx",
            "com.microsoft.emmx.beta",
            "com.microsoft.emmx.dev",
            "com.microsoft.emmx.canary",
            "com.vivaldi.browser",
            "com.vivaldi.browser.snapshot",
            "com.kiwibrowser.browser",
            "com.sec.android.app.sbrowser",
            "com.sec.android.app.sbrowser.beta",
        )
        private const val POST_MESSAGE_ATTEMPTS = 5
        private const val POST_MESSAGE_RETRY_DELAY_MS = 1_000L
        private const val POST_MESSAGE_CHUNK_CHARS = 64 * 1024
        private const val MAX_REQUEST_CHUNKS = 1_024
        private const val MAX_REQUEST_CHARS = 24 * 1024 * 1024
        private const val REQUEST_TRANSFER_TIMEOUT_MS = 30_000L
    }
}
