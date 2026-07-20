package fm.iroh.android

import org.json.JSONObject

object NativeCore {
    init { System.loadLibrary("iroh_fm_android_native") }

    @JvmStatic external fun initialize(applicationContext: Any): String
    @JvmStatic external fun connect(options: String): String
    @JvmStatic external fun request(handle: Long, request: String): String
    @JvmStatic external fun coverArt(handle: Long, coverArtId: String, fullQuality: Boolean): String
    @JvmStatic external fun connectionInfo(handle: Long): String
    @JvmStatic external fun openStream(clientHandle: Long, trackId: String): String
    @JvmStatic external fun readStream(streamHandle: Long, destination: ByteArray, offset: Int, length: Int): Int
    @JvmStatic external fun closeStream(handle: Long)
    @JvmStatic external fun closeClient(handle: Long)
    @JvmStatic external fun generateIdentity(): String
    @JvmStatic external fun endpointIdForSecret(secret: String): String
    @JvmStatic external fun parseTicket(ticket: String): String

    @Volatile var activeClientHandle: Long = 0
    @Volatile var activeRemoteId: String = ""
    @Volatile var offlineOnly: Boolean = false

    fun unwrap(raw: String): String {
        val envelope = JSONObject(raw)
        if (envelope.has("error")) throw IllegalStateException(envelope.getString("error"))
        return envelope.getString("ok")
    }
}
