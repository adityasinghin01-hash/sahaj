import { vi } from "vitest";
import type { FeedbackVerdict, RecordIndicatorInput, WarningsDb, WarningsDeps } from "../../src/warnings";

export const NOW = new Date("2026-11-14T10:00:00.000Z");
export const DAY = 24 * 60 * 60_000;

interface Indicator {
  id: string;
  kind: string;
  fingerprint: string;
  scamType: string;
  summaryHi: string;
  summaryEn: string;
  timesSeen: number;
  familiesAffected: number;
  confirmed: boolean;
  lastSeenAt: Date;
}
interface Sighting {
  indicatorId: string;
  verdictId: string;
  familyId: string;
  seenAt: Date;
}

/** In-memory WarningsDb with the same rules as shield_record_scam_indicator + createWarningsPg. */
export function makeWarningsDb(verdicts: Record<string, FeedbackVerdict> = {}) {
  const indicators: Indicator[] = [];
  const sightings: Sighting[] = [];
  let seq = 0;

  const db: WarningsDb = {
    getVerdictForFeedback: vi.fn(async (id: string) => verdicts[id] ?? null),
    recordScamIndicator: vi.fn(async (i: RecordIndicatorInput) => {
      let ind = indicators.find((x) => x.kind === i.kind && x.fingerprint === i.fingerprint);
      if (!ind) {
        ind = {
          id: `ind_${++seq}`,
          kind: i.kind,
          fingerprint: i.fingerprint,
          scamType: i.scamType,
          summaryHi: i.summaryHi,
          summaryEn: i.summaryEn,
          timesSeen: 0,
          familiesAffected: 0,
          confirmed: false,
          lastSeenAt: i.seenAt,
        };
        indicators.push(ind);
      }
      const dup = sightings.some((s) => s.indicatorId === ind!.id && s.verdictId === i.verdictId);
      if (!dup) {
        sightings.push({ indicatorId: ind.id, verdictId: i.verdictId, familyId: i.familyId, seenAt: i.seenAt });
        ind.timesSeen += 1;
        ind.familiesAffected = new Set(sightings.filter((s) => s.indicatorId === ind!.id).map((s) => s.familyId)).size;
        ind.lastSeenAt = i.seenAt > ind.lastSeenAt ? i.seenAt : ind.lastSeenAt;
        ind.confirmed = ind.confirmed || ind.familiesAffected >= i.confirmMinFamilies;
      }
      return { id: ind.id, timesSeen: ind.timesSeen, familiesAffected: ind.familiesAffected, confirmed: ind.confirmed, counted: !dup };
    }),
    topConfirmedIndicator: vi.fn(async (since: Date, until: Date) => {
      const scored = indicators
        .filter((i) => i.confirmed)
        .map((i) => ({
          i,
          recent: sightings.filter((s) => s.indicatorId === i.id && s.seenAt > since && s.seenAt <= until).length,
        }))
        .filter((x) => x.recent > 0)
        .sort((a, b) => b.recent - a.recent || b.i.familiesAffected - a.i.familiesAffected || +b.i.lastSeenAt - +a.i.lastSeenAt);
      const top = scored[0];
      return top ? { scamType: top.i.scamType, summaryHi: top.i.summaryHi, summaryEn: top.i.summaryEn, recentSightings: top.recent } : null;
    }),
  };
  return { db, indicators, sightings, verdicts };
}

export function makeWarningsDeps(verdicts: Record<string, FeedbackVerdict> = {}, llmReply?: { summary_hi: string; summary_en: string } | null) {
  const store = makeWarningsDb(verdicts);
  const now = { value: NOW };
  const llmInputs: string[] = [];
  const deps = {
    db: store.db,
    llm: {
      understand: vi.fn(async (req: { input: string }) => {
        llmInputs.push(req.input);
        return llmReply
          ? ({ ok: true, data: llmReply, model: "fake" } as const)
          : ({ ok: false, reason: "no_model" } as const);
      }),
    },
    clock: { now: () => now.value },
  };
  return { deps: deps as unknown as WarningsDeps & { llm: typeof deps.llm }, ...store, now, llmInputs };
}

export function verdict(id: string, familyId: string, over: Partial<FeedbackVerdict> = {}): FeedbackVerdict {
  return {
    id,
    familyId,
    scamType: "kyc_block",
    childFeedback: "fraud",
    linkDomains: ["https://secure-kyc.sbi-update.co.in/login?u=9876543210"],
    maskedTexts: ["Dear customer your SBI KYC is blocked. Update now at link or account closed. Ref <NUM>"],
    numberFingerprints: [],
    ...over,
  };
}
