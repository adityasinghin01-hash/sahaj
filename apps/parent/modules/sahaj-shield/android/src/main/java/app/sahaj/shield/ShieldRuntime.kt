package app.sahaj.shield

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import app.sahaj.shield.core.CallStateTracker
import app.sahaj.shield.core.DebugEvents
import app.sahaj.shield.core.EventSender
import app.sahaj.shield.core.FileEventQueue
import app.sahaj.shield.core.LocalVerdict
import app.sahaj.shield.core.Pairing
import app.sahaj.shield.core.RulesEngine
import app.sahaj.shield.core.RulesEngineRegistry
import app.sahaj.shield.core.ShieldPipeline
import app.sahaj.shield.core.Transport
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * One per process. Works without the React Native screen: receivers and services call
 * [ShieldRuntime.get] directly.
 */
internal class ShieldRuntime private constructor(val app: Context) {
  val secure = SecureStore(app)
  val calls = CallStateTracker()
  val queue = FileEventQueue(File(app.noBackupFilesDir, "sahaj_shield/queue"))
  val alerts = AlertController(app, { secure.load() })
  val verdictListeners = CopyOnWriteArrayList<(LocalVerdict) -> Unit>()

  /** Single worker thread for SMS handling and sending, so ordering is simple. */
  val worker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "sahaj-shield").apply { isDaemon = true } }
  private var scheduledDrain: ScheduledFuture<*>? = null

  val rulesJson: String by lazy { readRulesAsset() }
  val rulesVersion: String by lazy { RULES_VERSION.find(rulesJson)?.groupValues?.get(1) ?: "unknown" }
  private val loadedEngine: RulesEngineRegistry.Loaded by lazy {
    RulesEngineRegistry.load(rulesJson).also { l ->
      if (l.error != null) Log.w(TAG, "rules engine not loaded, everything stays GREEN: ${l.error}")
      else Log.i(TAG, "rules engine '${l.name}' loaded, rules v$rulesVersion")
    }
  }
  private val engine: RulesEngine get() = loadedEngine.engine
  /** "json" when the real JsonRulesEngine is running, "none" when rules.json could not be parsed. */
  val rulesEngineName: String get() = loadedEngine.name

  /** T4/T6 debug lines for the test screen. Memory only; no numbers, no message text. */
  val debugEvents = DebugEvents()

  val sender = EventSender(queue, HttpTransport, { secure.load() })

  val pipeline = ShieldPipeline(
    engine = { engine },
    calls = calls,
    queue = queue,
    alerts = alerts,
    identity = { secure.load()?.identity },
    kickSender = { kickSender() },
    onVerdict = { v -> verdictListeners.forEach { runCatching { it(v) } } },
  )

  private val callMonitor = CallStateMonitor(app, calls)

  init {
    calls.addListener { wasP1 ->
      alerts.onCallEnded()
      if (wasP1) Notifications.postAfterCallQuestion(app)
    }
  }

  /** Registers the call-state listener if READ_PHONE_STATE is granted. Safe to call repeatedly. */
  fun ensureCallMonitor() = callMonitor.start()

  /** Sends whatever is due now, then schedules itself for the next retry time. */
  fun kickSender() {
    worker.execute {
      val r = runCatching { sender.drainDue() }.onFailure { Log.w(TAG, "drain failed", it) }.getOrNull()
      val next = r?.nextDueAtMs ?: return@execute
      synchronized(this) {
        scheduledDrain?.cancel(false)
        val delay = (next - System.currentTimeMillis()).coerceAtLeast(1_000)
        scheduledDrain = worker.schedule({ kickSender() }, delay, TimeUnit.MILLISECONDS)
      }
    }
  }

  fun isPaired() = secure.load() != null

  fun savePairing(p: Pairing) {
    val debuggable = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    val url = URL(p.baseUrl)
    require(url.protocol == "https" || (debuggable && url.protocol == "http")) { "baseUrl must be https" }
    require(p.deviceId.isNotBlank() && p.deviceSecret.length >= 16) { "deviceId/deviceSecret missing" }
    secure.save(p)
    kickSender()
  }

  private fun readRulesAsset(): String = try {
    app.assets.open(RULES_ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() }
  } catch (e: Exception) {
    Log.w(TAG, "missing $RULES_ASSET, using placeholder")
    """{ "version": "0" }"""
  }

  companion object {
    const val TAG = "SahajShield"
    const val RULES_ASSET = "shield/rules.json"
    private val RULES_VERSION = Regex(""""version"\s*:\s*"?([^",}\s]+)""")

    @Volatile private var instance: ShieldRuntime? = null

    fun get(context: Context): ShieldRuntime =
      instance ?: synchronized(this) {
        instance ?: ShieldRuntime(context.applicationContext).also { instance = it }
      }
  }
}

/** Plain HttpURLConnection POST; no extra dependency. */
internal object HttpTransport : Transport {
  override fun post(url: String, headers: Map<String, String>, body: String): Int {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 15_000
      conn.readTimeout = 20_000
      conn.doOutput = true
      conn.instanceFollowRedirects = false
      conn.useCaches = false
      headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
      conn.setFixedLengthStreamingMode(bytes.size)
      conn.outputStream.use { it.write(bytes) }
      val code = conn.responseCode
      runCatching { (if (code >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } }
      return code
    } finally {
      conn.disconnect()
    }
  }
}
