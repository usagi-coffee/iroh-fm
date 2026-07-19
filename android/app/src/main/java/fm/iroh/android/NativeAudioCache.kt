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
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/** Audio storage shared by the TWA bridge and the foreground playback service. */
object NativeAudioCache {
    data class Stats(val count: Int, val size: Long)

    private val initializationLock = Any()
    private lateinit var rollingCache: SimpleCache
    private lateinit var offlineCache: SimpleCache
    private lateinit var rollingFactory: CacheDataSource.Factory
    private lateinit var offlineDownloadFactory: CacheDataSource.Factory
    private lateinit var playbackFactory: CacheDataSource.Factory

    fun initialize(context: Context) = synchronized(initializationLock) {
        if (::rollingCache.isInitialized) return
        val applicationContext = context.applicationContext
        val database = StandaloneDatabaseProvider(applicationContext)
        rollingCache = SimpleCache(
            File(applicationContext.cacheDir, "iroh-audio"),
            LeastRecentlyUsedCacheEvictor(ROLLING_CACHE_BYTES),
            database,
        )
        offlineCache = SimpleCache(
            File(applicationContext.noBackupFilesDir, "iroh-offline-audio"),
            NoOpCacheEvictor(),
            database,
        )
        rollingFactory = CacheDataSource.Factory()
            .setCache(rollingCache)
            .setUpstreamDataSourceFactory(IrohDataSource.Factory())
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        offlineDownloadFactory = CacheDataSource.Factory()
            .setCache(offlineCache)
            // Promote any already-buffered rolling bytes before requesting missing data over iroh.
            .setUpstreamDataSourceFactory(rollingFactory)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        // Playback checks permanent offline files first, then the rolling stream cache and iroh.
        playbackFactory = CacheDataSource.Factory()
            .setCache(offlineCache)
            .setCacheWriteDataSinkFactory(null)
            .setUpstreamDataSourceFactory(rollingFactory)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    fun playbackDataSourceFactory(): DataSource.Factory = playbackFactory

    fun rollingDataSource(): CacheDataSource = rollingFactory.createDataSourceForDownloading()

    fun cacheKey(remoteId: String, trackId: String): String =
        "$CACHE_KEY_PREFIX$remoteId:$trackId"

    fun isOfflineCached(remoteId: String, trackId: String): Boolean =
        isComplete(offlineCache, cacheKey(remoteId, trackId))

    fun cachedTrackIds(remoteId: String): Set<String> {
        val prefix = "$CACHE_KEY_PREFIX$remoteId:"
        return offlineCache.keys
            .asSequence()
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
    private const val ROLLING_CACHE_BYTES = 1024L * 1024L * 1024L
    private const val DOWNLOAD_BUFFER_BYTES = 128 * 1024
}
