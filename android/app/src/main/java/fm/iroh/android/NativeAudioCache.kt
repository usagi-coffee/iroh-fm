package fm.iroh.android

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.LinkedHashMap
import org.json.JSONObject

/** Audio storage shared by the TWA bridge and the foreground playback service. */
object NativeAudioCache {
    data class Stats(val count: Int, val size: Long)

    private val initializationLock = Any()
    private lateinit var offlineCache: SimpleCache
    private lateinit var offlineDownloadFactory: CacheDataSource.Factory
    private lateinit var playbackFactory: CacheDataSource.Factory
    private val memoryLock = Any()
    class MemoryTrack(val size: Int) {
        private val chunks = mutableMapOf<Int, ByteArray>()

        fun write(position: Int, source: ByteArray, offset: Int, length: Int) {
            var sourceOffset = offset
            var targetPosition = position
            var remaining = length
            while (remaining > 0) {
                val chunkIndex = targetPosition / NativeAudioCache.MEMORY_CHUNK_BYTES
                val chunkOffset = targetPosition % NativeAudioCache.MEMORY_CHUNK_BYTES
                val chunkStart = chunkIndex * NativeAudioCache.MEMORY_CHUNK_BYTES
                val chunkSize = minOf(NativeAudioCache.MEMORY_CHUNK_BYTES, size - chunkStart)
                val chunk = chunks.getOrPut(chunkIndex) { ByteArray(chunkSize) }
                val copied = minOf(remaining, chunk.size - chunkOffset)
                source.copyInto(chunk, chunkOffset, sourceOffset, sourceOffset + copied)
                sourceOffset += copied
                targetPosition += copied
                remaining -= copied
            }
        }

        fun read(position: Int, target: ByteArray, offset: Int, length: Int): Int {
            var targetOffset = offset
            var sourcePosition = position
            var remaining = minOf(length, size - position)
            val requested = remaining
            while (remaining > 0) {
                val chunkIndex = sourcePosition / NativeAudioCache.MEMORY_CHUNK_BYTES
                val chunkOffset = sourcePosition % NativeAudioCache.MEMORY_CHUNK_BYTES
                val chunk = chunks[chunkIndex] ?: error("incomplete memory track")
                val copied = minOf(remaining, chunk.size - chunkOffset)
                chunk.copyInto(target, targetOffset, chunkOffset, chunkOffset + copied)
                targetOffset += copied
                sourcePosition += copied
                remaining -= copied
            }
            return requested
        }
    }
    private val memoryTracks = LinkedHashMap<String, MemoryTrack>(0, 0.75f, true)
    private data class MemoryRange(val start: Long, val end: Long)
    private data class PartialMemoryTrack(
        val track: MemoryTrack,
        val ranges: MutableList<MemoryRange> = mutableListOf(),
        var coveredBytes: Long = 0L,
    )
    private val partialMemoryTracks = mutableMapOf<String, PartialMemoryTrack>()
    private var memoryBytes = 0L
    private var partialMemoryBytes = 0L
    private var memoryCacheBytes = DEFAULT_MEMORY_CACHE_BYTES

