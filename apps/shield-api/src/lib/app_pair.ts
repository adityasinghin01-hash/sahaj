import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Sql } from "postgres";
import { AppPairResponse, type AppPair } from "@sahaj/shared";
import type { AppMember } from "./app_auth";

/** A retried pairing request replays the same code. Plain codes are never written to the database. */
export async function idempotentAppPair(
  sql: Sql,
  secret: string,
  member: AppMember,
  key: string,
  create: () => Promise<AppPair>,
): Promise<AppPair> {
  const cacheKey =
    "app.pair:" +
    createHash("sha256")
      .update(`${member.family_id}:${member.user_id}:${key}`)
      .digest("hex");
  const encryptionKey = createHash("sha256")
    .update(`app.pair.encryption:${secret}`)
    .digest();
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(hashtextextended(${cacheKey},0))`;
    try {
      const [cached] =
        await conn`select value from public.dev_cache where key=${cacheKey} and expires_at>now()`;
      if (cached) {
        const { iv, tag, ciphertext } = cached.value as {
          iv: string;
          tag: string;
          ciphertext: string;
        };
        const decipher = createDecipheriv(
          "aes-256-gcm",
          encryptionKey,
          Buffer.from(iv, "base64"),
        );
        decipher.setAAD(Buffer.from(cacheKey));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return AppPairResponse.parse(
          JSON.parse(
            Buffer.concat([
              decipher.update(Buffer.from(ciphertext, "base64")),
              decipher.final(),
            ]).toString(),
          ),
        );
      }
      const result = await create(),
        iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(cacheKey));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(result)),
        cipher.final(),
      ]);
      const value = {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: encrypted.toString("base64"),
      };
      await conn`insert into public.dev_cache(key,value,expires_at) values(${cacheKey},${conn.json(value)},now()+interval '12 hours')
        on conflict(key) do update set value=excluded.value,expires_at=excluded.expires_at,updated_at=now()`;
      return result;
    } finally {
      await conn`select pg_advisory_unlock(hashtextextended(${cacheKey},0))`.catch(
        () => undefined,
      );
    }
  } finally {
    conn.release();
  }
}
