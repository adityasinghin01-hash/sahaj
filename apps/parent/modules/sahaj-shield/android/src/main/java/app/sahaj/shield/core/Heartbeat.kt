package app.sahaj.shield.core

import java.io.File

/**
 * Device status heartbeat (Core 3 Phase 3). POST {api}/api/shield/heartbeat, signed exactly like
 * events (Signer: x-shield-device / x-shield-ts / x-shield-sig over `${ts}.${body}`), through the
 * same FileEventQueue + EventSender retry logic. Only yes/no protection flags and versions: no
 * numbers, no text.
 */
data class Protections(
  val sms: Boolean,
  val screening: Boolean,
  val redirection: Boolean,
  val usage: Boolean,
  val notifications: Boolean,
  val overlay: Boolean,
) {
  /** Same keys as public.shield_devices.protections (migration 20261114000100_shield.sql). */
  fun toMap(): Map<String, Any> = linkedMapOf(
    "sms" to sms,
    "screening" to screening,
    "redirection" to redirection,
    "usage" to usage,
    "notifications" to notifications,
    "overlay" to overlay,
  )

  /** Stable one-line form for change detection, e.g. "sms=1,screening=0,…". */
  fun fingerprint(): String = toMap().entries.joinToString(",") { "${it.key}=${if (it.value == true) 1 else 0}" }
}

data class HeartbeatPayload(
  val deviceId: String,
  val protections: Protections,
  val androidVersion: String,
  val appVersion: String,
  val sentAtMs: Long,
) {
  /** {device_id, protections:{sms,screening,redirection,usage,notifications,overlay}, android_version, app_version, sent_at} */
  fun toJson(): String {
    val w = Json.ObjectWriter()
    w.put("device_id", deviceId)
    w.putFlat("protections", protections.toMap())
    w.put("android_version", clean(androidVersion))
    w.put("app_version", clean(appVersion))
    w.put("sent_at", IsoTime.format(sentAtMs))
    return w.finish()
  }

  /** Version strings only: letters, digits, '.', '-', '_' (max 32). */
  private fun clean(v: String) = v.filter { it.isLetterOrDigit() || it in "._-" }.take(32).ifEmpty { "unknown" }
}

/**
 * Decides when to queue a heartbeat: on start ([force]), whenever the protections change, and from
 * the 6-hourly worker ([force]). Only the newest heartbeat is kept in [queue] (older unsent ones are
 * replaced). [lastFile] remembers the last queued fingerprint across restarts.
 */
class HeartbeatMonitor(
  private val queue: FileEventQueue,
  private val pairing: () -> Pairing?,
  private val kick: () -> Unit,
  private val lastFile: File? = null,
  private val clock: () -> Long = System::currentTimeMillis,
  private val newKey: () -> String = { java.util.UUID.randomUUID().toString() },
) {
  private val lock = Any()
  private var last: String? = lastFile?.takeIf { it.exists() }?.let { runCatching { it.readText().trim() }.getOrNull() }

  /**
   * Returns true when a heartbeat was queued. Not paired → false (nothing to sign with).
   */
  fun onStatus(p: Protections, androidVersion: String, appVersion: String, force: Boolean): Boolean {
    val pairing = pairing() ?: return false
    val fp = p.fingerprint()
    synchronized(lock) {
      if (!force && fp == last) return false
      val now = clock()
      val body = HeartbeatPayload(pairing.deviceId, p, androidVersion, appVersion, now).toJson()
      queue.all().forEach { queue.remove(it.key) }
      queue.enqueue(newKey(), body, now)
      last = fp
      lastFile?.let { f -> runCatching { f.parentFile?.mkdirs(); f.writeText(fp) } }
    }
    kick()
    return true
  }

  companion object {
    const val PERIOD_HOURS = 6L
  }
}
