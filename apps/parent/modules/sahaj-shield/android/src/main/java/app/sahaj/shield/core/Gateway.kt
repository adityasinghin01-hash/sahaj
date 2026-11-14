package app.sahaj.shield.core

import java.io.File
import java.io.IOException
import java.net.URI

/**
 * Step 3.4 gateway mode: a spare Android phone that is the "1 Sahaj SMS" number for keypad parents.
 * In gateway mode EVERY incoming SMS is forwarded to POST {api}/api/sms/gateway with header
 * x-sahaj-gateway-secret, body {from, body, received_at (ISO), gateway_id}. No rules, no red screen.
 *
 * The server masks the body and hashes the number (packages/shield/src/gateway/sms_gateway.ts), so the
 * raw SMS must reach it. On the phone the raw SMS is held only in the retry queue, encrypted at rest by
 * the [BodyCodec] (Android Keystore AES-GCM on the phone), and dropped after [GatewayForwarder.MAX_AGE_MS].
 * Logs and the recent list never contain the number or the text.
 */
data class GatewayConfig(
  val enabled: Boolean,
  val apiUrl: String,
  val secret: String,
  val gatewayId: String,
) {
  val ready: Boolean get() = enabled && apiUrl.isNotBlank() && secret.length >= GatewayForwarder.MIN_SECRET_LEN

  override fun toString(): String = "GatewayConfig(enabled=$enabled, apiUrl=<set>, secret=<hidden>, gatewayId=$gatewayId)"
}

/** Encrypted storage for the gateway URL + secret (SecureStore-style Keystore AES-GCM on the phone). */
interface GatewayConfigStore {
  fun load(): GatewayConfig?
  fun save(config: GatewayConfig)
  fun clear()
}

class MemoryGatewayConfigStore(private var value: GatewayConfig? = null) : GatewayConfigStore {
  @Synchronized override fun load() = value
  @Synchronized override fun save(config: GatewayConfig) { value = config }
  @Synchronized override fun clear() { value = null }
}

object GatewayPayload {
  fun json(from: String, body: String, receivedAtMs: Long, gatewayId: String): String {
    val w = Json.ObjectWriter()
    w.put("from", from)
    w.put("body", body)
    w.put("received_at", IsoTime.format(receivedAtMs))
    w.put("gateway_id", gatewayId)
    return w.finish()
  }
}

/** Last [max] forwards: time + status only (never the number or the text). [file] = null → memory only. */
class GatewayRecentLog(private val file: File? = null, private val max: Int = 5) {
  data class Entry(val key: String, val atMs: Long, val status: String)

  private val lock = Any()
  private val entries = ArrayList<Entry>()

  init {
    file?.takeIf { it.exists() }?.let { f ->
      runCatching {
        f.readLines().mapNotNull { line ->
          val p = line.split('\t')
          if (p.size == 3 && p[2] in STATUSES) p[1].toLongOrNull()?.let { Entry(p[0], it, p[2]) } else null
        }.takeLast(max).forEach { entries.add(it) }
      }
    }
  }

  fun add(key: String, atMs: Long, status: String) = synchronized(lock) {
    entries.removeAll { it.key == key }
    entries.add(Entry(key, atMs, status))
    while (entries.size > max) entries.removeAt(0)
    save()
  }

  /** Updates the status of a forward still in the list (time stays the receive time). */
  fun update(key: String, status: String) = synchronized(lock) {
    val i = entries.indexOfFirst { it.key == key }
    if (i < 0) return@synchronized
    entries[i] = entries[i].copy(status = status)
    save()
  }

  /** Newest first. */
  fun list(): List<Entry> = synchronized(lock) { entries.reversed() }

  private fun save() {
    val f = file ?: return
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(entries.joinToString("") { "${it.key}\t${it.atMs}\t${it.status}\n" })
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
  }

  companion object {
    const val QUEUED = "queued"
    const val SENT = "sent"
    const val RETRYING = "retrying"
    const val DROPPED = "dropped"
    val STATUSES = setOf(QUEUED, SENT, RETRYING, DROPPED)
  }
}

