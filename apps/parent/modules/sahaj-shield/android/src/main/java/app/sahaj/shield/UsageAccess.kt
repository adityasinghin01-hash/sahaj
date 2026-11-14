package app.sahaj.shield

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process

/**
 * T5 (Phase 1 test) and P9 (Phase 2). PACKAGE_USAGE_STATS is granted by the user in Settings → Usage access,
 * not by a runtime dialog. Only package names are read; nothing is stored or sent.
 */
internal object UsageAccess {
  private const val WINDOW_MS = 10_000L

  fun isGranted(context: Context): Boolean {
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    } else {
      @Suppress("DEPRECATION")
      ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    }
    return if (mode == AppOpsManager.MODE_DEFAULT) {
      context.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED
    } else {
      mode == AppOpsManager.MODE_ALLOWED
    }
  }

  /** Package of the last app that moved to the foreground in the last 10 s, or null if none did. */
  fun foregroundAppNow(context: Context): String? {
    val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return null
    val end = System.currentTimeMillis()
    val events = usm.queryEvents(end - WINDOW_MS, end) ?: return null
    val e = UsageEvents.Event()
    var last: String? = null
    var lastAt = 0L
    while (events.hasNextEvent()) {
      events.getNextEvent(e)
      if (isForeground(e.eventType) && e.timeStamp >= lastAt) {
        last = e.packageName
        lastAt = e.timeStamp
      }
    }
    return last
  }

  /**
   * P9: every package that came to the foreground between [sinceMs] and now (oldest first).
   * Empty if usage access is not granted. Package names only.
   */
  fun foregroundPackagesSince(context: Context, sinceMs: Long): List<String> {
    if (!isGranted(context)) return emptyList()
    val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return emptyList()
    val end = System.currentTimeMillis()
    // A little overlap so an app opened right at the poll boundary is not missed.
    val events = usm.queryEvents((sinceMs - 500).coerceAtLeast(end - 60_000), end) ?: return emptyList()
    val e = UsageEvents.Event()
    val out = mutableListOf<String>()
    while (events.hasNextEvent()) {
      events.getNextEvent(e)
      if (isForeground(e.eventType)) e.packageName?.let { out += it }
    }
    return out
  }

  private fun isForeground(type: Int): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      type == UsageEvents.Event.ACTIVITY_RESUMED
    } else {
      @Suppress("DEPRECATION")
      type == UsageEvents.Event.MOVE_TO_FOREGROUND
    }
}
