package app.sahaj.shield.core

/**
 * In-memory call state. Never stores a phone number, only "saved contact or not" and times.
 * Fed by the CallScreeningService (saved / unsaved for incoming calls) and by the
 * TelephonyCallback / PhoneStateListener (active / ended).
 */
class CallStateTracker(private val clock: () -> Long = System::currentTimeMillis) {
  enum class State { IDLE, RINGING, OFFHOOK }

  data class Snapshot(
    val callActive: Boolean,
    val onCallWithUnsaved: Boolean,
    val callStartedAtMs: Long?,
  )

  fun interface Listener {
    /** [wasP1] = a P1 verdict (OTP SMS during an unsaved call) happened during this call. */
    fun onCallEnded(wasP1: Boolean)
  }

  private val lock = Any()
  private var state = State.IDLE
  private var lastScreenedUnsaved: Boolean? = null
  private var lastScreenedAtMs = 0L
  private var unsaved = false
  private var startedAtMs: Long? = null
  private var p1 = false
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<Listener>()
  private val changeListeners = java.util.concurrent.CopyOnWriteArrayList<(Snapshot) -> Unit>()

  fun addListener(l: Listener) { listeners.add(l) }
  fun removeListener(l: Listener) { listeners.remove(l) }

  /** Phase 2 (P9): called after every call-state change with the new snapshot. */
  fun addChangeListener(l: (Snapshot) -> Unit) { changeListeners.add(l) }

  /**
   * From the CallRedirectionService (P8/P9), just before an outgoing call starts. Uses the same
   * "next call is saved / unsaved" slot as incoming screening, so P9 also covers calls she dials.
   */
  fun onOutgoingDialled(isSavedContact: Boolean) = onIncomingScreened(isSavedContact)

  /** From CallScreeningService, before the phone rings. */
  fun onIncomingScreened(isSavedContact: Boolean) {
    val duringCall = synchronized(lock) {
      lastScreenedUnsaved = !isSavedContact
      lastScreenedAtMs = clock()
      if (state != State.IDLE) unsaved = unsaved || !isSavedContact // call waiting
      state != State.IDLE
    }
    if (duringCall) { val snap = snapshot(); changeListeners.forEach { runCatching { it(snap) } } }
  }

  fun onCallState(newState: State) {
    var ended = false
    var wasP1 = false
    synchronized(lock) {
      val now = clock()
      when (newState) {
        State.RINGING, State.OFFHOOK -> {
          if (state == State.IDLE) {
            startedAtMs = now
            // Only trust a screening result from this call (screening happens just before ringing).
            unsaved = lastScreenedUnsaved == true && now - lastScreenedAtMs < SCREEN_MATCH_WINDOW_MS
            p1 = false
          }
          if (newState == State.OFFHOOK && state == State.RINGING) startedAtMs = now
        }
        State.IDLE -> if (state != State.IDLE) {
          ended = true
          wasP1 = p1
          unsaved = false
          startedAtMs = null
          p1 = false
          lastScreenedUnsaved = null
        }
      }
      state = newState
    }
    if (ended) listeners.forEach { it.onCallEnded(wasP1) }
    val snap = snapshot()
    changeListeners.forEach { runCatching { it(snap) } }
  }

  fun markP1() = synchronized(lock) { if (state != State.IDLE) p1 = true }

  fun snapshot(): Snapshot = synchronized(lock) {
    val active = state != State.IDLE
    Snapshot(active, active && unsaved, if (active) startedAtMs else null)
  }

  companion object {
    const val SCREEN_MATCH_WINDOW_MS = 60_000L
  }
}
