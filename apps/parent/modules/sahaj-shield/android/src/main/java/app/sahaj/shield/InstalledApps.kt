package app.sahaj.shield

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.sahaj.shield.core.Feature
import app.sahaj.shield.core.InstalledApp
import java.util.concurrent.TimeUnit

/**
 * Step 3.2: reads installed packages + install source. On Android 11+ only packages visible through
 * <queries> are returned: the remote-control apps by name, and apps with a launcher icon
 * (app.plugin.js). We do not ask for QUERY_ALL_PACKAGES.
 */
internal object InstalledApps {
  private const val WORK_NAME = "sahaj_shield_installed_apps"

  @Suppress("DEPRECATION")
  fun list(context: Context): List<InstalledApp> {
    val pm = context.packageManager
    val pkgs: List<PackageInfo> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(0))
    } else {
      pm.getInstalledPackages(0)
    }
    return pkgs.map { p ->
      val flags = p.applicationInfo?.flags ?: 0
      InstalledApp(
        packageName = p.packageName,
        installer = installer(pm, p.packageName),
        firstInstallMs = p.firstInstallTime,
        isSystem = (flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0,
      )
    }
  }

  @Suppress("DEPRECATION")
  private fun installer(pm: PackageManager, pkg: String): String? = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val info = pm.getInstallSourceInfo(pkg)
      info.installingPackageName ?: info.initiatingPackageName
    } else {
      pm.getInstallerPackageName(pkg)
    }
  } catch (e: Exception) {
    null
  }

  /** Real scan through the same code as the simulate button. Returns how many new flags. */
  fun scanNow(context: Context): Int {
    val rt = ShieldRuntime.get(context)
    if (!rt.features.isOn(Feature.INSTALLED_APPS)) return 0
    return try {
      val flags = rt.phase2.installed.scan(list(context))
      rt.debugEvents.add("installed-apps scan · new_flags=${flags.size}")
      flags.size
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "installed-app scan failed: ${e.javaClass.simpleName}")
      0
    }
  }

  /** Every 6 h. KEEP so app restarts do not reset the period. */
  fun schedulePeriodic(context: Context) {
    runCatching {
      val req = PeriodicWorkRequest.Builder(InstalledAppsWorker::class.java, 6, TimeUnit.HOURS).build()
      WorkManager.getInstance(context.applicationContext)
        .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }.onFailure { Log.w(ShieldRuntime.TAG, "could not schedule installed-app scan: ${it.javaClass.simpleName}") }
  }
}

class InstalledAppsWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    InstalledApps.scanNow(applicationContext)
    return Result.success()
  }
}