    fun initialize(context: Context) = synchronized(initializationLock) {
        if (::offlineCache.isInitialized) return
        val applicationContext = context.applicationContext
        val database = StandaloneDatabaseProvider(applicationContext)
        offlineCache = SimpleCache(
            File(applicationContext.noBackupFilesDir, "iroh-offline-audio"),
            NoOpCacheEvictor(),
            database,
        )
        offlineDownloadFactory = CacheDataSource.Factory()
            .setCache(offlineCache)
            .setUpstreamDataSourceFactory(IrohDataSource.Factory(populateMemoryCache = false))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        playbackFactory = CacheDataSource.Factory()
            .setCache(offlineCache)
            .setCacheWriteDataSinkFactory(null)
            .setUpstreamDataSourceFactory(IrohDataSource.Factory())
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    fun playbackDataSourceFactory(): DataSource.Factory = playbackFactory

    fun cacheKey(remoteId: String, trackId: String): String =
        "$CACHE_KEY_PREFIX$remoteId:$trackId"

    fun isOfflineCached(remoteId: String, trackId: String): Boolean =
        isComplete(offlineCache, cacheKey(remoteId, trackId))

    fun isPlaybackCached(remoteId: String, trackId: String): Boolean =
        isOfflineCached(remoteId, trackId)

    fun memoryTrack(remoteId: String, trackId: String): MemoryTrack? = synchronized(memoryLock) {
        memoryTracks[cacheKey(remoteId, trackId)]
    }

    fun isMemoryCached(remoteId: String, trackId: String): Boolean = synchronized(memoryLock) {
        memoryTracks.containsKey(cacheKey(remoteId, trackId))
    }

    fun rememberMemoryTrack(remoteId: String, trackId: String, bytes: ByteArray) {
        synchronized(memoryLock) {
            val track = MemoryTrack(bytes.size)
            track.write(0, bytes, 0, bytes.size)
            insertMemoryTrackLocked(cacheKey(remoteId, trackId), track)
        }
    }

    /** Records a range read by Media3 and promotes it once the complete track is available. */
    fun recordMemoryBytes(
        remoteId: String,
        trackId: String,
        position: Long,
        buffer: ByteArray,
        offset: Int,
        length: Int,
        totalBytes: Long,
    ): Boolean = synchronized(memoryLock) {
        if (
            totalBytes <= 0L ||
            totalBytes > Int.MAX_VALUE.toLong() ||
            offset < 0 ||
            length <= 0 ||
            offset > buffer.size - length
        ) return false
        val key = cacheKey(remoteId, trackId)
        if (memoryTracks.containsKey(key)) return true
        val total = totalBytes.toInt()
        var partial = partialMemoryTracks[key]
        if (partial == null || partial.track.size != total) {
            partial?.let {
                partialMemoryTracks.remove(key)
                partialMemoryBytes -= it.track.size.toLong()
            }
            if (!reservePartialMemoryLocked(total.toLong())) return false
            val newPartial = PartialMemoryTrack(MemoryTrack(total))
            partial = newPartial
            partialMemoryTracks[key] = newPartial
            partialMemoryBytes += total.toLong()
        }
        val track = partial ?: return false
        val start = position.coerceIn(0L, totalBytes)
        val copyLength = minOf(length.toLong(), totalBytes - start).toInt()
        if (copyLength <= 0) return track.coveredBytes >= totalBytes
        track.track.write(start.toInt(), buffer, offset, copyLength)
        addMemoryRange(track, start, start + copyLength)
        if (track.coveredBytes < totalBytes) return false

        partialMemoryTracks.remove(key)
        partialMemoryBytes -= totalBytes
        insertMemoryTrackLocked(key, track.track)
        true
    }

    fun resizeMemoryCache(bytes: Long) = synchronized(memoryLock) {
        memoryCacheBytes = bytes.coerceIn(MIN_MEMORY_CACHE_BYTES, MAX_MEMORY_CACHE_BYTES)
        while (memoryBytes > memoryCacheBytes) {
            if (!evictOldestMemoryTrackLocked()) break
        }
        while (memoryBytes + partialMemoryBytes > memoryCacheBytes) {
            val key = partialMemoryTracks.keys.firstOrNull() ?: break
            val partial = partialMemoryTracks.remove(key) ?: break
            partialMemoryBytes -= partial.track.size.toLong()
        }
    }

    private fun insertMemoryTrackLocked(key: String, track: MemoryTrack) {
        if (track.size <= 0 || track.size.toLong() > memoryCacheBytes) return
        memoryBytes -= memoryTracks.remove(key)?.size?.toLong() ?: 0L
        while (memoryBytes + partialMemoryBytes + track.size > memoryCacheBytes) {
            if (!evictOldestMemoryTrackLocked()) return
        }
        memoryTracks[key] = track
        memoryBytes += track.size
    }

    private fun reservePartialMemoryLocked(bytes: Long): Boolean {
        if (bytes > memoryCacheBytes) return false
        while (memoryBytes + partialMemoryBytes + bytes > memoryCacheBytes) {
            if (evictOldestMemoryTrackLocked()) continue
            val key = partialMemoryTracks.keys.firstOrNull() ?: return false
            val partial = partialMemoryTracks.remove(key) ?: continue
            partialMemoryBytes -= partial.track.size.toLong()
        }
        return true
    }

    private fun evictOldestMemoryTrackLocked(): Boolean {
        val oldest = memoryTracks.entries.iterator()
        if (!oldest.hasNext()) return false
        memoryBytes -= oldest.next().value.size.toLong()
        oldest.remove()
        return true
    }

    private fun addMemoryRange(track: PartialMemoryTrack, start: Long, end: Long) {
        var mergedStart = start
        var mergedEnd = end
        var newlyCovered = end - start
        val remaining = mutableListOf<MemoryRange>()
        for (range in track.ranges) {
            if (range.end < mergedStart || range.start > mergedEnd) {
                remaining += range
                continue
            }
            val overlapStart = maxOf(range.start, start)
            val overlapEnd = minOf(range.end, end)
            if (overlapEnd > overlapStart) newlyCovered -= overlapEnd - overlapStart
            mergedStart = minOf(mergedStart, range.start)
            mergedEnd = maxOf(mergedEnd, range.end)
        }
        remaining += MemoryRange(mergedStart, mergedEnd)
        remaining.sortBy { it.start }
        track.ranges.clear()
        track.ranges.addAll(remaining)
        track.coveredBytes += newlyCovered.coerceAtLeast(0L)
    }

    fun cachedTrackIds(remoteId: String): Set<String> {
        val prefix = "$CACHE_KEY_PREFIX$remoteId:"
        return offlineCache.keys.asSequence()
            .filter { it.startsWith(prefix) && isComplete(offlineCache, it) }
            .map { it.removePrefix(prefix) }
            .toSet()
    }

    fun offlineStats(): Stats {
        val completeKeys = offlineCache.keys.count { isComplete(offlineCache, it) }
        return Stats(completeKeys, offlineCache.cacheSpace)
    }

    /** Downloads a complete track into the RAM LRU without writing it to disk. */
    fun prefetchTrack(
        clientHandle: Long,
        remoteId: String,
        trackId: String,
        shouldContinue: () -> Boolean = { true },
    ): Boolean {
        memoryTrack(remoteId, trackId)?.let {
            NativeTransferProgress.update(trackId, it.size.toLong(), it.size.toLong(), reset = true)
            return true
        }
        if (!shouldContinue()) return false
        var streamHandle = 0L
        var transferStarted = false
        try {
            val opened = JSONObject(NativeCore.unwrap(NativeCore.openStream(clientHandle, trackId)))
            streamHandle = opened.getLong("handle")
            val total = opened.getLong("fileSize")
            if (!canCacheMemoryTrack(total)) return false
            NativeTransferProgress.update(trackId, 0L, total, reset = true)
            NativeTransferProgress.begin(trackId)
            transferStarted = true
            val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
            var position = 0L
            while (position < total) {
                if (!shouldContinue()) return false
                val wanted = minOf(buffer.size.toLong(), total - position).toInt()
                val read = NativeCore.readStream(streamHandle, buffer, 0, wanted)
                if (read == C.RESULT_END_OF_INPUT) break
                if (read < 0) error("iroh stream failed while caching in memory")
                recordMemoryBytes(remoteId, trackId, position, buffer, 0, read, total)
                position += read
                NativeTransferProgress.update(trackId, position, total)
            }
            return position == total && isMemoryCached(remoteId, trackId)
        } finally {
            if (streamHandle != 0L) NativeCore.closeStream(streamHandle)
            if (transferStarted) NativeTransferProgress.end(trackId)
        }
    }

    private fun canCacheMemoryTrack(bytes: Long): Boolean = synchronized(memoryLock) {
        bytes >= 1L && bytes <= Int.MAX_VALUE.toLong() && bytes <= memoryCacheBytes
    }

    fun cacheTrack(remoteId: String, trackId: String): Boolean {
        val key = cacheKey(remoteId, trackId)
        if (isComplete(offlineCache, key)) {
            val length = contentLength(offlineCache, key)
            NativeTransferProgress.update(trackId, length, length)
            return true
        }
        val uri = Uri.parse("iroh-fm://track/${Uri.encode(trackId)}")
        Log.d(TAG, "Offline download started: mediaId=$trackId remoteId=$remoteId")
        val writer = CacheWriter(
            offlineDownloadFactory.createDataSourceForDownloading(),
            DataSpec.Builder().setUri(uri).setKey(key).build(),
            ByteArray(DOWNLOAD_BUFFER_BYTES),
            CacheWriter.ProgressListener { requestLength, bytesCached, _ ->
                NativeTransferProgress.update(trackId, bytesCached, requestLength)
            },
        )
        writer.cache()
        return isComplete(offlineCache, key).also { cached ->
            Log.d(TAG, "Offline download finished: mediaId=$trackId cached=$cached")
        }
    }

    private fun isComplete(cache: SimpleCache, key: String): Boolean {
        val length = contentLength(cache, key)
        return length > 0L && cache.isCached(key, 0, length)
    }

    private fun contentLength(cache: SimpleCache, key: String): Long =
        ContentMetadata.getContentLength(cache.getContentMetadata(key))

    private const val CACHE_KEY_PREFIX = "iroh-fm:"
    private const val TAG = "iroh.fm.cache"
    private const val DOWNLOAD_BUFFER_BYTES = 128 * 1024
    private const val DEFAULT_MEMORY_CACHE_BYTES = 256L * 1024L * 1024L
    private const val MIN_MEMORY_CACHE_BYTES = 32L * 1024L * 1024L
    private const val MAX_MEMORY_CACHE_BYTES = 2L * 1024L * 1024L * 1024L
    private const val MEMORY_CHUNK_BYTES = 1024 * 1024
}
