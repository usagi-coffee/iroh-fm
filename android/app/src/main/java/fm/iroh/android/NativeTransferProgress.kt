package fm.iroh.android

object NativeTransferProgress {
    data class Snapshot(
        val receivedBytes: Long,
        val totalBytes: Long,
        val active: Boolean,
    )

    private data class State(
        var receivedBytes: Long = 0,
        var totalBytes: Long = 0,
        var activeReaders: Int = 0,
    )

    private val lock = Any()
    private val states = mutableMapOf<String, State>()

    fun begin(trackId: String) = synchronized(lock) {
        states.getOrPut(trackId, ::State).activeReaders += 1
    }

    fun end(trackId: String) = synchronized(lock) {
        states[trackId]?.let { it.activeReaders = (it.activeReaders - 1).coerceAtLeast(0) }
    }

    fun update(trackId: String, receivedBytes: Long, totalBytes: Long, reset: Boolean = false) {
        synchronized(lock) {
            val state = states.getOrPut(trackId, ::State)
            val normalizedTotal = totalBytes.coerceAtLeast(0L)
            val received = if (reset) receivedBytes else maxOf(state.receivedBytes, receivedBytes)
            state.totalBytes = maxOf(state.totalBytes, normalizedTotal)
            state.receivedBytes = received.coerceAtLeast(0L).let {
                if (state.totalBytes > 0L) it.coerceAtMost(state.totalBytes) else it
            }
        }
    }

    fun snapshot(trackId: String?): Snapshot? = synchronized(lock) {
        trackId?.let(states::get)?.let {
            Snapshot(it.receivedBytes, it.totalBytes, it.activeReaders > 0)
        }
    }
}
