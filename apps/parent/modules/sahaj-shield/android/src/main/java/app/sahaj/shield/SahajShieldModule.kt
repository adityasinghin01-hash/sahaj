package app.sahaj.shield

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import app.sahaj.shield.core.LocalLevel
import app.sahaj.shield.core.LocalVerdict
import app.sahaj.shield.core.Pairing
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

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
    }

    OnDestroy {
      appContext.reactContext?.let { ShieldRuntime.get(it).verdictListeners.remove(verdictListener) }
    }

    Function("getStatus") { status() }

    AsyncFunction("requestSmsPermission") { promise: Promise ->
      ask(promise, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
    }

    /** READ_PHONE_STATE (call active/ended), READ_CONTACTS (saved contact?), POST_NOTIFICATIONS. */
    AsyncFunction("requestPhonePermissions") { promise: Promise ->
      val perms = mutableListOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CONTACTS)
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
     * The CallRedirectionService manifest entry is Phase 2; until it exists Android cannot grant the role,
     * so this resolves "not_declared_yet" without opening the system dialog.
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
    )
  }

  companion object {
    private const val RC_ROLE = 0x5A01
    private const val RC_OVERLAY = 0x5A02
    private const val RC_REDIRECTION = 0x5A03
    private const val TEST_LOG_TAG = "SahajShieldTest"
  }
}
