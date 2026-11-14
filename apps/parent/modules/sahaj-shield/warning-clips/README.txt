Drop the ten recorded Hindi MP3 clips in this folder, using exactly these Android raw resource filenames.
Gradle stages only these MP3 files into generated Android raw resources before the module builds.
Keep README.txt here: uppercase README.txt is not a valid Android raw resource name.

shield_line_1.mp3
shield_line_2.mp3
shield_line_3.mp3
shield_line_4.mp3
shield_line_5.mp3
shield_line_6.mp3
shield_line_7.mp3
shield_line_8.mp3
shield_line_9a.mp3
shield_line_9b.mp3

9a: drill handled safely (praise).
9b: drill not handled safely (gentle correction).
Missing files are supported: runtime lookup returns 0 and the same Hindi warning uses TTS.
A failed player also falls back to TTS. No generated placeholder is played first.
The old shield_warning_hi.wav is unused by warning playback.
P9 banking-app wording has no corresponding numbered clip and continues to use its existing TTS.
Lines 1, 3, 4 and 5 are connected to existing local warnings. The native playWarningLine port supports all nine lines, with an explicit boolean drill outcome for line 9.
