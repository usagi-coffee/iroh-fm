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
import java.util.concurrent.CopyOnWriteArraySet
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
    private val memoryTrackPins = mutableMapOf<String, Int>()
    private val memoryCacheListeners = CopyOnWriteArraySet<(String, String) -> Unit>()
    private data class MemoryRange(val start: Long, val end: Long)
    private data class PartialMemoryTrack(
        val track: MemoryTrack,
        val ranges: MutableList<MemoryRange> = mutableListOf(),
        var coveredBytes: Long = 0L,
        var activeWriters: Int = 0,
    )
    private val partialMemoryTracks = mutableMapOf<String, PartialMemoryTrack>()
    private var memoryBytes = 0L
    private var partialMemoryBytes = 0L
    private val runtimeHeapBytes = Runtime.getRuntime().maxMemory()
    private val heapSafeMemoryCacheBytes =
        (runtimeHeapBytes / HEAP_CACHE_DIVISOR)
            .coerceIn(MIN_MEMORY_CACHE_BYTES, MAX_MEMORY_CACHE_BYTES)
    private var memoryCacheBytes = minOf(DEFAULT_MEMORY_CACHE_BYTES, heapSafeMemoryCacheBytes)

    fun initialize(context: Context): Unit = synchronized(initializationLock) {
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
        Log.d(TAG, "RAM LRU initialized: ${synchronized(memoryLock) { memoryStateLocked() }}")
    }

    fun playbackDataSourceFactory(): DataSource.Factory = playbackFactory

    fun addMemoryCacheListener(listener: (remoteId: String, trackId: String) -> Unit) {
        memoryCacheListeners += listener
    }

    fun cacheKey(remoteId: String, trackId: String): String =
        "$CACHE_KEY_PREFIX$remoteId:$trackId"

    fun isOfflineCached(remoteId: String, trackId: String): Boolean =
        isComplete(offlineCache, cacheKey(remoteId, trackId))

    fun isPlaybackCached(remoteId: String, trackId: String): Boolean =
        isOfflineCached(remoteId, trackId)

    fun memoryTrack(remoteId: String, trackId: String): MemoryTrack? = synchronized(memoryLock) {
        memoryTracks[cacheKey(remoteId, trackId)]
    }

    fun acquireMemoryTrack(remoteId: String, trackId: String): MemoryTrack? =
        synchronized(memoryLock) {
            val key = cacheKey(remoteId, trackId)
            memoryTracks[key]?.also {
                memoryTrackPins[key] = (memoryTrackPins[key] ?: 0) + 1
                Log.d(
                    TAG,
                    "RAM LRU hit: trackId=$trackId bytes=${it.size} pins=${memoryTrackPins[key]} " +
                        memoryStateLocked(),
                )
            } ?: run {
                Log.d(TAG, "RAM LRU miss: trackId=$trackId ${memoryStateLocked()}")
                null
            }
        }

    fun releaseMemoryTrack(remoteId: String, trackId: String) = synchronized(memoryLock) {
        val key = cacheKey(remoteId, trackId)
        memoryTrackPins[key]?.let { pins ->
            if (pins <= 1) memoryTrackPins.remove(key) else memoryTrackPins[key] = pins - 1
            Log.d(
                TAG,
                "RAM LRU unpinned: trackId=$trackId pins=${memoryTrackPins[key] ?: 0} " +
                    memoryStateLocked(),
            )
        }
        trimMemoryCacheLocked()
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
        if (totalBytes <= 0L || totalBytes > Int.MAX_VALUE.toLong()) {
            Log.w(TAG, "RAM LRU write rejected: trackId=$trackId invalidTotalBytes=$totalBytes")
            return false
        }
        if (offset < 0 || length <= 0 || offset > buffer.size - length) {
            Log.w(
                TAG,
                "RAM LRU write rejected: trackId=$trackId invalidBufferRange=" +
                    "$offset+${length}/${buffer.size}",
            )
            return false
        }
        val key = cacheKey(remoteId, trackId)
        if (memoryTracks.containsKey(key)) return true
        val total = totalBytes.toInt()
        val track = ensurePartialMemoryTrackLocked(key, total, trackId) ?: return false
        val start = position.coerceIn(0L, totalBytes)
        val copyLength = minOf(length.toLong(), totalBytes - start).toInt()
        if (copyLength <= 0) return track.coveredBytes >= totalBytes
        track.track.write(start.toInt(), buffer, offset, copyLength)
        addMemoryRange(track, start, start + copyLength)
        if (track.coveredBytes < totalBytes) return false

        partialMemoryTracks.remove(key)
        partialMemoryBytes -= totalBytes
        val writerPins = track.activeWriters
        val inserted = insertMemoryTrackLocked(key, track.track, trackId)
        if (inserted && writerPins > 0) {
            memoryTrackPins[key] = (memoryTrackPins[key] ?: 0) + writerPins
            Log.d(
                TAG,
                "RAM LRU carried writer pins into completed entry: trackId=$trackId " +
                    "writerPins=$writerPins pins=${memoryTrackPins[key]}",
            )
        } else if (!inserted) {
            Log.w(TAG, "RAM LRU promotion failed after complete download: trackId=$trackId ${memoryStateLocked()}")
        }
        inserted
    }

    fun resizeMemoryCache(bytes: Long) = synchronized(memoryLock) {
        val previous = memoryCacheBytes
        val configured = bytes.coerceIn(MIN_MEMORY_CACHE_BYTES, MAX_MEMORY_CACHE_BYTES)
        memoryCacheBytes = minOf(configured, heapSafeMemoryCacheBytes)
        Log.d(
            TAG,
            "RAM LRU resized: requestedBytes=$bytes configuredBytes=$configured " +
                "previousBytes=$previous appliedBytes=$memoryCacheBytes " +
                "heapSafeLimit=$heapSafeMemoryCacheBytes runtimeHeap=$runtimeHeapBytes " +
                memoryStateLocked(),
        )
        trimMemoryCacheLocked()
    }

    private fun trimMemoryCacheLocked() {
        while (memoryBytes + partialMemoryBytes > memoryCacheBytes) {
            if (evictOldestMemoryTrackLocked()) continue
            if (!evictOldestInactivePartialLocked()) {
                Log.w(TAG, "RAM LRU trim blocked by pinned/active entries: ${memoryStateLocked()}")
                break
            }
        }
    }

    private fun ensurePartialMemoryTrackLocked(
        key: String,
        total: Int,
        trackId: String,
    ): PartialMemoryTrack? {
        partialMemoryTracks[key]?.let { partial ->
            if (partial.track.size == total) return partial
            if (partial.activeWriters > 0) {
                Log.w(
                    TAG,
                    "RAM LRU reservation rejected: trackId=$trackId sizeChanged=" +
                        "${partial.track.size}->$total activeWriters=${partial.activeWriters}",
                )
                return null
            }
            partialMemoryTracks.remove(key)
            partialMemoryBytes -= partial.track.size.toLong()
            Log.d(
                TAG,
                "RAM LRU discarded incompatible partial: trackId=$trackId " +
                    "oldBytes=${partial.track.size} newBytes=$total ${memoryStateLocked()}",
            )
        }
        if (!reservePartialMemoryLocked(total.toLong(), trackId)) return null
        return PartialMemoryTrack(MemoryTrack(total)).also { partial ->
            partialMemoryTracks[key] = partial
            partialMemoryBytes += total.toLong()
            Log.d(TAG, "RAM LRU reserved partial: trackId=$trackId bytes=$total ${memoryStateLocked()}")
        }
    }

    fun beginMemoryTrack(remoteId: String, trackId: String, totalBytes: Long): Boolean =
        synchronized(memoryLock) {
            if (totalBytes <= 0L || totalBytes > Int.MAX_VALUE.toLong()) {
                Log.w(TAG, "RAM LRU writer rejected: trackId=$trackId invalidTotalBytes=$totalBytes")
                return false
            }
            val key = cacheKey(remoteId, trackId)
            if (memoryTracks.containsKey(key)) {
                memoryTrackPins[key] = (memoryTrackPins[key] ?: 0) + 1
                Log.d(
                    TAG,
                    "RAM LRU writer attached to completed entry: trackId=$trackId " +
                        "pins=${memoryTrackPins[key]}",
                )
                return true
            }
            val partial = ensurePartialMemoryTrackLocked(key, totalBytes.toInt(), trackId)
                ?: return false
            partial.activeWriters += 1
            Log.d(
                TAG,
                "RAM LRU writer started: trackId=$trackId activeWriters=${partial.activeWriters}",
            )
            true
        }

    fun endMemoryTrack(remoteId: String, trackId: String) = synchronized(memoryLock) {
        val key = cacheKey(remoteId, trackId)
        val partial = partialMemoryTracks[key]
        if (partial != null) {
            partial.activeWriters = (partial.activeWriters - 1).coerceAtLeast(0)
            Log.d(
                TAG,
                "RAM LRU writer ended: trackId=$trackId activeWriters=${partial.activeWriters} " +
                    "coveredBytes=${partial.coveredBytes}/${partial.track.size}",
            )
        } else {
            memoryTrackPins[key]?.let { pins ->
                if (pins <= 1) memoryTrackPins.remove(key) else memoryTrackPins[key] = pins - 1
                Log.d(
                    TAG,
                    "RAM LRU completed writer detached: trackId=$trackId " +
                        "pins=${memoryTrackPins[key] ?: 0} ${memoryStateLocked()}",
                )
            }
        }
        trimMemoryCacheLocked()
    }

    private fun insertMemoryTrackLocked(key: String, track: MemoryTrack, trackId: String = key): Boolean {
        if (track.size <= 0) {
            Log.w(TAG, "RAM LRU insertion rejected: trackId=$trackId emptyTrack")
            return false
        }
        if (track.size.toLong() > memoryCacheBytes) {
            Log.w(
                TAG,
                "RAM LRU insertion rejected: trackId=$trackId bytes=${track.size} " +
                    "largerThanLimit=$memoryCacheBytes",
            )
            return false
        }
        val previous = memoryTracks.remove(key)
        memoryBytes -= previous?.size?.toLong() ?: 0L
        while (memoryBytes + partialMemoryBytes + track.size > memoryCacheBytes) {
            if (!evictOldestMemoryTrackLocked()) {
                previous?.let {
                    memoryTracks[key] = it
                    memoryBytes += it.size
                }
                Log.w(
                    TAG,
                    "RAM LRU insertion rejected: trackId=$trackId " +
                        "allCompleteEntriesPinnedOrPartialReservationsConsumeCapacity " +
                        memoryStateLocked(),
                )
                return false
            }
        }
        memoryTracks[key] = track
        memoryBytes += track.size
        Log.d(
            TAG,
            "RAM LRU added: trackId=$trackId bytes=${track.size} replacedBytes=${previous?.size ?: 0} " +
                memoryStateLocked(),
        )
        notifyMemoryCacheChanged(key)
        return true
    }

    private fun reservePartialMemoryLocked(bytes: Long, trackId: String): Boolean {
        if (bytes > memoryCacheBytes) {
            Log.w(
                TAG,
                "RAM LRU reservation rejected: trackId=$trackId bytes=$bytes " +
                    "largerThanLimit=$memoryCacheBytes",
            )
            return false
        }
        while (memoryBytes + partialMemoryBytes + bytes > memoryCacheBytes) {
            if (evictOldestMemoryTrackLocked()) continue
            if (!evictOldestInactivePartialLocked()) {
                Log.w(
                    TAG,
                    "RAM LRU reservation rejected: trackId=$trackId bytes=$bytes " +
                        "allEntriesPinnedOrActive ${memoryStateLocked()}",
                )
                return false
            }
        }
        return true
    }

    private fun evictOldestInactivePartialLocked(): Boolean {
        val entry = partialMemoryTracks.entries.firstOrNull { it.value.activeWriters == 0 }
            ?: return false
        partialMemoryTracks.remove(entry.key)
        partialMemoryBytes -= entry.value.track.size.toLong()
        Log.d(
            TAG,
            "RAM LRU evicted incomplete entry: key=${entry.key} bytes=${entry.value.track.size} " +
                "coveredBytes=${entry.value.coveredBytes} ${memoryStateLocked()}",
        )
        return true
    }

    private fun evictOldestMemoryTrackLocked(): Boolean {
        val oldest = memoryTracks.entries.firstOrNull { (memoryTrackPins[it.key] ?: 0) == 0 }
            ?: return false
        memoryTracks.remove(oldest.key)
        memoryTrackPins.remove(oldest.key)
        memoryBytes -= oldest.value.size.toLong()
        Log.d(
            TAG,
            "RAM LRU evicted complete entry: key=${oldest.key} bytes=${oldest.value.size} " +
                memoryStateLocked(),
        )
        notifyMemoryCacheChanged(oldest.key)
        return true
    }

    private fun notifyMemoryCacheChanged(key: String) {
        val scopedKey = key.removePrefix(CACHE_KEY_PREFIX)
        val separator = scopedKey.indexOf(':')
        if (separator <= 0 || separator >= scopedKey.lastIndex) return
        val remoteId = scopedKey.substring(0, separator)
        val trackId = scopedKey.substring(separator + 1)
        memoryCacheListeners.forEach { it(remoteId, trackId) }
    }

    private fun memoryStateLocked(): String =
        "complete=${memoryTracks.size}/$memoryBytes partial=${partialMemoryTracks.size}/$partialMemoryBytes " +
            "limit=$memoryCacheBytes pinned=${memoryTrackPins.count { it.value > 0 }} " +
            "activePartials=${partialMemoryTracks.count { it.value.activeWriters > 0 }}"

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

    fun clearOfflineTracks() {
        for (key in offlineCache.keys.toList()) offlineCache.removeResource(key)
    }

    /** Downloads a complete track into the RAM LRU without writing it to disk. */
    fun prefetchTrack(
        clientHandle: Long,
        remoteId: String,
        trackId: String,
        shouldContinue: () -> Boolean = { true },
        onStreamOpened: (Long) -> Unit = {},
    ): Boolean {
        memoryTrack(remoteId, trackId)?.let {
            Log.d(TAG, "RAM LRU prefetch skipped; already cached: trackId=$trackId bytes=${it.size}")
            NativeTransferProgress.update(trackId, it.size.toLong(), it.size.toLong(), reset = true)
            return true
        }
        if (!shouldContinue()) {
            Log.d(TAG, "RAM LRU prefetch cancelled before open: trackId=$trackId")
            return false
        }
        var streamHandle = 0L
        var transferStarted = false
        var memoryWriterStarted = false
        try {
            val opened = JSONObject(NativeCore.unwrap(NativeCore.openStream(clientHandle, trackId)))
            streamHandle = opened.getLong("handle")
            onStreamOpened(streamHandle)
            if (!shouldContinue()) {
                Log.d(TAG, "RAM LRU prefetch cancelled after open: trackId=$trackId")
                return false
            }
            val total = opened.getLong("fileSize")
            if (!beginMemoryTrack(remoteId, trackId, total)) {
                Log.w(TAG, "RAM LRU prefetch not started; reservation failed: trackId=$trackId bytes=$total")
                return false
            }
            memoryWriterStarted = true
            NativeTransferProgress.update(trackId, 0L, total, reset = true)
            NativeTransferProgress.begin(trackId)
            transferStarted = true
            val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
            var position = 0L
            while (position < total) {
                if (!shouldContinue()) {
                    Log.d(
                        TAG,
                        "RAM LRU prefetch cancelled: trackId=$trackId bytes=$position/$total",
                    )
                    return false
                }
                val wanted = minOf(buffer.size.toLong(), total - position).toInt()
                val read = NativeCore.readStream(streamHandle, buffer, 0, wanted)
                if (read == C.RESULT_END_OF_INPUT) break
                if (read < 0) error("iroh stream failed while caching in memory")
                recordMemoryBytes(remoteId, trackId, position, buffer, 0, read, total)
                position += read
                NativeTransferProgress.update(trackId, position, total)
            }
            val cached = position == total && isMemoryCached(remoteId, trackId)
            Log.d(
                TAG,
                "RAM LRU prefetch finished: trackId=$trackId bytes=$position/$total cached=$cached",
            )
            return cached
        } finally {
            if (streamHandle != 0L) NativeCore.closeStream(streamHandle)
            if (transferStarted) NativeTransferProgress.end(trackId)
            if (memoryWriterStarted) endMemoryTrack(remoteId, trackId)
        }
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
    private const val DEFAULT_MEMORY_CACHE_BYTES = 64L * 1024L * 1024L
    private const val MIN_MEMORY_CACHE_BYTES = 32L * 1024L * 1024L
    private const val MAX_MEMORY_CACHE_BYTES = 256L * 1024L * 1024L
    private const val HEAP_CACHE_DIVISOR = 2L
    private const val MEMORY_CHUNK_BYTES = 1024 * 1024
}
