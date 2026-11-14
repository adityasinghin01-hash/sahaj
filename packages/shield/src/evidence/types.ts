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
export interface EvidenceStore {
  isChild(input: { familyId: string; viewerUserId: string }): Promise<boolean>;
  getIncident(input: { familyId: string; verdictId: string }): Promise<EvidenceIncident | null>;
  savePack(input: EvidenceRequest & { contentsHash: string; chainHash: string; createdAt: Date }): Promise<void>;
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
}
