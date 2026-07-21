package fm.iroh.android

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import org.json.JSONObject
import java.io.IOException
import java.io.ByteArrayOutputStream

class IrohDataSource : BaseDataSource(true) {
    private var streamHandle = 0L
    private var remaining = C.LENGTH_UNSET.toLong()
    private var uri: Uri? = null
    private var trackId: String? = null
    private var absolutePosition = 0L
    private var fileSize = 0L
    private var memoryBytes: ByteArray? = null
    private var memoryPosition = 0
    private var memoryCandidate: ByteArrayOutputStream? = null

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        if (NativeCore.offlineOnly) throw IOException("track is not available in the Android offline cache")
        val client = NativeCore.activeClientHandle
        check(client != 0L) { "iroh client is not connected" }
        uri = dataSpec.uri
        trackId = dataSpec.uri.lastPathSegment ?: error("missing track id")
        NativeAudioCache.memoryTrack(NativeCore.activeRemoteId, trackId!!)?.let { cached ->
            memoryBytes = cached
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
        memoryCandidate = if (dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()) {
            ByteArrayOutputStream(fileSize.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
        } else {
            null
        }
        Log.d(TAG, "Native iroh stream opened: trackId=$trackId bytes=$fileSize position=${dataSpec.position}")
        var skipped = 0L
        val scratch = ByteArray(64 * 1024)
        while (skipped < dataSpec.position) {
            val wanted = minOf(scratch.size.toLong(), dataSpec.position - skipped).toInt()
            val read = NativeCore.readStream(streamHandle, scratch, 0, wanted)
            if (read == C.RESULT_END_OF_INPUT) break
            if (read < 0) throw IOException("iroh stream failed while seeking")
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
        memoryBytes?.let { cached ->
            val wanted = minOf(length.toLong(), remaining).toInt()
            cached.copyInto(buffer, offset, memoryPosition, memoryPosition + wanted)
            memoryPosition += wanted
            remaining -= wanted
            return wanted
        }
        val wanted = if (remaining == C.LENGTH_UNSET.toLong()) length else minOf(length.toLong(), remaining).toInt()
        val read = NativeCore.readStream(streamHandle, buffer, offset, wanted)
        if (read == C.RESULT_END_OF_INPUT) return C.RESULT_END_OF_INPUT
        if (read < 0) throw IOException("iroh stream read failed")
        if (remaining != C.LENGTH_UNSET.toLong()) remaining -= read
        absolutePosition += read
        memoryCandidate?.write(buffer, offset, read)
        trackId?.let {
            NativeTransferProgress.update(it, absolutePosition, fileSize)
        }
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        val closingTrackId = trackId
        if (closingTrackId != null && memoryCandidate != null && absolutePosition == fileSize) {
            NativeAudioCache.rememberMemoryTrack(
                NativeCore.activeRemoteId,
                closingTrackId,
                memoryCandidate!!.toByteArray(),
            )
        }
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
        memoryBytes = null
        memoryPosition = 0
        memoryCandidate = null
    }

    class Factory : DataSource.Factory {
        override fun createDataSource(): DataSource = IrohDataSource()
    }

    companion object { private const val TAG = "iroh.fm.playback" }
}
