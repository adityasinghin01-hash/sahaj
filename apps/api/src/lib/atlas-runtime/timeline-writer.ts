import { canonicalJson, signTimelineEvent, verifyTimelineEvent, type SignedTimelineEvent, type TimelineEnvelope, type TimelineHead, type TimelineKey } from "../timeline";
import { RuntimeError, stableUuid, type RpcDb } from "./db";

export interface StoredTimelineRow { envelopeCanonical: string; chainHash: string; signature: string }
/** Persistence for the writer. `append` must call the service-only append_timeline_event RPC. */
export interface TimelineStore {
  head(familyId: string): Promise<TimelineHead>;
  findByDedupe(familyId: string, dedupeKey: string): Promise<StoredTimelineRow | null>;
  append(event: SignedTimelineEvent, payloadCanonical: string): Promise<void>;
}
export interface TimelineAppendInput {
  familyId: string; eventType: string; entityId: string | null; humanLine: string; payload: unknown; dedupeKey: string;
}
export interface TimelineWriterOptions {
  store: TimelineStore; privateKey: TimelineKey; publicKey: TimelineKey; keyId: string; now: () => Date; maxAttempts?: number;
}

function rowToEvent(row: StoredTimelineRow): SignedTimelineEvent {
  return { envelope: JSON.parse(row.envelopeCanonical) as TimelineEnvelope, chainHash: row.chainHash, signature: row.signature };
}

/**
 * Appends one signed event per dedupe key with a family head compare-and-swap.
 * A retry after a lost response finds the stored row by dedupe key and returns it unchanged; it never signs a
 * second variant. A CAS conflict (40001) re-reads the head and tries again.
 */
export function createTimelineWriter(options: TimelineWriterOptions) {
  const attempts = options.maxAttempts ?? 5;
  return async function append(input: TimelineAppendInput): Promise<{ sequence: number; chainHash: string }> {
    let lastCode = "timeline_append_failed";
    for (let attempt = 0; attempt < attempts; attempt++) {
      const existing = await options.store.findByDedupe(input.familyId, input.dedupeKey);
      if (existing) {
        const event = rowToEvent(existing);
        if (!verifyTimelineEvent(event, options.publicKey) || event.envelope.familyId !== input.familyId
          || event.envelope.dedupeKey !== input.dedupeKey || event.envelope.eventType !== input.eventType) {
          throw new RuntimeError("timeline_dedupe_conflict");
        }
        return { sequence: event.envelope.sequence, chainHash: event.chainHash };
      }
      const head = await options.store.head(input.familyId);
      const signed = signTimelineEvent({
        familyId: input.familyId, eventId: stableUuid(["timeline", input.familyId, input.dedupeKey]),
        sequence: head.sequence + 1, dedupeKey: input.dedupeKey, eventType: input.eventType, entityId: input.entityId,
        humanLine: input.humanLine, previousHash: head.chainHash, occurredAt: options.now().toISOString(),
        keyId: options.keyId, payload: input.payload,
      }, options.privateKey);
      try {
        await options.store.append(signed, canonicalJson(input.payload));
        return { sequence: signed.envelope.sequence, chainHash: signed.chainHash };
      } catch (error) {
        // Any failure may be a lost response after commit: the next pass looks up the dedupe key first.
        const code = (error as { code?: string })?.code;
        lastCode = code === "40001" ? "timeline_head_contention" : "timeline_append_failed";
        if (code === "22023" || code === "42501") throw new RuntimeError("timeline_append_failed");
      }
    }
    throw new RuntimeError(lastCode);
  };
}

/** Minimal read surface for PostgREST; writes go through the RPC wrapper only. */
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
    async append(event, payloadCanonical) {
      const { error } = await db.rpc("append_timeline_event", {
        p_event: event.envelope, p_payload_canonical: payloadCanonical, p_chain_hash: event.chainHash, p_signature: event.signature,
      });
      if (error) throw Object.assign(new Error("append"), { code: error.code });
    },
  };
}
