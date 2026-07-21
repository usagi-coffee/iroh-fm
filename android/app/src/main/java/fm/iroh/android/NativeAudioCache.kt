package fm.iroh.android

import android.content.Context
import android.net.Uri
import android.util.Log
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

/** Audio storage shared by the TWA bridge and the foreground playback service. */
object NativeAudioCache {
    data class Stats(val count: Int, val size: Long)

    private val initializationLock = Any()
    private lateinit var offlineCache: SimpleCache
    private lateinit var offlineDownloadFactory: CacheDataSource.Factory
    private lateinit var playbackFactory: CacheDataSource.Factory
    private val memoryLock = Any()
    private val memoryTracks = LinkedHashMap<String, ByteArray>(0, 0.75f, true)
    private var memoryBytes = 0L
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
            .setUpstreamDataSourceFactory(IrohDataSource.Factory())
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

    fun memoryTrack(remoteId: String, trackId: String): ByteArray? = synchronized(memoryLock) {
        memoryTracks[cacheKey(remoteId, trackId)]
    }

    fun isMemoryCached(remoteId: String, trackId: String): Boolean = synchronized(memoryLock) {
        memoryTracks.containsKey(cacheKey(remoteId, trackId))
    }

    fun rememberMemoryTrack(remoteId: String, trackId: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size.toLong() > memoryCacheBytes) return
        synchronized(memoryLock) {
            val key = cacheKey(remoteId, trackId)
            memoryBytes -= memoryTracks.remove(key)?.size?.toLong() ?: 0L
            while (memoryBytes + bytes.size > memoryCacheBytes) {
                val oldest = memoryTracks.entries.iterator()
                if (!oldest.hasNext()) break
                memoryBytes -= oldest.next().value.size.toLong()
                oldest.remove()
            }
            memoryTracks[key] = bytes
            memoryBytes += bytes.size
        }
    }

    fun resizeMemoryCache(bytes: Long) = synchronized(memoryLock) {
        memoryCacheBytes = bytes.coerceIn(MIN_MEMORY_CACHE_BYTES, MAX_MEMORY_CACHE_BYTES)
        while (memoryBytes > memoryCacheBytes) {
            val oldest = memoryTracks.entries.iterator()
            if (!oldest.hasNext()) break
            memoryBytes -= oldest.next().value.size.toLong()
            oldest.remove()
        }
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
}
