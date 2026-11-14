import type { TimeWindow } from '../../../../../packages/atlas/src/core1/types';
import type { ExpoPushMessage } from '@/lib/core1/voice-notify';

export type FreeWindowKind = 'recurring' | 'ad_hoc';
export type FreeWindowSource = 'app' | 'sarvam_checkin' | 'free_now';

export interface FreeWindowRecord {
  id: string;
  familyId: string;
  personId: string;
  timezone: string;
  startMinute: number;
  endMinute: number;
  kind: FreeWindowKind;
  daysOfWeek: number[] | null;
  expiresAt: string | null;
  source: FreeWindowSource;
  label: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonScheduleContext {
  id: string;
  familyId: string;
  displayName: string;
  role: 'parent' | 'child' | 'circle' | 'vendor';
  timezone: string;
  quietWindows: TimeWindow[];
}

export interface MatcherNudgeLogRecord {
  id: string;
  familyId: string;
  parentPersonId: string;
  childPersonId: string;
  localDate: string;
  nudgeId: string | null;
  outboxId: string | null;
  childAlertId: string | null;
  status: 'sent' | 'skipped' | 'failed';
  matchedAt: string;
}

export interface ParsedFreeTimeSuccess {
  ok: true;
  startMinute: number;
  endMinute: number;
  startTime: string;
  endTime: string;
  label: string;
  readBackLine: string;
  confidence: 'explicit_range' | 'after_time' | 'routine_anchor' | 'period_default' | 'single_time';
}

export interface ParsedFreeTimeFailure {
  ok: false;
  reason: 'empty_input' | 'no_free_time' | 'unknown_time_window';
  readBackLine: string;
}

export type ParsedFreeTimeResult = ParsedFreeTimeSuccess | ParsedFreeTimeFailure;

export interface CreateFreeWindowInput {
  id: string;
  familyId: string;
  personId: string;
  timezone: string;
  startMinute: number;
  endMinute: number;
  kind: FreeWindowKind;
  daysOfWeek: number[] | null;
  expiresAt: string | null;
  source: FreeWindowSource;
  label: string;
  rawSaid?: string | null;
}

export interface Core1MatcherStore {
  getPerson(familyId: string, personId: string): Promise<PersonScheduleContext | null>;
  listFamilyPeople(familyId: string): Promise<PersonScheduleContext[]>;
  listCandidateFamilyIds(requestedFamilyId?: string): Promise<string[]>;
  listActiveWindowsForFamily(familyId: string): Promise<FreeWindowRecord[]>;
  listActiveWindowsForPerson(familyId: string, personId: string): Promise<FreeWindowRecord[]>;
  createWindow(
    input: CreateFreeWindowInput,
    options?: { deactivateSource?: FreeWindowSource },
  ): Promise<FreeWindowRecord>;
  deactivateWindow(familyId: string, personId: string, windowId: string): Promise<boolean>;
  getMatcherNudgeForDay(
    familyId: string,
    parentPersonId: string,
    localDate: string,
  ): Promise<MatcherNudgeLogRecord | null>;
  claimMatcherNudgeForDay(input: {
    id: string;
    familyId: string;
    parentPersonId: string;
    childPersonId: string;
    localDate: string;
    nudgeId: string;
    outboxId: string;
    childAlertId: string;
    matchedAt: string;
  }): Promise<{ claimed: boolean; existing?: MatcherNudgeLogRecord }>;
  hasTalkedToday(input: {
    familyId: string;
    parentPersonId: string;
    childPersonId: string;
    dayStartUtcIso: string;
    dayEndUtcIso: string;
  }): Promise<boolean>;
  listPushTokens(familyId: string, personId: string): Promise<string[]>;
  recordNudge(input: {
    id: string;
    familyId: string;
    recipientPersonId: string;
    kind: string;
    scheduledAt: string;
    status: 'pending' | 'sent';
  }): Promise<void>;
  recordChildAlert(input: {
    id: string;
    familyId: string;
    recipientPersonId: string;
    kind: string;
  }): Promise<void>;
}

export interface MatcherAuthActor {
  userId: string;
  familyId: string;
  personId: string;
  role: 'parent' | 'child' | 'circle';
}

export interface MatcherAuthPort {
  authenticate(request: Request, requestedFamilyId?: string): Promise<MatcherAuthActor>;
}

export interface MatcherTimelinePort {
  append(input: {
    familyId: string;
    eventType: string;
    entityId: string | null;
    humanLine: string;
    payload: unknown;
    dedupeKey: string;
    occurredAt?: string;
  }): Promise<{ written: boolean; deduped?: boolean; reason?: string }>;
}

export interface MatcherOutboxPort {
  enqueue(input: {
    familyId: string;
    kind: string;
    action: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }): Promise<{ outboxId: string; deduped: boolean }>;
}

export interface Core1MatcherDeps {
  auth: MatcherAuthPort;
  store: Core1MatcherStore;
  outbox: MatcherOutboxPort;
  timeline?: MatcherTimelinePort;
  sendPush?: (messages: ExpoPushMessage[]) => Promise<{ sent: number; failed: number }>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  newId?: () => string;
}

export interface FamilyMatchEvaluation {
  familyId: string;
  parentPersonId: string;
  childPersonId: string;
  localDate: string;
  bothFreeNow: boolean;
  maaFreeNow: boolean;
  riyaFreeNow: boolean;
  maaQuietNow: boolean;
  talkedToday: boolean;
  nudgedToday: boolean;
  eligibleToNudge: boolean;
  skipReason:
    | null
    | 'not_both_free'
    | 'maa_quiet_hours'
    | 'already_nudged_today'
    | 'already_talked_today';
}
