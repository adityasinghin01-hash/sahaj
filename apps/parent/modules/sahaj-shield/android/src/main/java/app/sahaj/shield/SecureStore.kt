package app.sahaj.shield

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.sahaj.shield.core.Pairing
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Pairing values encrypted with an AES-256-GCM key that lives in the Android Keystore
 * (non-exportable). Only ciphertext is written to disk, in noBackupFilesDir so it is never
 * copied by Auto Backup. The device secret never touches disk in plaintext.
 */
internal class SecureStore(context: Context) {
  private val file = File(context.noBackupFilesDir, "sahaj_shield/pairing.bin")

  @Volatile private var cached: Pairing? = null
  @Volatile private var loaded = false

  fun save(p: Pairing) = synchronized(this) {
    val plain = listOf(p.baseUrl, p.deviceId, p.deviceSecret, p.childNumber, p.childName, p.familyId, p.parentId)
      .joinToString("\n") { Base64.encodeToString(it.toByteArray(Charsets.UTF_8), Base64.NO_WRAP) }
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, "pairing.tmp")
    tmp.writeBytes(byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + ct)
    if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    cached = p
    loaded = true
  }

  fun load(): Pairing? = synchronized(this) {
    if (loaded) return cached
    cached = try {
      if (!file.exists()) null else {
        val raw = file.readBytes()
        val ivLen = raw[0].toInt()
        val iv = raw.copyOfRange(1, 1 + ivLen)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        val f = String(cipher.doFinal(raw.copyOfRange(1 + ivLen, raw.size)), Charsets.UTF_8)
          .split("\n").map { String(Base64.decode(it, Base64.NO_WRAP), Charsets.UTF_8) }
        Pairing(f[0], f[1], f[2], f[3], f[4], f[5], f[6])
      }
    } catch (e: Exception) {
      android.util.Log.w(TAG, "pairing unreadable, needs re-pairing: ${e.javaClass.simpleName}")
      null
    }
    loaded = true
    cached
  }

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  companion object {
    private const val ALIAS = "sahaj_shield_pairing_v1"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val TAG = "SahajShield"
  }
}
