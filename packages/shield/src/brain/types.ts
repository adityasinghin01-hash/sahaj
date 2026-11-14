import type { ShieldAction, ShieldEvent, Verdict, ScamJudgement } from "@sahaj/shared";
import type { UnderstandRequest, Result } from "@sahaj/adapters";

export interface Parent {
  id: string;
  family_id: string;
  /** A telephony line identifier; never sent to AI. */
  line_id?: string;
}
export interface StoredVerdict {
  id: string;
  event: ShieldEvent;
  parent: Parent;
  verdict: Verdict;
}
export interface RulesResult {
  verdict: Verdict;
  needs_ai: boolean;
  links: { url: string; domain: string }[];
}
export type TwoLockResult = { claude: Result<ScamJudgement>; muse: Result<ScamJudgement> };
export type Judge = (request: UnderstandRequest<ScamJudgement>) => Promise<TwoLockResult>;
export interface TimelineRow {
  familyId: string;
  parentId: string;
  eventKey: string;
  verdictId?: string;
  step: string;
  status: "ok" | "denied" | "failed" | "skipped";
  action?: ShieldAction;
  /** Fixed metadata only, no raw text, line identifiers, URLs, or provider errors. */
  details?: Record<string, string | number | boolean>;
}
export interface LinkResult {
  domain: string;
  threat: boolean;
  status: "checked" | "unavailable" | "blocked";
  /** Negative cache results apply only to the exact URLs that were checked. */
  checkedUrls?: string[];
  /** Set when a link on this host is on the OpenPhish public feed (`threat` is then true as well). */
  phishFeed?: boolean;
  /** Set when the registrable domain was registered fewer than 30 days ago (RDAP). */
  newDomain?: boolean;
  /** Whole days since domain registration, when RDAP knew it. */
  domainAgeDays?: number;
  /** Cache-only: RDAP registration time for `rdap:domain:v1:<domain>` (null = unknown). */
  registeredAt?: string | null;
  /** Cache-only: parsed OpenPhish feed for `openphish:feed:v1` (normalised URLs, host-wide hostnames). */
  feed?: { urls: string[]; hosts: string[] };
}
export interface ChildCard {
  verdictId: string;
  familyId: string;
  parentId: string;
  verdict: Verdict;
  quiet: boolean;
  push: true;
  offer1930: boolean;
}
export interface ShieldBrainDeps {
  db: {
    getParent(input: { familyId: string; parentId: string }): Promise<Parent | null>;
    getRecentEvents(input: { familyId: string; parentId: string; since: string; until: string }): Promise<ShieldEvent[]>;
    insertVerdict(input: Omit<StoredVerdict, "id">): Promise<{ id: string }>;
    getVerdict(verdictId: string): Promise<StoredVerdict | null>;
    hasChildReaction(input: { verdictId: string }): Promise<boolean>;
  };
  rules: { evaluate(event: ShieldEvent, recentEvents: ShieldEvent[]): Promise<RulesResult> | RulesResult };
  cache: {
    get(key: string): Promise<LinkResult | null | undefined>;
    set(key: string, value: LinkResult, ttlSeconds: number): Promise<unknown>;
  };
  gate: { check(input: { familyId: string; action: ShieldAction }): Promise<{ allowed: boolean }> };
  notify: { childCard(input: ChildCard): Promise<unknown> };
  whatsapp: { sendShieldAlert(input: ChildCard & { callToAction: string }): Promise<unknown> };
  calls: {
    callParent(input: { familyId: string; parentId: string; lineId: string; verdictId: string; attempt: number }):
      Promise<{ status: "answered" | "busy" | "no_answer" | "failed" }>;
  };
  scheduler: { after(delayMs: number, name: string, payload: Record<string, unknown>): Promise<unknown> };
  jobs?: { claim(key: string): Promise<boolean> };
  atlas: { startCircleChain(input: { verdictId: string; familyId: string; parentId: string }): Promise<unknown> };
  /** Signs AND persists this row to the family's timeline. */
  sign(row: TimelineRow): Promise<unknown>;
  twoLock?: Judge;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Fixed Google endpoint only; never used for fetching event links. */
  safeBrowsingFetch?: typeof fetch;
  /**
   * Fixed trusted hosts only (openphish.com feed, rdap.org with the registrable domain); never event links.
   * Absent = OpenPhish and RDAP checks are off. Hosts pass global `fetch` to turn them on.
   */
  linkIntelFetch?: typeof fetch;
  /** Tests may inject a sandbox instance. Production defaults to the pinned transport. */
  sandbox?: { unshorten(url: string, signal?: AbortSignal): Promise<string> };
}
