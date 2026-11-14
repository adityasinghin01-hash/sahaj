package app.sahaj.shield

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.sahaj.shield.core.BodyCodec
import app.sahaj.shield.core.GatewayConfig
import app.sahaj.shield.core.GatewayConfigStore
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with a non-exportable Android Keystore key, the same scheme SecureStore uses for the
 * pairing secret. Output = base64(ivLen | iv | ciphertext). Used for the gateway config and for the
 * gateway retry queue (raw SMS), so neither is ever on disk in plaintext.
 */
internal class KeystoreCipher(private val alias: String) : BodyCodec {
  fun encrypt(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + cipher.doFinal(plain)
  }

  fun decrypt(raw: ByteArray): ByteArray {
    val ivLen = raw[0].toInt()
    val iv = raw.copyOfRange(1, 1 + ivLen)
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
    return cipher.doFinal(raw.copyOfRange(1 + ivLen, raw.size))
  }

  override fun encode(plain: String): String = Base64.encodeToString(encrypt(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  override fun decode(stored: String): String = String(decrypt(Base64.decode(stored, Base64.NO_WRAP)), Charsets.UTF_8)

  @Synchronized
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  companion object {
    private const val TRANSFORM = "AES/GCM/NoPadding"
  }
}

/**
 * Step 3.4: gateway URL + secret typed by the operator on the hidden gateway screen.
 * Encrypted with a Keystore key in noBackupFilesDir (never in .env, app.json or the JS bundle; never
 * returned to JS: the screen only sees "configured" and the host name).
 */
internal class GatewayStore(context: Context) : GatewayConfigStore {
  private val file = File(context.noBackupFilesDir, "sahaj_shield/gateway.bin")
  private val cipher = KeystoreCipher("sahaj_shield_gateway_v1")

  @Volatile private var cached: GatewayConfig? = null
  @Volatile private var loaded = false

  override fun load(): GatewayConfig? = synchronized(this) {
    if (loaded) return cached
    cached = try {
      if (!file.exists()) null else {
        val f = String(cipher.decrypt(file.readBytes()), Charsets.UTF_8).split("\n")
          .map { String(Base64.decode(it, Base64.NO_WRAP), Charsets.UTF_8) }
        GatewayConfig(enabled = f[0] == "1", apiUrl = f[1], secret = f[2], gatewayId = f[3])
      }
    } catch (e: Exception) {
      android.util.Log.w(ShieldRuntime.TAG, "gateway config unreadable, needs setup again: ${e.javaClass.simpleName}")
      null
    }
    loaded = true
    cached
  }

  override fun save(config: GatewayConfig) = synchronized(this) {
    val plain = listOf(if (config.enabled) "1" else "0", config.apiUrl, config.secret, config.gatewayId)
      .joinToString("\n") { Base64.encodeToString(it.toByteArray(Charsets.UTF_8), Base64.NO_WRAP) }
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, "gateway.tmp")
    tmp.writeBytes(cipher.encrypt(plain.toByteArray(Charsets.UTF_8)))
    if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    cached = config
    loaded = true
  }

  override fun clear() = synchronized(this) {
    file.delete()
    cached = null
    loaded = true
  }
}
