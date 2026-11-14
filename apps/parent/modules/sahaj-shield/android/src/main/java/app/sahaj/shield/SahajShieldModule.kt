package app.sahaj.shield

import android.Manifest
import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import app.sahaj.shield.core.AfterCallReporter
import app.sahaj.shield.core.Feature
import app.sahaj.shield.core.LocalLevel
import app.sahaj.shield.core.LocalVerdict
import app.sahaj.shield.core.Pairing
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Logcat tag for the debug test screen and the T4/T5/T6 logging services. */
internal const val TEST_LOG_TAG = "SahajShieldTest"

class PairingRecord : Record {
  @Field val baseUrl: String = ""
  @Field val deviceId: String = ""
  @Field val deviceSecret: String = ""
  @Field val childNumber: String = ""
  @Field val childName: String = "Riya"
  @Field val familyId: String = ""
  @Field val parentId: String = ""
}

class SahajShieldModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("E_NO_CONTEXT", "React context is not available", null)

  private val shield get() = ShieldRuntime.get(context)

  private var pendingRole: Promise? = null
  private var pendingOverlay: Promise? = null
  private var pendingRedirection: Promise? = null

  private val verdictListener: (LocalVerdict) -> Unit = { v ->
    sendEvent(
      "onVerdict",
      mapOf(
        "level" to v.level.wire,
        "reasons" to v.reasons,
        "matchedRules" to v.matchedRules,
        "maskedText" to v.maskedText, // already re-masked by the pipeline
        "senderType" to v.senderType,
        "linkDomains" to v.linkDomains,
        "scamType" to v.scamType,
      )
    )
  }

  override fun definition() = ModuleDefinition {
    Name("SahajShield")

    Events("onVerdict")

    OnCreate {
      val rt = shield
      rt.verdictListeners.add(verdictListener)
      rt.ensureCallMonitor()
      if (rt.isPaired()) ShieldForegroundService.startIfAllowed(context)
      // Step 3.2: installed-app scan on app start + every 6 h (both do nothing while the switch is off).
      InstalledApps.schedulePeriodic(context)
      val app = context.applicationContext
      rt.worker.execute { InstalledApps.scanNow(app) }
      // Device status heartbeat: on start + every 6 h (+ on every permission change, below).
      HeartbeatSchedule.schedulePeriodic(context)
      rt.heartbeatNow(force = true)
    }

    OnDestroy {
      appContext.reactContext?.let { ShieldRuntime.get(it).verdictListeners.remove(verdictListener) }
    }

    Function("getStatus") {
      val s = status()
      // Screens call this when they come back from a system settings page: a changed permission → heartbeat.
      shield.heartbeatNow(force = false)
      s
    }

    Function("getServerAddress") { shield.secure.load()?.baseUrl ?: "" }

    // Non-sensitive display choices only. Device credentials remain in SecureStore.
    Function("getUiPreferences") {
      val prefs = context.getSharedPreferences("sahaj_ui", Context.MODE_PRIVATE)
      mapOf("lang" to (prefs.getString("lang", "en") ?: "en"), "size" to (prefs.getString("size", "large") ?: "large"))
    }
    Function("setUiPreferences") { lang: String, size: String ->
      if (lang !in setOf("en", "hi") || size !in setOf("large", "xlarge")) {
        throw CodedException("E_BAD_PREFERENCE", "Unsupported display preference", null)
      }
      context.getSharedPreferences("sahaj_ui", Context.MODE_PRIVATE).edit()
        .putString("lang", lang).putString("size", size).apply()
    }

    AsyncFunction("requestSmsPermission") { promise: Promise ->
      ask(promise, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
    }

    /**
     * READ_PHONE_STATE (call active/ended), READ_CONTACTS (saved contact?), CALL_PHONE (P8 re-places
     * the call after "Phir bhi call karo"), POST_NOTIFICATIONS.
     */
    AsyncFunction("requestPhonePermissions") { promise: Promise ->
      val perms = mutableListOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CONTACTS, Manifest.permission.CALL_PHONE)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) perms += Manifest.permission.POST_NOTIFICATIONS
      ask(promise, *perms.toTypedArray())
    }

    AsyncFunction("requestCallScreeningRole") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { promise.resolve(false); return@AsyncFunction }
      val rm = context.getSystemService(RoleManager::class.java)
      if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) { promise.resolve(false); return@AsyncFunction }
      if (rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) { promise.resolve(true); return@AsyncFunction }
      val activity = appContext.currentActivity ?: run { promise.reject(CodedException("E_NO_ACTIVITY", "No activity", null)); return@AsyncFunction }
      pendingRole?.resolve(false)
      pendingRole = promise
      activity.startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING), RC_ROLE)
    }

    /**
     * ROLE_CALL_REDIRECTION. Resolves "held" | "denied" | "not_declared_yet" | "role_unavailable" | "unsupported_sdk".
     * ShieldCallRedirectionService is declared, so this opens the system role dialog. "not_declared_yet"
     * is kept only as a guard in case the manifest entry is missing from a build.
     */
    AsyncFunction("requestCallRedirectionRole") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { promise.resolve("unsupported_sdk"); return@AsyncFunction }
      val rm = context.getSystemService(RoleManager::class.java)
      if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_CALL_REDIRECTION)) { promise.resolve("role_unavailable"); return@AsyncFunction }
      if (rm.isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION)) { promise.resolve("held"); return@AsyncFunction }
      if (!hasCallRedirectionService()) { promise.resolve("not_declared_yet"); return@AsyncFunction }
      val activity = appContext.currentActivity ?: run { promise.reject(CodedException("E_NO_ACTIVITY", "No activity", null)); return@AsyncFunction }
      pendingRedirection?.resolve("denied")
      pendingRedirection = promise
      activity.startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_CALL_REDIRECTION), RC_REDIRECTION)
    }

    /** T5: PACKAGE_USAGE_STATS is granted in Settings → Usage access. */
    Function("isUsageAccessGranted") { UsageAccess.isGranted(context) }

    /** T5: package name of the app that came to the foreground most recently in the last 10 s, or null. */
    Function("foregroundAppNow") {
      if (!UsageAccess.isGranted(context)) throw CodedException("E_NO_USAGE_ACCESS", "Usage access is not granted", null)
      UsageAccess.foregroundAppNow(context)
    }

    /** T6: Sahaj Maa is enabled in Settings → Notification access. */
    Function("isNotificationAccessGranted") { notificationAccessGranted() }

    /** Setup wizard: Settings → Usage access (P9). Returns which screen opened. */
    Function("openUsageAccessSettings") {
      openFirst(
        "usage_access" to Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS),
        "app_details" to Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)),
      )
    }

    /** Setup wizard: Settings → Notification access (P2/P3). Returns which screen opened. */
    Function("openNotificationAccessSettings") {
      val detail = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
          Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
          ComponentName(context, ShieldNotificationListener::class.java).flattenToString(),
        )
      } else null
      openFirst(
        *listOfNotNull(
          detail?.let { "listener_detail" to it },
          "listener_list" to Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
          "app_details" to Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)),
        ).toTypedArray()
      )
    }

    // ---- Step 3.3 after-call screen ----

    /** The last finished call, without the number: { ended, unsaved, callerType, incoming, registeredBank, durationSeconds }. */
    Function("getLastCall") {
      val c = shield.calls.lastCall()
      if (c == null) mapOf("ended" to false) else mapOf(
        "ended" to true,
        "unsaved" to c.unsaved,
        "callerType" to shield.afterCall.lastCallerType(),
        "incoming" to c.incoming,
        "registeredBank" to (c.incoming == true && c.callerType == "series_1600"),
        "durationSeconds" to (c.durationMs / 1000).toInt(),
        "endedAt" to c.endedAtMs.toDouble(),
      )
    }

    /** "otp_shared" | "claimed_bank" | "no" → voice_report event (nothing for "no"). Returns "sent" | "nothing_sent" | "not_paired". */
    Function("reportAfterCall") { answer: String ->
      val a = AfterCallReporter.Answer.byId(answer) ?: throw CodedException("E_BAD_ANSWER", "Unknown answer", null)
      val rt = shield
      if (a != AfterCallReporter.Answer.NO && !rt.isPaired()) return@Function "not_paired"
      val r = rt.afterCall.report(a)
      rt.debugEvents.add("after-call · ${a.id} → $r")
      r
    }

    // ---- Step 3.4 gateway mode (spare phone). The secret never comes back to JS. ----

    Function("getGatewayStatus") { gatewayStatus() }

    /** Stores URL + secret encrypted on this phone. Returns null on success, else an error code. */
    Function("setGatewayConfig") { apiUrl: String, secret: String ->
      val err = shield.saveGatewayConfig(apiUrl, secret)
      Log.i(TEST_LOG_TAG, "gateway config ${if (err == null) "saved" else "rejected: $err"}")
      err
    }

    Function("setGatewayMode") { on: Boolean ->
      shield.setGatewayMode(on)?.let { throw CodedException("E_GATEWAY", it, null) }
      Log.i(TEST_LOG_TAG, "gateway mode=$on")
      gatewayStatus()
    }

    Function("clearGateway") {
      shield.clearGateway()
      gatewayStatus()
    }

    /** T4/T6: recent debug lines from the redirection and notification services (newest first, memory only). */
    Function("getDebugEvents") { shield.debugEvents.snapshot() }

    /** Debug test screen: writes to logcat with tag "SahajShieldTest". */
    Function("debugLog") { message: String ->
      Log.i(TEST_LOG_TAG, message)
    }

    AsyncFunction("requestOverlayPermission") { promise: Promise ->
      if (shield.alerts.canDrawOverlays()) { promise.resolve(true); return@AsyncFunction }
      val activity = appContext.currentActivity ?: run { promise.reject(CodedException("E_NO_ACTIVITY", "No activity", null)); return@AsyncFunction }
      pendingOverlay?.resolve(false)
      pendingOverlay = promise
      activity.startActivityForResult(
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + context.packageName)),
        RC_OVERLAY,
      )
    }

    OnActivityResult { _, payload ->
      when (payload.requestCode) {
        RC_ROLE -> {
          val held = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
          pendingRole?.resolve(held); pendingRole = null
        }
        RC_OVERLAY -> { pendingOverlay?.resolve(shield.alerts.canDrawOverlays()); pendingOverlay = null }
        RC_REDIRECTION -> { pendingRedirection?.resolve(if (redirectionRoleHeld()) "held" else "denied"); pendingRedirection = null }
      }
      shield.heartbeatNow(force = false)
    }

    Function("openBatteryOptimizationSettings") { KeepAlive.openBatteryOptimization(context) }

    Function("openAutostartSettings") { KeepAlive.openAutostart(context) }

    AsyncFunction("setPairing") { p: PairingRecord ->
      try {
        shield.savePairing(Pairing(p.baseUrl.trim(), p.deviceId.trim(), p.deviceSecret, p.childNumber.trim(), p.childName.trim(), p.familyId, p.parentId))
      } catch (e: IllegalArgumentException) {
        throw CodedException("E_BAD_PAIRING", e.message ?: "invalid pairing", e)
      }
      ShieldForegroundService.startIfAllowed(context)
      true
    }

    // ---- Phase 2 switches (all OFF by default, persisted) ----

    /** { p8_pause_call, p9_bank_app, p2_video_call, p3_apk, installed_apps: boolean, demoScale: number } */
    Function("getFeatures") { shield.features.snapshot() }

    Function("setFeature") { name: String, on: Boolean ->
      val f = Feature.byId(name) ?: throw CodedException("E_BAD_FEATURE", "Unknown feature: $name", null)
      val rt = shield
      rt.features.set(f, on)
      Log.i(TEST_LOG_TAG, "feature ${f.id}=${on}")
      if (f == Feature.INSTALLED_APPS && on) {
        val app = context.applicationContext
        rt.worker.execute { InstalledApps.scanNow(app) }
      }
      rt.features.snapshot()
    }

    /** Divides the P2 10-minute threshold (20 → 30 s). 1 = real time. */
    Function("setDemoScale") { scale: Int ->
      shield.features.setDemoScale(scale)
      shield.features.snapshot()
    }

    /** Feeds fake signals through the same code path. Returns "off" when the switch is off. */
    Function("simulateFeature") { name: String ->
      val f = Feature.byId(name) ?: throw CodedException("E_BAD_FEATURE", "Unknown feature: $name", null)
      val rt = shield
      val r = rt.phase2.simulate(f) { line -> Log.i(TEST_LOG_TAG, line); rt.debugEvents.add(line) }
      rt.debugEvents.add("simulate ${f.id} → $r")
      r
    }

    /** Runs the real installed-app scan now. Returns the number of NEW flags (0 when the switch is off). */
    AsyncFunction("runInstalledAppScan") { promise: Promise ->
      val app = context.applicationContext
      shield.worker.execute { promise.resolve(InstalledApps.scanNow(app)) }
    }

    Function("playWarningLine") { line: Int, drillHandled: Boolean? ->
      shield.alerts.playWarningLine(line, drillHandled, shield.calls.snapshot().callActive)
    }
    Function("stopWarningAudio") { shield.alerts.stopWarningAudio() }

    Function("testRedScreen") {
      val rt = shield
      rt.alerts.showRedScreen(
        LocalVerdict(LocalLevel.RED, listOf("यह सिर्फ़ एक जाँच है। असली खतरा नहीं है।"), listOf("TEST"), "", "unknown", emptyList()),
        rt.calls.snapshot().callActive,
      )
      true
    }
  }

  private fun ask(promise: Promise, vararg perms: String) {
    val pm = appContext.permissions ?: run { promise.reject(CodedException("E_NO_PERMISSIONS", "Permissions module missing", null)); return }
    pm.askForPermissions({ result ->
      val granted = result.values.all { it.status == expo.modules.interfaces.permissions.PermissionsStatus.GRANTED }
      shield.ensureCallMonitor()
      shield.heartbeatNow(force = false)
      promise.resolve(granted)
    }, *perms)
  }

  private fun redirectionRoleHeld(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
    context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION) == true

  @Suppress("DEPRECATION")
  private fun hasCallRedirectionService(): Boolean =
    context.packageManager.queryIntentServices(
      Intent("android.telecom.CallRedirectionService").setPackage(context.packageName), 0,
    ).isNotEmpty()

  private fun notificationAccessGranted(): Boolean = shield.notificationListenerGranted()

  private fun openFirst(vararg tries: Pair<String, Intent>): String {
    for ((name, intent) in tries) {
      try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return name
      } catch (_: Exception) {
        // try the next one
      }
    }
    return "none"
  }

  /** Never includes the secret or the full URL: only whether it is set, the host and the last 5 forwards (time + status). */
  private fun gatewayStatus(): Map<String, Any?> {
    val rt = shield
    val c = rt.gatewayStore.load()
    val host = c?.apiUrl?.let { runCatching { Uri.parse(it).host }.getOrNull() }
    return mapOf(
      "enabled" to (c?.enabled == true),
      "configured" to (c != null),
      "apiHost" to host,
      "gatewayId" to c?.gatewayId,
      "queued" to rt.gatewayQueued(),
      "smsPermission" to (granted(Manifest.permission.RECEIVE_SMS) && granted(Manifest.permission.READ_SMS)),
      "recent" to rt.gatewayRecent.list().map { mapOf("at" to it.atMs.toDouble(), "status" to it.status) },
    )
  }

  private fun granted(p: String) = context.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

  private fun status(): Map<String, Any?> {
    val rt = shield
    val roleHeld = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
      context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
    return mapOf(
      "sms" to (granted(Manifest.permission.RECEIVE_SMS) && granted(Manifest.permission.READ_SMS)),
      "phoneState" to granted(Manifest.permission.READ_PHONE_STATE),
      "contacts" to granted(Manifest.permission.READ_CONTACTS),
      "notifications" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted(Manifest.permission.POST_NOTIFICATIONS)),
      "callScreeningRole" to roleHeld,
      "callRedirectionRole" to redirectionRoleHeld(),
      "overlay" to rt.alerts.canDrawOverlays(),
      "batteryOptimizationIgnored" to KeepAlive.isIgnoringBatteryOptimizations(context),
      "autostartScreenAvailable" to KeepAlive.hasAutostartScreen(context),
      "manufacturer" to KeepAlive.brand(),
      "sdkInt" to Build.VERSION.SDK_INT,
      "paired" to rt.isPaired(),
      "queuedEvents" to rt.queue.size(),
      "rulesVersion" to rt.rulesVersion,
      "rulesEngine" to rt.rulesEngineName,
      "usageAccess" to UsageAccess.isGranted(context),
      "notificationAccess" to notificationAccessGranted(),
      "callPhone" to granted(Manifest.permission.CALL_PHONE),
      "p8NumbersKept" to rt.phase2.numbers.size(System.currentTimeMillis()),
      "p9Polling" to rt.phase2.bankApps.isPolling,
      "p2CallsTracked" to rt.phase2.whatsAppCalls.trackedCount,
      "p6Timing" to rt.phase2.longCalls.isTiming,
      "configSource" to rt.configSource,
      "gatewayMode" to rt.gateway.isOn(),
    )
  }

  companion object {
    private const val RC_ROLE = 0x5A01
    private const val RC_OVERLAY = 0x5A02
    private const val RC_REDIRECTION = 0x5A03
  }
}
