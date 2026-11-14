import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CallbackSignerPort,
  ClockPort,
  ConcurrencyPort,
  ConcurrencyResult,
  CrashController,
  CrashStage,
  IdentityPort,
  LaneCapabilities,
  RecordedTransportCall,
  RunnerPorts,
  ScriptedOutcome,
  ScriptedTransportPort,
  SignedTwilioRequest,
  SyntheticActor,
} from './types';
import { SimulatedCrashError } from './types';

export class ControlledClock implements ClockPort {
  private currentMs: number;

  constructor(initial: string | number | Date = '2026-11-14T10:00:00.000Z') {
    this.currentMs = typeof initial === 'number' ? initial : new Date(initial).getTime();
    if (!Number.isFinite(this.currentMs)) {
      throw new Error(`Invalid initial clock time: ${String(initial)}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowDate(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMs(ms: number): number {
    if (!Number.isFinite(ms)) throw new Error(`Invalid advanceMs: ${ms}`);
    this.currentMs += ms;
    return this.currentMs;
  }

  advanceMinutes(minutes: number): number {
    return this.advanceMs(minutes * 60_000);
  }

  set(time: string | number | Date): void {
    const ms = typeof time === 'number' ? time : new Date(time).getTime();
    if (!Number.isFinite(ms)) throw new Error(`Invalid clock time: ${String(time)}`);
    this.currentMs = ms;
  }
}

export class SyntheticIdentityPort implements IdentityPort {
  private seq = 0;

  nextUuid(): string {
    return randomUUID();
  }

  nextIdempotencyKey(prefix = 'p5h'): string {
    this.seq += 1;
    return `${prefix}-${this.seq}-${randomUUID().slice(0, 8)}`;
  }

  /** Only synthetic +919000000001..+919000000999 ranges are permitted. */
  syntheticPhone(index: number): string {
    if (!Number.isInteger(index) || index < 1 || index > 999) {
      throw new Error(`Synthetic phone index out of safe range (1..999): ${index}`);
    }
    return `+919000000${String(index).padStart(3, '0')}`;
  }

  issueToken(actor: SyntheticActor, secret: string, ttlSeconds = 3600): string {
    if (secret.length < 16) throw new Error('Test token secret must be >= 16 chars');
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ actor, exp }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token: string, secret: string, nowMs: number): SyntheticActor | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts as [string, string];
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        actor?: SyntheticActor;
        exp?: number;
      };
      if (!parsed.actor || typeof parsed.exp !== 'number') return null;
      if (parsed.exp * 1000 <= nowMs) return null;
      return parsed.actor;
    } catch {
      return null;
    }
  }
}

export class RealCallbackSigner implements CallbackSignerPort {
  /** Matches Twilio HMAC-SHA1 over sorted de-duplicated form params appended to exact publicUrl. */
  signTwilioForm(
    publicUrl: string,
    params: Record<string, string>,
    authToken: string,
  ): SignedTwilioRequest {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      search.append(k, v);
    }
    let data = publicUrl;
    for (const key of [...new Set(search.keys())].sort()) {
      for (const value of [...new Set(search.getAll(key))].sort()) {
        data += key + value;
      }
    }
    const signature = createHmac('sha1', authToken).update(data).digest('base64');
    return {
      url: publicUrl,
      contentType: 'application/x-www-form-urlencoded',
      rawBody: Buffer.from(search.toString(), 'utf8'),
      signature,
    };
  }

  signWhatsAppWebhook(rawBody: string, appSecret: string): string {
    return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  }
}

export class ScriptedTransport implements ScriptedTransportPort {
  private readonly queue: ScriptedOutcome[] = [];
  private readonly log: RecordedTransportCall[] = [];

  push(...outcomes: ScriptedOutcome[]): void {
    this.queue.push(...outcomes);
  }

  calls(): readonly RecordedTransportCall[] {
    return this.log;
  }

  reset(): void {
    this.queue.length = 0;
    this.log.length = 0;
  }

  fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const attempt = this.log.length + 1;
    const outcome = this.queue.shift() ?? { kind: 'http_error', status: 500, body: '{"error":"unscripted"}' };
    const rawBody = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '';
    this.log.push({
      attempt,
      url: target,
      method: init?.method ?? 'GET',
      bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
      outcome: outcome.kind,
    });

    if (outcome.kind === 'timeout') {
      throw new DOMException('Scripted provider timeout', 'TimeoutError');
    }
    if (outcome.kind === 'malformed_json') {
      return new Response(outcome.body ?? '{not-valid-json', {
        status: outcome.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (outcome.kind === 'http_error') {
      return new Response(outcome.body, {
        status: outcome.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'application/json', ...(outcome.headers ?? {}) },
    });
  };
}

export class ControlledCrashPort implements CrashController {
  private armed = new Map<CrashStage, string | undefined>();
  private readonly fired: CrashStage[] = [];

  armOnce(stage: CrashStage, detail?: string): void {
    this.armed.set(stage, detail);
  }

  checkpoint(stage: CrashStage): void {
    if (!this.armed.has(stage)) return;
    const detail = this.armed.get(stage);
    this.armed.delete(stage);
    this.fired.push(stage);
    throw new SimulatedCrashError(stage, detail);
  }

  triggeredStages(): readonly CrashStage[] {
    return this.fired;
  }

  reset(): void {
    this.armed.clear();
    this.fired.length = 0;
  }
}

export class BarrierConcurrency implements ConcurrencyPort {
  async runBarrier<T>(tasks: Array<() => Promise<T>>): Promise<ConcurrencyResult<T>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = tasks.map(async (fn) => {
      await gate;
      return fn();
    });
    // Yield a microtask so every caller awaits the barrier before release.
    await Promise.resolve();
    release();
    const settled = await Promise.allSettled(pending);
    const fulfilled: T[] = [];
    const rejected: unknown[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') fulfilled.push(item.value);
      else rejected.push(item.reason);
    }
    return { settled, fulfilled, rejected };
  }
}

export function defaultLaneCapabilities(): LaneCapabilities {
  return {
    foundation: true,
    phase2Dispatch: false,
    phase3Orchestration: false,
    phase4Core1: false,
    phase5Core2: false,
  };
}

export function createRunnerPorts(overrides: Partial<RunnerPorts> = {}): RunnerPorts {
  return {
    clock: overrides.clock ?? new ControlledClock(),
    identity: overrides.identity ?? new SyntheticIdentityPort(),
    signer: overrides.signer ?? new RealCallbackSigner(),
    transport: overrides.transport ?? new ScriptedTransport(),
    crash: overrides.crash ?? new ControlledCrashPort(),
    concurrency: overrides.concurrency ?? new BarrierConcurrency(),
    lanes: overrides.lanes ?? defaultLaneCapabilities(),
  };
}
