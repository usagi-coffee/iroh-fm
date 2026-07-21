package fm.iroh.android

import java.util.concurrent.CopyOnWriteArraySet

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
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    fun addListener(listener: () -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: () -> Unit) {
        listeners -= listener
    }

    fun begin(trackId: String) {
        synchronized(lock) {
            states.getOrPut(trackId, ::State).activeReaders += 1
        }
        notifyListeners()
    }

    fun end(trackId: String) {
        synchronized(lock) {
            states[trackId]?.let { it.activeReaders = (it.activeReaders - 1).coerceAtLeast(0) }
        }
        notifyListeners()
    }

    fun update(trackId: String, receivedBytes: Long, totalBytes: Long, reset: Boolean = false) {
        val shouldNotify = synchronized(lock) {
            val state = states.getOrPut(trackId, ::State)
            val normalizedTotal = totalBytes.coerceAtLeast(0L)
            val received = if (reset) receivedBytes else maxOf(state.receivedBytes, receivedBytes)
            state.totalBytes = maxOf(state.totalBytes, normalizedTotal)
            state.receivedBytes = received.coerceAtLeast(0L).let {
                if (state.totalBytes > 0L) it.coerceAtMost(state.totalBytes) else it
            }
            reset || (state.totalBytes > 0L && state.receivedBytes >= state.totalBytes)
        }
        if (shouldNotify) notifyListeners()
    }

    fun snapshot(trackId: String?): Snapshot? = synchronized(lock) {
        trackId?.let(states::get)?.let {
            Snapshot(it.receivedBytes, it.totalBytes, it.activeReaders > 0)
        }
    }

    private fun notifyListeners() {
        listeners.forEach { it() }
    }
}
