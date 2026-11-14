export type MatrixRowId =
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06'
  | '07'
  | '08'
  | '09'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14';

export type EvidenceLevel = 'unit/contract' | 'disposable_integrated' | 'live';

export type ScenarioStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export type BlockingLane =
  | 'kiro-a (phase2-dispatch)'
  | 'kiro-b (phase3-orchestration)'
  | 'agy-phase4 (core1)'
  | 'agy3 (core2)';

export interface LaneCapabilities {
  foundation: boolean;
  phase2Dispatch: boolean;
  phase3Orchestration: boolean;
  phase4Core1: boolean;
  phase5Core2: boolean;
}

export interface ClockPort {
  nowMs(): number;
  nowDate(): Date;
  nowIso(): string;
  advanceMs(ms: number): number;
  advanceMinutes(minutes: number): number;
  set(time: string | number | Date): void;
}

export interface SyntheticActor {
  personId: string;
  familyId: string;
  role: 'parent' | 'child' | 'circle';
  displayName: string;
  phoneE164: string;
}

export interface IdentityPort {
  nextUuid(): string;
  nextIdempotencyKey(prefix?: string): string;
  syntheticPhone(index: number): string;
  issueToken(actor: SyntheticActor, secret: string, ttlSeconds?: number): string;
  verifyToken(token: string, secret: string, nowMs: number): SyntheticActor | null;
}

export interface SignedTwilioRequest {
  url: string;
  contentType: 'application/x-www-form-urlencoded';
  rawBody: Buffer;
  signature: string;
}

export interface CallbackSignerPort {
  signTwilioForm(
    publicUrl: string,
    params: Record<string, string>,
    authToken: string,
  ): SignedTwilioRequest;
  signWhatsAppWebhook(rawBody: string, appSecret: string): string;
}

export type ScriptedOutcome =
  | { kind: 'ok'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'timeout' }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'malformed_json'; status?: number; body?: string };

export interface RecordedTransportCall {
  attempt: number;
  url: string;
  method: string;
  bodyBytes: number;
  outcome: ScriptedOutcome['kind'];
}

export interface ScriptedTransportPort {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  calls(): readonly RecordedTransportCall[];
  push(...outcomes: ScriptedOutcome[]): void;
  reset(): void;
}

export type CrashStage =
  | 'before_commit'
  | 'after_commit_before_response'
  | 'mid_checkpoint'
  | 'after_lease_claim_before_finish';

export class SimulatedCrashError extends Error {
  readonly stage: CrashStage;
  constructor(stage: CrashStage, detail?: string) {
    super(`SimulatedCrashError(${stage})${detail ? `: ${detail}` : ''}`);
    this.name = 'SimulatedCrashError';
    this.stage = stage;
  }
}

export interface CrashController {
  armOnce(stage: CrashStage, detail?: string): void;
  checkpoint(stage: CrashStage): void;
  triggeredStages(): readonly CrashStage[];
  reset(): void;
}

export interface ConcurrencyResult<T> {
  settled: PromiseSettledResult<T>[];
  fulfilled: T[];
  rejected: unknown[];
}

export interface ConcurrencyPort {
  runBarrier<T>(tasks: Array<() => Promise<T>>): Promise<ConcurrencyResult<T>>;
}

export interface RunnerPorts {
  clock: ClockPort;
  identity: IdentityPort;
  signer: CallbackSignerPort;
  transport: ScriptedTransportPort;
  crash: CrashController;
  concurrency: ConcurrencyPort;
  lanes: LaneCapabilities;
}

export interface MatrixRowSpec {
  rowId: MatrixRowId;
  title: string;
  requiredAssertion: string;
  requiredLanes: readonly BlockingLane[];
  foundationChecksAvailable: boolean;
}

export interface MatrixRowResult {
  rowId: MatrixRowId;
  title: string;
  overallStatus: ScenarioStatus;
  blockedBy: readonly BlockingLane[];
  blockReason?: string;
  levels: {
    unitContract: {
      status: ScenarioStatus;
      detail: string;
    };
    disposableIntegrated: {
      status: ScenarioStatus;
      detail: string;
    };
    live: {
      status: ScenarioStatus;
      detail: string;
    };
  };
}
