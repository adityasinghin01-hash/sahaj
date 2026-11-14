package app.sahaj.shield

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.telecom.TelecomManager
import android.util.Log
import app.sahaj.shield.core.Cancellable
import app.sahaj.shield.core.EventFactory
import app.sahaj.shield.core.FeatureSwitches
import app.sahaj.shield.core.FileFlaggedAppStore
import app.sahaj.shield.core.FlaggedNumberStore
import app.sahaj.shield.core.Phase2Shield
import app.sahaj.shield.core.Scheduler
import app.sahaj.shield.core.fromSignal
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
  val alerts = AlertController(app, { secure.load() }, { a, d -> registerPause(a, d) })
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
    onFlagged = { input, v -> phase2.onFlaggedSms(input, v) },
  )

  private val callMonitor = CallStateMonitor(app, calls)

  // ---- Phase 2 (P8, P9, P2, P3, installed apps). All OFF until setFeature(id, true). ----
  private val shieldDir = File(app.noBackupFilesDir, "sahaj_shield")
  val features = FeatureSwitches(File(shieldDir, "features.properties"))

  /** P9 polling and P2 timers. Separate from [worker] so a slow send never delays a poll. */
  private val watchExecutor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "sahaj-shield-watch").apply { isDaemon = true } }
  private val scheduler = object : Scheduler {
    override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
      val f = watchExecutor.schedule({ runCatching(task).onFailure { Log.w(TAG, "timer failed", it) } }, delayMs, TimeUnit.MILLISECONDS)
      return Cancellable { f.cancel(false) }
    }
    override fun every(periodMs: Long, task: () -> Unit): Cancellable {
      val f = watchExecutor.scheduleWithFixedDelay({ runCatching(task).onFailure { Log.w(TAG, "poll failed", it) } }, 0, periodMs, TimeUnit.MILLISECONDS)
      return Cancellable { f.cancel(false) }
    }
  }

  val phase2 = Phase2Shield(
    switches = features,
    numbers = FlaggedNumberStore(File(shieldDir, "p8_numbers.txt")),
    alerts = alerts,
    events = { kind, rule, ctx -> enqueueSignal(kind, rule, ctx) },
    scheduler = scheduler,
    foreground = { since -> UsageAccess.foregroundPackagesSince(app, since) },
    currentCall = { calls.snapshot() },
    flaggedApps = FileFlaggedAppStore(File(shieldDir, "flagged_apps.txt")),
    selfPackage = app.packageName,
  )

  /** P8 pause notifications (no overlay): token → callbacks, in memory only. */
  private val pendingPauses = java.util.concurrent.ConcurrentHashMap<Int, Pair<() -> Unit, () -> Unit>>()
  private val pauseTokens = java.util.concurrent.atomic.AtomicInteger(1)

  init {
    calls.addListener { wasP1 ->
      alerts.onCallEnded()
      if (wasP1) Notifications.postAfterCallQuestion(app)
    }
    calls.addChangeListener { snap -> phase2.onCallState(snap) }
  }

  private fun registerPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit): Int {
    val t = pauseTokens.getAndIncrement()
    pendingPauses.clear() // only the latest pause screen is live
    pendingPauses[t] = onCallAnyway to onDontCall
    return t
  }

  fun resolvePause(token: Int, callAnyway: Boolean) {
    val p = pendingPauses.remove(token) ?: return
    if (callAnyway) p.first() else p.second()
  }

  /**
   * P8 [Phir bhi call karo]: re-place the same call, unmodified. With CALL_PHONE it is placed
   * directly (TelecomManager.placeCall); without it the dialer opens with the number filled in.
   * The redirection service lets it through once (allow-once).
   */
  fun replaceCall(number: String) {
    val uri = Uri.fromParts("tel", number, null)
    try {
      if (app.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
        app.getSystemService(TelecomManager::class.java)?.placeCall(uri, null)
      } else {
        app.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    } catch (e: Exception) {
      Log.w(TAG, "re-place failed: ${e.javaClass.simpleName}")
    }
  }

  /** Phase 2 signal → masked event → queue. Not paired = nothing to send (the red screen already showed). */
  private fun enqueueSignal(kind: String, ruleId: String, context: Map<String, Any>) {
    val id = secure.load()?.identity ?: return
    val now = System.currentTimeMillis()
    val event = EventFactory.fromSignal(kind, ruleId, context, id, java.util.UUID.randomUUID().toString(), now)
    worker.execute {
      runCatching { queue.enqueue(event.idempotencyKey, event.toJson(), now) }.onFailure { Log.w(TAG, "enqueue failed", it) }
      kickSender()
    }
    debugEvents.add("phase2 event · kind=$kind · rule=$ruleId")
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
