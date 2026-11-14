package app.sahaj.shield

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/** Staying alive on Indian-market phones. All best effort: OEMs change these screens often. */
internal object KeepAlive {
  /** Known autostart / background-start screens. The plugin adds matching <queries> entries. */
  val AUTOSTART = listOf(
    "xiaomi" to ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
    "oppo" to ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
    "oppo" to ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
    "oppo" to ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
    "realme" to ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
    "realme" to ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
    "vivo" to ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
    "vivo" to ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
    "vivo" to ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
    "oneplus" to ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
  )

  fun brand(): String = (Build.MANUFACTURER ?: "").lowercase().let { m ->
    when {
      m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> "xiaomi"
      m.contains("oppo") -> "oppo"
      m.contains("realme") -> "realme"
      m.contains("vivo") || m.contains("iqoo") -> "vivo"
      m.contains("oneplus") -> "oneplus"
      else -> m
    }
  }

  fun isIgnoringBatteryOptimizations(ctx: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
      ctx.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(ctx.packageName) == true

  fun hasAutostartScreen(ctx: Context): Boolean = autostartIntents(ctx).isNotEmpty()

  private fun autostartIntents(ctx: Context): List<Intent> {
    val b = brand()
    return AUTOSTART.filter { it.first == b }.map { Intent().setComponent(it.second) }
      .filter { it.resolveActivity(ctx.packageManager) != null }
  }

  /**
   * Asks for the battery-optimisation exemption directly; falls back to the system list.
   * Returns which screen opened.
   */
  @SuppressLint("BatteryLife")
  fun openBatteryOptimization(ctx: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return "not_needed"
    val tries = listOf(
      "request_exemption" to Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName)),
      "optimization_list" to Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
      "app_details" to appDetails(ctx),
    )
    return startFirst(ctx, tries)
  }

  fun openAutostart(ctx: Context): String {
    val tries = autostartIntents(ctx).map { "autostart:" + it.component!!.packageName to it } + ("app_details" to appDetails(ctx))
    return startFirst(ctx, tries)
  }

  private fun appDetails(ctx: Context) =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.packageName))

  private fun startFirst(ctx: Context, tries: List<Pair<String, Intent>>): String {
    for ((name, intent) in tries) {
      try {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return name
      } catch (_: Exception) {
        // try the next one
      }
    }
    return "none"
  }
}
