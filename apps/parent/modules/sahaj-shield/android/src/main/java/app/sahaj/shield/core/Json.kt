package app.sahaj.shield.core

/** Minimal JSON writer (android's org.json is a stub in JVM unit tests). Keys keep insertion order. */
object Json {
  fun quote(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (c < ' ' || c == '\u2028' || c == '\u2029') {
          sb.append(String.format("\\u%04x", c.code))
        } else {
          sb.append(c)
        }
      }
    }
    sb.append('"')
    return sb.toString()
  }

  fun value(v: Any?): String = when (v) {
    null -> "null"
    is Boolean -> v.toString()
    is Int, is Long -> v.toString()
    is Number -> v.toDouble().let { d -> if (d.isFinite()) v.toString() else "null" }
    is String -> quote(v)
    else -> quote(v.toString())
  }

  class ObjectWriter {
    private val sb = StringBuilder("{")
    private var first = true

    private fun key(k: String) {
      if (!first) sb.append(',')
      first = false
      sb.append(quote(k)).append(':')
    }

    fun put(k: String, v: Any?) { key(k); sb.append(value(v)) }

    fun putStrings(k: String, list: List<String>) {
      key(k)
      sb.append(list.joinToString(",", "[", "]") { quote(it) })
    }

    fun putFlat(k: String, map: Map<String, Any>) {
      key(k)
      sb.append(map.entries.joinToString(",", "{", "}") { (mk, mv) -> quote(mk) + ":" + value(mv) })
    }

    fun finish(): String = sb.append('}').toString()
  }
}
