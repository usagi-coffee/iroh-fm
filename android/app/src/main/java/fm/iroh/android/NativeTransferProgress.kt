package fm.iroh.android

object NativeTransferProgress {
    data class Snapshot(
        val receivedBytes: Long,
        val totalBytes: Long,
    )

    private val lock = Any()
    private val snapshots = mutableMapOf<String, Snapshot>()

    fun update(trackId: String, receivedBytes: Long, totalBytes: Long, reset: Boolean = false) {
        synchronized(lock) {
            val previous = snapshots[trackId]
            val received = if (reset) receivedBytes else maxOf(previous?.receivedBytes ?: 0L, receivedBytes)
            snapshots[trackId] = Snapshot(
                receivedBytes = received.coerceAtLeast(0L).coerceAtMost(totalBytes),
                totalBytes = totalBytes.coerceAtLeast(0L),
            )
        }
    }

    fun snapshot(trackId: String?): Snapshot? = synchronized(lock) {
        trackId?.let(snapshots::get)
    }
}
