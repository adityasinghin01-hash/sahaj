# Keep rules applied to the Sahaj Maa release APK (R8 shrinks release builds).
#
# Crash on launch without these (Galaxy A16, Android 16, 15 Nov):
#   java.lang.NoSuchMethodException: androidx.work.impl.WorkDatabase_Impl.<init> []
# Room creates the generated database class by reflection, so R8 must keep its no-arg constructor.
-keep class androidx.work.impl.WorkDatabase_Impl { <init>(...); }
-keep class * extends androidx.room.RoomDatabase { <init>(...); }
-keep class androidx.work.** { *; }
-dontwarn androidx.work.**

# Shield runs from the manifest (receivers, services, screening) and parses rules.json with
# kotlinx.serialization; keep the whole module so no reflective entry point is stripped.
-keep class app.sahaj.shield.** { *; }
-keepclassmembers class app.sahaj.shield.** { *** Companion; kotlinx.serialization.KSerializer serializer(...); }
-keepattributes *Annotation*, InnerClasses, Signature
-dontnote kotlinx.serialization.**
