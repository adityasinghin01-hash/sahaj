import { ALLOWED_AUDIO_MIME, MEDIA_BUCKETS, type MediaBucket } from "./contracts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|mp4)$/i;
const MAX_PATH = 512, MAX_SEGMENTS = 6;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);
export const isBucket = (value: unknown): value is MediaBucket =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(MEDIA_BUCKETS, value);

/**
 * Validates a stored object path. Accepts only `<familyId>/<segment>/...` with a strict character set.
 * `%`, backslash, dots-only segments, empty segments, NUL and control characters are all rejected, so
 * plain and percent-encoded traversal cannot pass. Returns the path unchanged, or null.
 */
export function validateObjectPath(path: unknown, familyId: string): string | null {
  if (typeof path !== "string" || !isUuid(familyId) || path.length === 0 || path.length > MAX_PATH) return null;
  const parts = path.split("/");
  if (parts.length < 2 || parts.length > MAX_SEGMENTS) return null;
  if (parts[0] !== familyId) return null;
  for (const part of parts.slice(1)) if (!SEGMENT_RE.test(part)) return null;
  if (!AUDIO_EXT.test(parts[parts.length - 1])) return null;
  return path;
}

/** Size and MIME must fit the bucket and the global audio allowlist. */
export function objectFitsBucket(bucket: MediaBucket, info: { size: unknown; contentType: unknown }): boolean {
  const { size, contentType } = info;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MEDIA_BUCKETS[bucket].maxBytes) return false;
  if (typeof contentType !== "string") return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return (ALLOWED_AUDIO_MIME as readonly string[]).includes(mime);
}
