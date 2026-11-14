import { canonicalJson, signTimelineEvent, timelinePayloadHash, verifyTimelineEvent, type SignedTimelineEvent, type TimelineEnvelope, type TimelineHead, type TimelineKey } from "../timeline";
import { RuntimeError, stableUuid, type RpcDb } from "./db";

export interface StoredTimelineRow { envelopeCanonical: string; chainHash: string; signature: string }
/** Lease the append must still hold, checked inside the same database transaction as the write. */
export interface TimelineFence { jobId: string; token: string }
/** Persistence for the writer. `append` must call the fenced, service-only RPC. */
export interface TimelineStore {
  head(familyId: string): Promise<TimelineHead>;
  findByDedupe(familyId: string, dedupeKey: string): Promise<StoredTimelineRow | null>;
  append(event: SignedTimelineEvent, payloadCanonical: string, fence: TimelineFence): Promise<void>;
}
export interface TimelineAppendInput {
  familyId: string; eventType: string; entityId: string | null; humanLine: string; payload: unknown; dedupeKey: string; fence: TimelineFence;
}
export interface TimelineWriterOptions {
  store: TimelineStore; privateKey: TimelineKey; publicKey: TimelineKey; keyId: string; now: () => Date; maxAttempts?: number;
}

function rowToEvent(row: StoredTimelineRow): SignedTimelineEvent {
  return { envelope: JSON.parse(row.envelopeCanonical) as TimelineEnvelope, chainHash: row.chainHash, signature: row.signature };
}

/**
 * Appends one signed event per dedupe key with a family head compare-and-swap, fenced by the job lease inside the
 * database transaction. A replay finds the stored row by dedupe key, verifies its signature and requires every
 * immutable field (family, type, entity, human line, payload hash) to equal this request; only then does it return
 * the stored row. Sequence, previous hash and timestamp are generated at first write and are not compared, so a valid
 * replay never conflicts on them. A changed request under an existing key is a conflict.
 */
export function createTimelineWriter(options: TimelineWriterOptions) {
  const attempts = options.maxAttempts ?? 5;
  return async function append(input: TimelineAppendInput): Promise<{ sequence: number; chainHash: string }> {
    let lastCode = "timeline_append_failed";
    const payloadHash = timelinePayloadHash(input.payload);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const existing = await options.store.findByDedupe(input.familyId, input.dedupeKey);
      if (existing) {
        let event: SignedTimelineEvent;
        try { event = rowToEvent(existing); } catch { throw new RuntimeError("timeline_dedupe_conflict"); }
        const e = event.envelope;
        if (!verifyTimelineEvent(event, options.publicKey) || e.familyId !== input.familyId || e.dedupeKey !== input.dedupeKey
          || e.eventType !== input.eventType || e.entityId !== input.entityId || e.humanLine !== input.humanLine || e.payloadHash !== payloadHash) {
          throw new RuntimeError("timeline_dedupe_conflict");
        }
        return { sequence: e.sequence, chainHash: event.chainHash };
      }
      const head = await options.store.head(input.familyId);
      const signed = signTimelineEvent({
        familyId: input.familyId, eventId: stableUuid(["timeline", input.familyId, input.dedupeKey]),
        sequence: head.sequence + 1, dedupeKey: input.dedupeKey, eventType: input.eventType, entityId: input.entityId,
        humanLine: input.humanLine, previousHash: head.chainHash, occurredAt: options.now().toISOString(),
        keyId: options.keyId, payload: input.payload,
      }, options.privateKey);
      try {
        await options.store.append(signed, canonicalJson(input.payload), input.fence);
        return { sequence: signed.envelope.sequence, chainHash: signed.chainHash };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "SJ001") throw new RuntimeError("stale_lease"); // never retry after losing the lease
        if (code === "22023" || code === "42501") throw new RuntimeError("timeline_append_failed");
        // Anything else may be a lost response after commit: the next pass looks up the dedupe key first.
        lastCode = code === "40001" ? "timeline_head_contention" : "timeline_append_failed";
      }
    }
    throw new RuntimeError(lastCode);
  };
}

/** Minimal read surface for PostgREST; writes go through the fenced RPC only. */
export interface TimelineReadDb extends RpcDb {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> };
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
  };
}

export function supabaseTimelineStore(db: TimelineReadDb): TimelineStore {
  return {
    async head(familyId) {
      const { data, error } = await db.from("timeline_stream_heads").select("last_sequence,last_chain_hash").eq("family_id", familyId).maybeSingle();
      if (error) throw new RuntimeError("timeline_head_failed");
      if (!data) return { familyId, sequence: 0, chainHash: null };
      const sequence = Number(data.last_sequence);
      const chainHash = typeof data.last_chain_hash === "string" ? data.last_chain_hash : null;
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RuntimeError("timeline_head_invalid");
      return { familyId, sequence, chainHash };
    },
    async findByDedupe(familyId, dedupeKey) {
      const { data, error } = await db.from("timeline_events").select("envelope_canonical,chain_hash,signature")
        .eq("family_id", familyId).eq("dedupe_key", dedupeKey).maybeSingle();
      if (error) throw new RuntimeError("timeline_lookup_failed");
      if (!data) return null;
      return { envelopeCanonical: String(data.envelope_canonical), chainHash: String(data.chain_hash), signature: String(data.signature) };
    },
    async append(event, payloadCanonical, fence) {
      const { error } = await db.rpc("append_timeline_event_fenced", {
        p_job_id: fence.jobId, p_lease_token: fence.token, p_event: event.envelope,
        p_payload_canonical: payloadCanonical, p_chain_hash: event.chainHash, p_signature: event.signature,
      });
      if (error) throw Object.assign(new Error("append"), { code: error.code });
    },
  };
}
