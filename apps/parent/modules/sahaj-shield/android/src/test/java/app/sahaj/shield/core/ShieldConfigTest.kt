package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Part A: thresholds and package lists come from rules.json; each field falls back on its own. */
class ShieldConfigTest {
  private fun realRules(): String {
    val path = System.getProperty("sahaj.rulesJson") ?: error("sahaj.rulesJson not set")
    return File(path).readText()
  }

  @Test fun readsEveryFieldFromTheRealRulesJson() {
    val parsed = ShieldConfig.fromRulesJson(realRules())
    assertTrue("fallbacks: ${parsed.fallbacks}", parsed.complete)
    val c = parsed.config
    assertEquals(600_000L, c.p2MinDurationMs)
    assertEquals(2_000L, c.p9PollMs)
    assertEquals(24L * 3_600_000L, c.p3RecentInstallMs)
    assertEquals(setOf("com.android.vending"), c.p3PlayStoreInstallers)
    assertEquals(24L * 3_600_000L, c.p8KeepMs)
    assertEquals(300, c.p8MaxNumbers)
    assertTrue("com.phonepe.app" in c.p9Packages)
    assertTrue("com.anydesk.anydeskandroid" in c.p4Packages)
    // rules.json lists differ from the old constants, so the values really come from the file.
    assertTrue("us.zoom.videomeetings" in c.p4Packages)
    assertFalse("us.zoom.videomeetings" in AppLists.REMOTE_CONTROL)
    assertEquals(listOf("series_1600", "series_140", "mobile_10", "international"), c.callerRules.map { it.first })
  }

  @Test fun brokenOrPlaceholderJsonFallsBackToTheOldConstants() {
    for (bad in listOf(null, "", "{ not json", """{ "version": "0" }""", "[]")) {
      val p = ShieldConfig.fromRulesJson(bad)
      assertFalse(p.complete)
      assertEquals(AppLists.BANKING_UPI, p.config.p9Packages)
      assertEquals(AppLists.REMOTE_CONTROL, p.config.p4Packages)
      assertEquals(AppLists.PLAY_STORE_INSTALLERS, p.config.p3PlayStoreInstallers)
      assertEquals(ShieldConfig.DEFAULT_P2_MIN_DURATION_MS, p.config.p2MinDurationMs)
      assertEquals(ShieldConfig.DEFAULT_P9_POLL_MS, p.config.p9PollMs)
      assertEquals(FlaggedNumberStore.TTL_MS, p.config.p8KeepMs)
      assertEquals(ShieldConfig.DEFAULT_P8_MAX_NUMBERS, p.config.p8MaxNumbers)
    }
  }

  @Test fun eachFieldFallsBackOnItsOwn_andFallbacksNameOnlyFields() {
    val json = """
      { "patterns": {
          "P2": { "min_duration_ms": 30000 },
          "P9": { "packages": ["com.example.bank"], "poll_ms": "fast" },
          "P3": { "play_store_installers": ["com.android.vending", "not a package!"], "recent_install_hours": 12 },
          "P4": { "packages": [] },
          "P8": { "keep_hours": -1, "max_numbers": 50 }
        },
        "caller": { "rules": [ { "type": "series_1600", "pattern": "^1600[0-9]{6}$" } ] } }
    """.trimIndent()
    val p = ShieldConfig.fromRulesJson(json)
    assertEquals(30_000L, p.config.p2MinDurationMs)
    assertEquals(setOf("com.example.bank"), p.config.p9Packages)
    assertEquals(ShieldConfig.DEFAULT_P9_POLL_MS, p.config.p9PollMs) // string → fallback
    assertEquals(AppLists.PLAY_STORE_INSTALLERS, p.config.p3PlayStoreInstallers) // one bad entry → whole list falls back
    assertEquals(12L * 3_600_000L, p.config.p3RecentInstallMs)
    assertEquals(AppLists.REMOTE_CONTROL, p.config.p4Packages) // empty → fallback
    assertEquals(FlaggedNumberStore.TTL_MS, p.config.p8KeepMs) // negative → fallback
    assertEquals(50, p.config.p8MaxNumbers)
    assertEquals(listOf("P9.poll_ms", "P3.play_store_installers", "P4.packages", "P8.keep_hours"), p.fallbacks)
    // The log line uses only these names: no values, no file text.
    assertTrue(p.fallbacks.none { it.contains("example") || it.contains("not a package") })
  }

