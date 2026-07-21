package fm.iroh.android

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import org.json.JSONObject
import java.io.IOException

class IrohDataSource(
    private val useMemoryCache: Boolean = true,
    private val populateMemoryCache: Boolean = true,
) : BaseDataSource(true) {
    private var streamHandle = 0L
    private var remaining = C.LENGTH_UNSET.toLong()
    private var uri: Uri? = null
    private var trackId: String? = null
    private var absolutePosition = 0L
    private var fileSize = 0L
    private var memoryTrack: NativeAudioCache.MemoryTrack? = null
    private var memoryPosition = 0

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        if (NativeCore.offlineOnly) throw IOException("track is not available in the Android offline cache")
        val client = NativeCore.activeClientHandle
        check(client != 0L) { "iroh client is not connected" }
        uri = dataSpec.uri
        trackId = dataSpec.uri.lastPathSegment ?: error("missing track id")
        if (useMemoryCache) NativeAudioCache.memoryTrack(NativeCore.activeRemoteId, trackId!!)?.let { cached ->
            memoryTrack = cached
            memoryPosition = dataSpec.position.coerceIn(0L, cached.size.toLong()).toInt()
            fileSize = cached.size.toLong()
            remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
                dataSpec.length.coerceAtMost(fileSize - memoryPosition)
            } else {
                fileSize - memoryPosition
            }
            return remaining
        }
        val opened = JSONObject(NativeCore.unwrap(NativeCore.openStream(client, trackId!!)))
        streamHandle = opened.getLong("handle")
        fileSize = opened.getLong("fileSize")
        Log.d(TAG, "Native iroh stream opened: trackId=$trackId bytes=$fileSize position=${dataSpec.position}")
        var skipped = 0L
        val scratch = ByteArray(64 * 1024)
        while (skipped < dataSpec.position) {
            val wanted = minOf(scratch.size.toLong(), dataSpec.position - skipped).toInt()
            val read = NativeCore.readStream(streamHandle, scratch, 0, wanted)
            if (read == C.RESULT_END_OF_INPUT) break
            if (read < 0) throw IOException("iroh stream failed while seeking")
            if (populateMemoryCache) {
                NativeAudioCache.recordMemoryBytes(
                    NativeCore.activeRemoteId,
                    trackId!!,
                    skipped,
                    scratch,
                    0,
                    read,
                    fileSize,
                )
            }
            skipped += read
        }
        absolutePosition = skipped
        NativeTransferProgress.update(
            trackId = trackId!!,
            receivedBytes = absolutePosition,
            totalBytes = fileSize,
            reset = dataSpec.position == 0L,
        )
        NativeTransferProgress.begin(trackId!!)
        remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else fileSize - skipped
        transferStarted(dataSpec)
        return remaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        memoryTrack?.let { cached ->
            val wanted = minOf(length.toLong(), remaining).toInt()
            cached.read(memoryPosition, buffer, offset, wanted)
            memoryPosition += wanted
            remaining -= wanted
            return wanted
        }
        val wanted = if (remaining == C.LENGTH_UNSET.toLong()) length else minOf(length.toLong(), remaining).toInt()
        val read = NativeCore.readStream(streamHandle, buffer, offset, wanted)
        if (read == C.RESULT_END_OF_INPUT) return C.RESULT_END_OF_INPUT
        if (read < 0) throw IOException("iroh stream read failed")
        if (remaining != C.LENGTH_UNSET.toLong()) remaining -= read
        val readPosition = absolutePosition
        absolutePosition += read
        if (populateMemoryCache) {
            NativeAudioCache.recordMemoryBytes(
                NativeCore.activeRemoteId,
                trackId!!,
                readPosition,
                buffer,
                offset,
                read,
                fileSize,
            )
        }
        trackId?.let {
            NativeTransferProgress.update(it, absolutePosition, fileSize)
        }
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        val closingTrackId = trackId
        if (streamHandle != 0L) {
            Log.d(TAG, "Native iroh stream closed: uri=$uri")
            NativeCore.closeStream(streamHandle)
            streamHandle = 0
            transferEnded()
        }
        if (closingTrackId != null) NativeTransferProgress.end(closingTrackId)
        uri = null
        trackId = null
        absolutePosition = 0L
        fileSize = 0L
        memoryTrack = null
        memoryPosition = 0
    }

    class Factory(
        private val useMemoryCache: Boolean = true,
        private val populateMemoryCache: Boolean = true,
    ) : DataSource.Factory {
        override fun createDataSource(): DataSource =
            IrohDataSource(useMemoryCache, populateMemoryCache)
    }

    companion object { private const val TAG = "iroh.fm.playback" }
}
