package app.sahaj.shield.core

import org.junit.Assert.*
import org.junit.Test

class WarningAudioTest {
  @Test fun allEightOrdinaryLinesResolveTheirOwnClip() {
    (1..8).forEach { line ->
      val choice = WarningAudio.select(line, "same Hindi line") { name ->
        assertEquals("shield_line_$line", name); 42
      }
      assertEquals(42, choice.resourceId)
      assertEquals("same Hindi line", choice.speech)
    }
  }
  @Test fun missingRecordingFallsBackToTheSameSpeech() {
    val choice = WarningAudio.select(4, Warning.P2_VIDEO_CALL.speech) { 0 }
    assertEquals(0, choice.resourceId)
    assertEquals(Warning.P2_VIDEO_CALL.speech, choice.speech)
  }
  @Test fun successfulDrillPicksPraise() {
    assertEquals("shield_line_9a", WarningAudio.select(9, "praise", true) { 8 }.resourceName)
    assertTrue(WarningAudio.speech(9, true).contains("सही"))
  }
  @Test fun unsuccessfulDrillPicksCorrection() {
    val choice = WarningAudio.select(9, "gentle correction", false) { if (it == "shield_line_9b") 7 else 0 }
    assertEquals("shield_line_9b", choice.resourceName)
    assertEquals(7, choice.resourceId)
    assertTrue(WarningAudio.speech(9, false).contains("कोई बात नहीं"))
  }
  @Test fun bothMissingDrillRecordingsKeepOutcomeSpecificTts() {
    listOf(true, false).forEach { handled ->
      val speech = WarningAudio.speech(9, handled)
      val choice = WarningAudio.select(9, speech, handled) { 0 }
      assertEquals(0, choice.resourceId); assertEquals(speech, choice.speech)
    }
    assertNotEquals(WarningAudio.speech(9, true), WarningAudio.speech(9, false))
  }
  @Test fun allExistingWarningsMapWithoutUsingAnUnrelatedClip() {
    assertEquals(3, WarningAudio.lineFor(Warning.P8_PAUSE))
    assertEquals(4, WarningAudio.lineFor(Warning.P2_VIDEO_CALL))
    assertEquals(5, WarningAudio.lineFor(Warning.P3_APK))
    assertEquals(5, WarningAudio.lineFor(Warning.INSTALLED_APP))
    assertNull(WarningAudio.lineFor(Warning.P9_BANK_APP))
    var lookedUp = false
    assertEquals(0, WarningAudio.select(null, Warning.P9_BANK_APP.speech) { lookedUp = true; 10 }.resourceId)
    assertFalse(lookedUp)
  }
  @Test(expected = IllegalArgumentException::class) fun drillRequiresAnExplicitOutcome() {
    WarningAudio.resourceName(9)
  }
  @Test(expected = IllegalArgumentException::class) fun invalidLineRejected() {
    WarningAudio.resourceName(10)
  }
}
