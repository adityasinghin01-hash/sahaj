package app.sahaj.shield.core

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Request signing per SHIELD_HEADERS in packages/shared/src/shield.ts:
 *   sig = hex(HMAC-SHA256(device_secret, `${ts}.${body}`)), ts = unix milliseconds.
 * The key is the UTF-8 bytes of the device_secret string, exactly what Node's
 * crypto.createHmac("sha256", deviceSecret) uses when given a string.
 */
object Signer {
  const val HEADER_DEVICE = "x-shield-device"
  const val HEADER_TS = "x-shield-ts"
  const val HEADER_SIG = "x-shield-sig"

  fun hmacSha256Hex(key: String, message: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    val out = mac.doFinal(message.toByteArray(Charsets.UTF_8))
    val hex = "0123456789abcdef"
    val sb = StringBuilder(out.size * 2)
    for (b in out) {
      val i = b.toInt() and 0xff
      sb.append(hex[i ushr 4]).append(hex[i and 0x0f])
    }
    return sb.toString()
  }

  fun sign(deviceSecret: String, tsMs: Long, body: String): String =
    hmacSha256Hex(deviceSecret, "$tsMs.$body")

  fun headers(deviceId: String, deviceSecret: String, tsMs: Long, body: String): Map<String, String> = linkedMapOf(
    HEADER_DEVICE to deviceId,
    HEADER_TS to tsMs.toString(),
    HEADER_SIG to sign(deviceSecret, tsMs, body),
  )
}
