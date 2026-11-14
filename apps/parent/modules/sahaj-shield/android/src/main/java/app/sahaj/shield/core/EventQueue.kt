package app.sahaj.shield.core

import java.io.File
import java.io.IOException

data class QueuedEvent(
  val key: String,
  val body: String,
  val attempts: Int,
  val nextAttemptAtMs: Long,
  val createdAtMs: Long,
)

/**
 * Small persistent queue: one file per event in [dir] (app's no-backup dir on the phone).
 * Bodies are already masked JSON, so no secrets are written here.
 * Writes go to a temp file and are renamed, so a crash never leaves half an event.
 */
class FileEventQueue(private val dir: File, private val maxItems: Int = 500) {
  private val lock = Any()

  init { dir.mkdirs() }

  fun enqueue(key: String, body: String, nowMs: Long) = synchronized(lock) {
    require(SAFE_KEY.matches(key)) { "bad idempotency key" }
    write(QueuedEvent(key, body, attempts = 0, nextAttemptAtMs = nowMs, createdAtMs = nowMs))
    trim()
  }

  fun all(): List<QueuedEvent> = synchronized(lock) {
    (dir.listFiles { f -> f.name.endsWith(EXT) } ?: emptyArray())
      .mapNotNull { read(it) }
      .sortedBy { it.createdAtMs }
  }

  fun due(nowMs: Long): List<QueuedEvent> = all().filter { it.nextAttemptAtMs <= nowMs }

  fun size(): Int = synchronized(lock) { dir.listFiles { f -> f.name.endsWith(EXT) }?.size ?: 0 }

  fun nextDueAtMs(): Long? = all().minOfOrNull { it.nextAttemptAtMs }

  fun remove(key: String) = synchronized(lock) { fileFor(key).delete(); Unit }

  fun reschedule(key: String, attempts: Int, nextAttemptAtMs: Long) = synchronized(lock) {
    val cur = read(fileFor(key)) ?: return@synchronized
    write(cur.copy(attempts = attempts, nextAttemptAtMs = nextAttemptAtMs))
  }

  private fun trim() {
    val items = all()
    if (items.size > maxItems) items.take(items.size - maxItems).forEach { fileFor(it.key).delete() }
  }

  private fun fileFor(key: String) = File(dir, key + EXT)

  private fun write(e: QueuedEvent) {
    val tmp = File(dir, e.key + ".tmp")
    tmp.writeText("v1\n${e.attempts}\n${e.nextAttemptAtMs}\n${e.createdAtMs}\n${e.body}", Charsets.UTF_8)
    val target = fileFor(e.key)
    if (!tmp.renameTo(target)) {
      target.delete()
      if (!tmp.renameTo(target)) throw IOException("queue write failed")
    }
  }

  private fun read(f: File): QueuedEvent? = try {
    val text = f.readText(Charsets.UTF_8)
    val parts = text.split('\n', limit = 5)
    if (parts.size == 5 && parts[0] == "v1") {
      QueuedEvent(f.name.removeSuffix(EXT), parts[4], parts[1].toInt(), parts[2].toLong(), parts[3].toLong())
    } else null
  } catch (_: Exception) {
    null
  }

  companion object {
    private const val EXT = ".evt"
    private val SAFE_KEY = Regex("^[A-Za-z0-9-]{8,64}$")
  }
}
