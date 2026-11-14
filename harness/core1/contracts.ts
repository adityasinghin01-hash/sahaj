import { createHash } from 'node:crypto';

/**
 * Contract model aligned with Phase 4 Core 1 `core1_commands` kit (`COMMAND-KIT.md`)
 * and `PHASE4-CORE1.md` scheduling/dst/redaction invariants. Used for unit/contract
 * assertions until Core 1 routes & workers land on main.
 */
export const CORE1_COMMANDS = [
  'checkin.trigger',
  'checkin.respond',
  'urgent.raise',
  'urgent.respond',
  'voice.post',
  'voice.ack',
  'refill.request',
  'refill.approve',
  'nudge.missed_call',
  'report.daily',
] as const;

export type Core1CommandKind = (typeof CORE1_COMMANDS)[number];

export interface CommandScopeInput {
  familyId: string;
  actorPersonId: string;
  commandKind: Core1CommandKind;
  idempotencyKey: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function core1ScopeHash(scope: CommandScopeInput): string {
  return sha256Hex(
    canonicalJson({
      family_id: scope.familyId,
      actor_person_id: scope.actorPersonId,
      command_kind: scope.commandKind,
      idempotency_key: scope.idempotencyKey,
    }),
  );
}

export function core1RequestHash(commandKind: Core1CommandKind, canonicalPayload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ command_kind: commandKind, payload: canonicalPayload }));
}

export interface Core1TargetMember {
  personId: string;
  familyId: string;
  active: boolean;
  role: 'parent' | 'child' | 'circle';
  scopes: readonly string[];
}

/** Strict resolution: matching family + active + required scope; same-family membership alone rejects. */
export function resolveScopedCore1Target(
  candidatePersonId: string,
  expectedFamilyId: string,
  requiredScope: string,
  directory: readonly Core1TargetMember[],
): { ok: true; member: Core1TargetMember } | { ok: false; code: 'target_not_found' | 'target_wrong_family' | 'target_unscoped_or_revoked' } {
  const member = directory.find((m) => m.personId === candidatePersonId);
  if (!member) return { ok: false, code: 'target_not_found' };
  if (member.familyId !== expectedFamilyId) return { ok: false, code: 'target_wrong_family' };
  if (!member.active || !member.scopes.includes(requiredScope)) {
    return { ok: false, code: 'target_unscoped_or_revoked' };
  }
  return { ok: true, member };
}

/** Deterministic IST/IANA local hour check for quiet-window deferral tests. */
export function localHourInZone(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  return Number(formatter.format(new Date(utcMs)));
}

export function isWithinQuietWindow(utcMs: number, timeZone: string, quietStart = 22, quietEnd = 7): boolean {
  const hour = localHourInZone(utcMs, timeZone);
  if (quietStart > quietEnd) {
    return hour >= quietStart || hour < quietEnd;
  }
  return hour >= quietStart && hour < quietEnd;
}