class GatewayForwarder(
  /** Its own queue directory, with an encrypting [BodyCodec]. */
  private val queue: FileEventQueue,
  private val transport: Transport,
  private val config: () -> GatewayConfig?,
  private val recent: GatewayRecentLog,
  private val clock: () -> Long = System::currentTimeMillis,
  private val backoff: Backoff = Backoff(),
  private val newKey: () -> String = { java.util.UUID.randomUUID().toString() },
) {
  private val lock = Any()

  fun isOn(): Boolean = config()?.ready == true

  /** Queues one SMS for forwarding. False (nothing stored) when gateway mode is off or not configured. */
  fun enqueue(from: String, body: String, receivedAtMs: Long): Boolean {
    val c = config()?.takeIf { it.ready } ?: return false
    val key = newKey()
    val now = clock()
    queue.enqueue(key, GatewayPayload.json(from, body, receivedAtMs, c.gatewayId), now)
    recent.add(key, receivedAtMs, GatewayRecentLog.QUEUED)
    return true
  }

  fun drainDue(): DrainResult = synchronized(lock) {
    val c = config()?.takeIf { it.ready } ?: return DrainResult(0, 0, 0, null)
    val url = c.apiUrl.trimEnd('/') + PATH
    var sent = 0; var retried = 0; var dropped = 0
    for (e in queue.due(clock())) {
      if (clock() - e.createdAtMs > MAX_AGE_MS) {
        queue.remove(e.key); recent.update(e.key, GatewayRecentLog.DROPPED); dropped++
        continue
      }
      val outcome = try {
        classify(transport.post(url, mapOf(HEADER_SECRET to c.secret, "content-type" to "application/json; charset=utf-8"), e.body))
      } catch (_: IOException) {
        Outcome.RETRY
      } catch (_: RuntimeException) {
        Outcome.RETRY
      }
      when (outcome) {
        Outcome.DONE -> { queue.remove(e.key); recent.update(e.key, GatewayRecentLog.SENT); sent++ }
        Outcome.DROP -> { queue.remove(e.key); recent.update(e.key, GatewayRecentLog.DROPPED); dropped++ }
        Outcome.RETRY -> {
          val attempts = e.attempts + 1
          if (attempts >= backoff.maxAttempts) {
            queue.remove(e.key); recent.update(e.key, GatewayRecentLog.DROPPED); dropped++
          } else {
            queue.reschedule(e.key, attempts, clock() + backoff.delayFor(attempts))
            recent.update(e.key, GatewayRecentLog.RETRYING); retried++
          }
        }
      }
    }
    DrainResult(sent, retried, dropped, queue.nextDueAtMs())
  }

  private enum class Outcome { DONE, RETRY, DROP }

  private fun classify(status: Int): Outcome = when {
    status in 200..299 -> Outcome.DONE // includes {ignored:true} for an unregistered parent and replays
    status == 400 || status == 413 || status == 422 -> Outcome.DROP
    else -> Outcome.RETRY // 401 (secret being fixed), 405, 429, 5xx
  }

  companion object {
    const val PATH = "/api/sms/gateway"
    const val HEADER_SECRET = "x-sahaj-gateway-secret"
    /** Same minimum the server requires for SMS_GATEWAY_SECRET. */
    const val MIN_SECRET_LEN = 32
    /** A forward that could not be delivered in 24 h is dropped, so raw SMS never pile up on the phone. */
    const val MAX_AGE_MS = 24L * 60 * 60 * 1000
    private val GATEWAY_ID = Regex("^[A-Za-z0-9._-]{1,64}$")

    /** Returns null when OK, else a short error code for the screen. Never echoes the values. */
    fun validate(apiUrl: String, secret: String, allowHttp: Boolean): String? {
      val uri = runCatching { URI(apiUrl.trim()) }.getOrNull() ?: return "bad_url"
      val scheme = uri.scheme?.lowercase()
      if (uri.host.isNullOrBlank()) return "bad_url"
      if (scheme != "https" && !(allowHttp && scheme == "http")) return "https_required"
      if (secret.length < MIN_SECRET_LEN) return "secret_too_short"
      if (secret.any { it.isWhitespace() || it.code < 0x21 || it.code > 0x7e }) return "secret_bad_chars"
      return null
    }

    fun isValidGatewayId(id: String) = GATEWAY_ID.matches(id)

    /** "gw-" + 12 random hex characters. */
    fun newGatewayId(): String = "gw-" + java.util.UUID.randomUUID().toString().replace("-", "").take(12)
  }
}
