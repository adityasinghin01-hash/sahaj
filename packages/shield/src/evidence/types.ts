import type { ShieldEvent, Verdict } from "@sahaj/shared";

export interface EvidenceIncident {
  familyId: string;
  parentId: string;
  verdictId: string;
  verdict: Verdict;
  createdAt: string;
  eventIds: string[];
  events: { id: string; event: ShieldEvent }[];
}
export interface EvidenceTimelineEntry {
  at: string;
  step: string;
  status: "ok" | "denied" | "failed" | "skipped";
  action?: string;
  details?: string;
  /** Explicit parent report only; absence means unknown, never assume no. */
  money_sent?: boolean;
}
export interface EvidenceRequest { familyId: string; verdictId: string; viewerUserId: string }
/** A stored receipt: hashes and references only, never pack text. */
export interface EvidenceReceipt {
  id: string;
  familyId: string;
  verdictId: string;
  createdFor: string;
  contentsHash: string;
  /** Original lowercase hex checkpoint. */
  chainHash: string;
  createdAt: string;
}
export interface EvidenceStore {
  isChild(input: { familyId: string; viewerUserId: string }): Promise<boolean>;
  getIncident(input: { familyId: string; verdictId: string }): Promise<EvidenceIncident | null>;
  /** Returns the receipt id when the store knows it (Postgres does). */
  savePack(input: EvidenceRequest & { contentsHash: string; chainHash: string; createdAt: Date }): Promise<{ id: string } | void>;
  /** Needed by verifyEvidencePack only. */
  getPack?(input: { familyId: string; packId: string }): Promise<EvidenceReceipt | null>;
}
/**
 * Child-only originals: the full caller numbers and the original message text, as Maa's phone
 * delivered them to the child's private channel. Never stored by Shield, never hashed into the
 * receipt, returned only after the child-role check. Absent = the pack says "ask Maa".
 */
export interface EvidenceSensitiveSource {
  forIncident(input: { familyId: string; parentId: string; verdictId: string; eventIds: string[] }):
    Promise<{ numbers: string[]; messages: string[] } | null>;
}
export interface EvidenceDeps {
  db: EvidenceStore;
  timeline: {
    /** Read only the signed actions associated with these authorized DB event IDs. */
    entriesFor(eventIds: string[]): Promise<EvidenceTimelineEntry[]>;
    /** Exact SHA-256 hex checkpoint from the persisted signed timeline; never a fabricated digest. */
    chainHashFor(eventIds: string[]): Promise<string>;
  };
  clock: { now(): Date };
  sensitive?: EvidenceSensitiveSource;
}
export interface EvidencePack {
  summary_en: string;
  summary_hi: string;
  copy_for_1930: string;
  cybercrime_url: "https://cybercrime.gov.in";
  /** hex-ap: followed by a..p encoding the original hex nibbles 0..f. */
  chain_hash: string;
  /** UTC display timestamp, RFC 850 with two-digit year, for strict digit privacy. */
  created_at: string;
  /** Structured incident facts (all masked; same digit rule as the summaries). */
  verdict: { level: "red"; scam_type: string; reasons_en: string[]; checks: string[]; planned_actions: string[]; time: string };
  events: { time: string; kind: string; channel: string; text: string; asked: string | null }[];
  actions: { time: string; step: string; status: string; action: string | null }[];
  /** What the scammer asked for (from the events), masked. */
  asked_for: string[];
  money_sent: "yes" | "no" | "unknown";
  /** Encoded receipt id for verifyEvidencePack (letters only). Not part of the contents hash. */
  pack_ref?: string;
  /**
   * Child role only: full numbers and original message. null when no originals were supplied.
   * Not part of the contents hash; never stored.
   */
  child_only: { numbers: string[]; messages: string[] } | null;
  /** "Copy for 1930" including the child-only originals; null without them. Not hashed. */
  copy_for_1930_full: string | null;
}
export interface EvidenceVerification {
  ok: boolean;
  contents_match: boolean;
  chain_match: boolean;
  pack_id: string;
  verdict_id: string;
}
