package app.sahaj.shield.core

import java.io.File
import java.util.Properties

/**
 * Phase 2 features. Every one is OFF until its phone test passes (T4 → P8, T5 → P9, T6 → P2/P3)
 * and someone turns it on with setFeature(id, true). [id] is the name used by the JS API.
 */
enum class Feature(val id: String) {
  /** P8: pause an outgoing call to a number seen in a flagged SMS (CallRedirectionService). */
  P8_PAUSE_CALL("p8_pause_call"),
  /** P9: banking/UPI app comes to the foreground during a call with an unsaved number (Usage access). */
  P9_BANK_APP("p9_bank_app"),
  /** P2: long WhatsApp call with an unsaved contact (notification listener). */
  P2_VIDEO_CALL("p2_video_call"),
  /** P3: WhatsApp attachment ending in .apk (notification listener). */
  P3_APK("p3_apk"),
  /** P4/P3: remote-control apps installed, or an app installed outside the Play Store in the last 24 h. */
  INSTALLED_APPS("installed_apps");

  companion object {
    fun byId(id: String): Feature? = entries.firstOrNull { it.id == id }
  }
}

/**
 * On/off per [Feature] plus the demo time scale, persisted in a small properties file
 * (noBackupFilesDir on the phone). [file] = null keeps everything in memory (tests).
 * Defaults: every feature off, demoScale 1.
 */
class FeatureSwitches(private val file: File? = null) {
  fun interface Listener { fun onChanged(feature: Feature?, on: Boolean) }

  private val lock = Any()
  private val on = mutableSetOf<Feature>()
  private var scale = 1
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<Listener>()

  init { load() }

  fun addListener(l: Listener) { listeners.add(l) }

  fun isOn(f: Feature): Boolean = synchronized(lock) { f in on }

  fun set(f: Feature, value: Boolean) {
    synchronized(lock) {
      if (value) on.add(f) else on.remove(f)
      save()
    }
    listeners.forEach { runCatching { it.onChanged(f, value) } }
  }

  /** Divides the P2 10-minute threshold (e.g. 20 → 30 s) so the demo does not take 10 minutes. */
  val demoScale: Int get() = synchronized(lock) { scale }

  fun setDemoScale(value: Int) {
    synchronized(lock) {
      scale = value.coerceIn(1, MAX_DEMO_SCALE)
      save()
    }
    listeners.forEach { runCatching { it.onChanged(null, false) } }
  }

  /** For the JS API: { p8_pause_call: false, …, demoScale: 1 }. */
  fun snapshot(): Map<String, Any> = synchronized(lock) {
    val m = linkedMapOf<String, Any>()
    Feature.entries.forEach { m[it.id] = it in on }
    m["demoScale"] = scale
    m
  }

  private fun load() {
    val f = file ?: return
    if (!f.exists()) return
    runCatching {
      val p = Properties()
      f.inputStream().use { p.load(it) }
      Feature.entries.forEach { if (p.getProperty(it.id) == "true") on.add(it) }
      scale = (p.getProperty(KEY_SCALE)?.toIntOrNull() ?: 1).coerceIn(1, MAX_DEMO_SCALE)
    }
  }

  private fun save() {
    val f = file ?: return
    val p = Properties()
    Feature.entries.forEach { p.setProperty(it.id, (it in on).toString()) }
    p.setProperty(KEY_SCALE, scale.toString())
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.outputStream().use { p.store(it, "sahaj shield phase 2 switches") }
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
  }

  companion object {
    private const val KEY_SCALE = "demoScale"
    const val MAX_DEMO_SCALE = 600
  }
}
