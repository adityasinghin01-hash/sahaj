import { AdapterError, type FetchTransport } from "./contracts";
import { digits, isRecord, parseJson, send } from "./http";

const MISSED_URL = "https://rest.telecmi.com/v2/missed";

export interface TeleCmiAccount { appId: number; virtualNumber: string }
export interface TeleCmiMissedCall {
  variant: "webhook_cdr" | "pull_cdr";
  /** cmiuuid (webhook) or cmiuid (pull). Same call, different field names. */
  callId: string;
  callerDigits: string;
  virtualNumberDigits: string;
  occurredAt: number;
  personId: string | null;
}
type Resolver = (callerDigits: string) => Promise<{ personId: string } | null> | { personId: string } | null;

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d{1,20}$/.test(v) ? Number(v) : null);
const callIdOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
const timeOk = (t: unknown, now: number): t is number => typeof t === "number" && Number.isFinite(t) && t > 1_000_000_000_000 && t < now + 24 * 3600_000;

/**
 * Missed-call webhook (CDR). Fields per TeleCMI: type "cdr", direction "inbound", status "missed",
 * appid, virtual_number, cmiuuid, from, time. The secret URL proves nothing about content, so the
 * account (appid + virtual number) and caller are cross-checked here. Unknown caller fails closed.
 */
export async function parseTeleCmiMissedWebhook(body: unknown, account: TeleCmiAccount, resolve: Resolver, now = Date.now()): Promise<TeleCmiMissedCall> {
  if (!isRecord(body)) throw new AdapterError("invalid_payload", "telecmi");
  if (body.type !== "cdr" || body.direction !== "inbound" || body.status !== "missed") throw new AdapterError("invalid_payload", "telecmi");
  const callId = body.cmiuuid, appid = asNumber(body.appid), time = body.time, from = digits(body.from), vn = digits(body.virtual_number);
  if (!callIdOk(callId) || appid === null || !timeOk(time, now) || !from || !vn) throw new AdapterError("invalid_payload", "telecmi");
  if (appid !== account.appId || vn !== digits(account.virtualNumber)) throw new AdapterError("unknown_identity", "telecmi");
  const who = await resolve(from);
  if (!who?.personId) throw new AdapterError("unknown_identity", "telecmi");
  return { variant: "webhook_cdr", callId, callerDigits: from, virtualNumberDigits: vn, occurredAt: time, personId: who.personId };
}

export interface TeleCmiPullDeps { transport: FetchTransport; account: TeleCmiAccount; secret: string; timeoutMs?: number }
export interface TeleCmiPullQuery { startDate: number; endDate: number; page?: number; limit?: number }

/**
 * Pull reconciliation (POST /v2/missed). Pull records have no appid and use cmiuid and `to` (our DID),
 * so they are a distinct variant. Records for other numbers are dropped. Unknown callers are returned
 * with personId null so the backend can log and ignore them without acting.
 * The secret travels in the request body as the provider requires; it is never logged or echoed in errors.
 */
export async function pullTeleCmiMissedCalls(deps: TeleCmiPullDeps, q: TeleCmiPullQuery, resolve: Resolver, now = Date.now()): Promise<{ calls: TeleCmiMissedCall[]; total: number }> {
  if (!deps.secret || !Number.isSafeInteger(deps.account.appId)) throw new AdapterError("invalid_payload", "telecmi");
  const page = q.page ?? 1, limit = q.limit ?? 20;
  if (!timeOk(q.startDate, now) || !Number.isFinite(q.endDate) || q.endDate < q.startDate || q.endDate - q.startDate > 31 * 24 * 3600_000 ||
      !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new AdapterError("invalid_payload", "telecmi");
  const res = await send(MISSED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appid: deps.account.appId, secret: deps.secret, start_date: q.startDate, end_date: q.endDate, page, limit }),
  }, { provider: "telecmi", transport: deps.transport, timeoutMs: deps.timeoutMs, readOnly: true });
  const json = parseJson(res.body, "telecmi");
  if (json.code !== 200 || !Array.isArray(json.cdr) || json.cdr.length > limit) throw new AdapterError("provider_rejected", "telecmi", res.status);
  const calls: TeleCmiMissedCall[] = [];
  for (const row of json.cdr) {
    if (!isRecord(row)) throw new AdapterError("invalid_payload", "telecmi");
    const from = digits(row.from), to = digits(row.to);
    if (!callIdOk(row.cmiuid) || !from || !to || !timeOk(row.time, now)) throw new AdapterError("invalid_payload", "telecmi");
    if (to !== digits(deps.account.virtualNumber)) continue;
    const who = await resolve(from);
    calls.push({ variant: "pull_cdr", callId: row.cmiuid, callerDigits: from, virtualNumberDigits: to, occurredAt: row.time, personId: who?.personId ?? null });
  }
  return { calls, total: asNumber(json.count) ?? calls.length };
}