  @Test fun callerTypeFromRulesJsonPatterns() {
    val c = ShieldConfig.fromRulesJson(realRules()).config
    assertEquals("series_1600", c.callerType("1600000001", saved = false))
    assertEquals("series_1600", c.callerType("+91 1600-000-001", saved = false))
    assertEquals("mobile_10", c.callerType("+919000000001", saved = false))
    assertEquals("mobile_10", c.callerType("+91 90000 00002", saved = false))
    assertEquals("saved_contact", c.callerType("+919000000003", saved = true))
    assertEquals("unknown", c.callerType(null, saved = false))
    assertEquals("unknown", c.callerType("121", saved = false))
    // Fallback patterns give the same answers.
    assertEquals("series_1600", ShieldConfig.DEFAULT.callerType("1600000001", false))
    assertEquals("mobile_10", ShieldConfig.DEFAULT.callerType("+919000000004", false))
  }

  @Test fun phase2UsesTheConfigLists() {
    val cfg = ShieldConfig(p4Packages = setOf("com.example.remote"), p9Packages = setOf("com.example.bank"), p9PollMs = 5_000L, p2MinDurationMs = 60_000L)
    val sw = FeatureSwitches().also { s -> Feature.entries.forEach { s.set(it, true) } }
    val sent = mutableListOf<String>()
    val alerts = object : Phase2Alerts {
      override fun showCallPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit) {}
      override fun showWarning(warning: Warning, callActive: Boolean) {}
    }
    val periods = mutableListOf<Long>()
    val delays = mutableListOf<Long>()
    val sched = object : Scheduler {
      override fun schedule(delayMs: Long, task: () -> Unit): Cancellable { delays += delayMs; return Cancellable { } }
      override fun every(periodMs: Long, task: () -> Unit): Cancellable { periods += periodMs; return Cancellable { } }
    }
    val p = Phase2Shield(
      sw, FlaggedNumberStore(), alerts, { k, _, c -> sent += "$k:${c["package"]}" }, sched, { emptyList() },
      { CallStateTracker.Snapshot(false, false, null) }, FileFlaggedAppStore(), "app.sahaj.parent", { 0L }, cfg,
    )
    val flags = p.installed.scan(listOf(
      InstalledApp("com.example.remote", "com.android.vending", -90L * 86_400_000L, false),
      InstalledApp("com.anydesk.anydeskandroid", "com.android.vending", -90L * 86_400_000L, false), // not in this config
    ))
    assertEquals(listOf("com.example.remote"), flags.map { it.packageName })
    p.onCallState(CallStateTracker.Snapshot(true, true, 0L))
    assertEquals(listOf(5_000L), periods)
    p.bankApps.tick(override = listOf("com.phonepe.app")) // not in this config
    p.bankApps.tick(override = listOf("com.example.bank"))
    assertEquals(listOf("install:com.example.remote", "app_open:com.example.bank"), sent)
    assertEquals(60_000L, p.whatsAppCalls.thresholdMs())
  }

  @Test fun pluginFallbackListsMatchKotlinFallbacks() {
    val path = System.getProperty("sahaj.pluginJs") ?: error("sahaj.pluginJs not set")
    val js = File(path).readText()
    fun list(name: String) = Regex("'([a-zA-Z0-9_.]+)'").findAll(js.substringAfter("const $name = [").substringBefore("];"))
      .map { it.groupValues[1] }.toSet()
    assertEquals(AppLists.REMOTE_CONTROL, list("REMOTE_CONTROL_PACKAGES"))
    assertEquals(AppLists.BANKING_UPI, list("BANKING_UPI_PACKAGES"))
    // The plugin reads the live P4 + P9 lists from rules.json for <queries>.
    assertTrue(js.contains("rulesQueryPackages(rulesFile)"))
    assertTrue(js.contains("pick('P4', REMOTE_CONTROL_PACKAGES)") && js.contains("pick('P9', BANKING_UPI_PACKAGES)"))
  }
}
