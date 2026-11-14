import type { ConsentRow } from "./contracts";

/**
 * Consent is an append-only history. The effective state is the NEWEST relevant row; equal timestamps
 * resolve to refusal, so a later "no" always revokes an earlier "yes".
 *
 * With `callId` set (recording consent) only two kinds of rows are relevant:
 *  - rows for that exact call (yes or no), and
 *  - explicit global refusals (call_id null, answer false).
 * Rows for other calls are ignored, and a global "yes" is never a grant, so neither can revive a revoked call.
 */
export function latestConsent(
  history: ConsentRow[], familyId: string, personId: string, purpose: string, callId?: string,
): ConsentRow | null {
  let best: ConsentRow | null = null, bestTime = -Infinity;
  for (const row of history) {
    if (row.familyId !== familyId || row.personId !== personId || row.purpose !== purpose) continue;
    if (callId !== undefined && !(row.callId === callId || (row.callId === null && row.answer === false))) continue;
    const time = Date.parse(row.createdAt);
    if (!Number.isFinite(time)) return null; // unreadable history: fail closed
    if (time > bestTime || (time === bestTime && best?.answer === true && row.answer === false)) { best = row; bestTime = time; }
  }
  return best;
}

export interface ConsentCheck {
  linked: ConsentRow | null;
  history: ConsentRow[];
  familyId: string;
  personId: string;
  purpose: string;
  /** When set, consent is call-scoped: the linked consent must belong to this call. */
  callId?: string;
  now: Date;
  maxAgeMs?: number;
}

/** True only if the linked consent is an affirmative, purpose-specific row and no later row withdraws it. */
export function consentIsCurrent(check: ConsentCheck): boolean {
  const { linked } = check;
  if (!linked) return false;
  if (linked.familyId !== check.familyId || linked.personId !== check.personId || linked.purpose !== check.purpose) return false;
  if (linked.answer !== true || !linked.version) return false;
  if (check.callId !== undefined && linked.callId !== check.callId) return false;
  const granted = Date.parse(linked.createdAt);
  if (!Number.isFinite(granted) || granted > check.now.getTime()) return false;
  if (check.maxAgeMs !== undefined && check.now.getTime() - granted > check.maxAgeMs) return false;
  const latest = latestConsent(check.history, check.familyId, check.personId, check.purpose, check.callId);
  return latest !== null && latest.answer === true;
}
