import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { ShieldTimelineEntry } from "@sahaj/shield";

const GENESIS_HASH = "0".repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function computeChainHash(prevHash: string, entry: unknown): string {
  return createHash("sha256")
    .update(`${prevHash}.${canonicalJson(entry)}`, "utf8")
    .digest("hex");
}

type JsonParam = Parameters<Sql["json"]>[0];

export function createTimelineSigner(sql: Sql): (entry: ShieldTimelineEntry) => Promise<void> {
  return async (entry: ShieldTimelineEntry) => {
    const isBrain = "step" in entry;
    const kind = isBrain ? "brain" : "voice";
    const step = isBrain ? entry.step : entry.type;
    const status = isBrain ? entry.status : null;
    const parentId = isBrain ? asUuidOrNull(entry.parentId) : null;
    const eventKey = isBrain ? entry.eventKey : null;
    const verdictId = isBrain ? asUuidOrNull(entry.verdictId) : null;
    const serialized = JSON.parse(canonicalJson(entry)) as JsonParam;

    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('shield.dev_timeline', 0))`;
      const [latest] = await tx<{ hash: string }[]>`
        select hash from public.dev_timeline order by seq desc limit 1`;
      const prevHash = latest?.hash ?? GENESIS_HASH;
      const hash = computeChainHash(prevHash, entry);
      await tx`
        insert into public.dev_timeline
          (family_id, parent_id, event_key, verdict_id, kind, step, status, entry, prev_hash, hash)
        values
          (${entry.familyId}, ${parentId}, ${eventKey}, ${verdictId}, ${kind}, ${step}, ${status},
           ${tx.json(serialized)}, ${prevHash}, ${hash})`;
    });
  };
}

