package app.sahaj.shield.core

import java.io.IOException

/** Values from setPairing(). Stored encrypted on the phone (see SecureStore). */
data class Pairing(
  val baseUrl: String,
  val deviceId: String,
  val deviceSecret: String,
  val childNumber: String,
  val childName: String = "Riya",
  val familyId: String = "",
  val parentId: String = "",
) {
  val identity get() = EventIdentity(familyId, parentId, deviceId)
}

/** HTTP POST. Returns the status code; throws IOException on network failure. */
fun interface Transport {
  @Throws(IOException::class)
  fun post(url: String, headers: Map<String, String>, body: String): Int
}

/** Exponential backoff: 30 s, 60 s, 2 min … capped at 6 h. Gives up after [maxAttempts]. */
data class Backoff(
  val baseMs: Long = 30_000,
  val maxMs: Long = 6 * 60 * 60 * 1000L,
  val maxAttempts: Int = 20,
) {
  fun delayFor(attempts: Int): Long {
    val shift = (attempts - 1).coerceIn(0, 30)
    val d = baseMs shl shift
    return if (d <= 0 || d > maxMs) maxMs else d
  }
}

data class DrainResult(val sent: Int, val retried: Int, val dropped: Int, val nextDueAtMs: Long?)

class EventSender(
  private val queue: FileEventQueue,
  private val transport: Transport,
  private val pairing: () -> Pairing?,
  private val clock: () -> Long = System::currentTimeMillis,
  private val backoff: Backoff = Backoff(),
) {
  private val lock = Any()

  /** Sends every due event once. Safe to call from any thread; calls are serialised. */
  fun drainDue(): DrainResult = synchronized(lock) {
    val p = pairing() ?: return DrainResult(0, 0, 0, queue.nextDueAtMs())
    val url = p.baseUrl.trimEnd('/') + PATH
    var sent = 0; var retried = 0; var dropped = 0
    for (e in queue.due(clock())) {
      val ts = clock()
      val outcome = try {
        classify(transport.post(url, Signer.headers(p.deviceId, p.deviceSecret, ts, e.body) + JSON_HEADER, e.body))
      } catch (_: IOException) {
        Outcome.RETRY
      } catch (_: RuntimeException) {
        Outcome.RETRY
      }
      when (outcome) {
        Outcome.DONE -> { queue.remove(e.key); sent++ }
        Outcome.DROP -> { queue.remove(e.key); dropped++ }
        Outcome.RETRY -> {
          val attempts = e.attempts + 1
          if (attempts >= backoff.maxAttempts) {
            queue.remove(e.key); dropped++
          } else {
            queue.reschedule(e.key, attempts, clock() + backoff.delayFor(attempts)); retried++
          }
        }
      }
    }
    DrainResult(sent, retried, dropped, queue.nextDueAtMs())
  }

  private enum class Outcome { DONE, RETRY, DROP }

  private fun classify(status: Int): Outcome = when {
    status in 200..299 -> Outcome.DONE
    status == 409 -> Outcome.DONE // idempotency_key already seen by the server
    status == 400 || status == 413 || status == 422 -> Outcome.DROP // will never be accepted
    else -> Outcome.RETRY // 401/403 (clock skew, pairing), 408, 429, 5xx
  }

  companion object {
    const val PATH = "/api/shield/event"
    private val JSON_HEADER = mapOf("content-type" to "application/json; charset=utf-8")
  }
}
