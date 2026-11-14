import { vi } from "vitest";
import type { FetchTransport } from "@sahaj/adapters/communication";
import type { ConsentRow } from "../../src/lib/provider-ingestion/gateway";
import { encryptWebhook } from "../../src/lib/webhook-security";
import {
  RecordingError, type CallRecord, type PutResult, type RawEventRow, type RecordingStorage, type RecordingStore, type RecordingWorkerDeps,
} from "../../src/lib/recording-worker";

export const KEY_HEX = "ab".repeat(32);
export const FAMILY = "11111111-1111-4111-8111-111111111111";
export const OTHER_FAMILY = "99999999-9999-4999-8999-999999999999";
export const PERSON = "22222222-2222-4222-8222-222222222222";
export const CALL = "33333333-3333-4333-8333-333333333333";
export const CONSENT = "44444444-4444-4444-8444-444444444444";
export const ACCOUNT = "AC" + "a".repeat(32);
export const CALL_SID = "CA" + "b".repeat(32);
export const REC_SID = "RE" + "c".repeat(32);
export const REC_SID_2 = "RE" + "d".repeat(32);
export const VERSION = "consent-v1";
export const NOW = new Date("2026-11-14T12:00:00.000Z");

export const consent = (o: Partial<ConsentRow> = {}): ConsentRow => ({
  id: CONSENT, familyId: FAMILY, personId: PERSON, callId: CALL, purpose: "call_recording", answer: true, version: VERSION,
  createdAt: "2026-11-14T10:00:00.000Z", ...o,
});

export function eventRow(over: { payload?: Record<string, unknown>; metadata?: Record<string, unknown>; row?: Partial<RawEventRow>; contextId?: string } = {}): RawEventRow {
  const providerEventId = `${ACCOUNT}:recording:${REC_SID}:completed`;
  const payload = {
    account_sid: ACCOUNT, call_sid: CALL_SID, recording_sid: REC_SID, status: "completed", duration_seconds: 42,
    call_id: CALL, consent_id: CONSENT, person_id: PERSON, ...over.payload,
  };
  return {
    id: "55555555-5555-4555-8555-555555555555", familyId: FAMILY, source: "twilio", providerEventId,
    eventType: "twilio.recording.retrieval_requested",
    metadata: { person_id: PERSON, status: "completed", call_id: CALL, consent_id: CONSENT, ...over.metadata },
    payloadCiphertext: encryptWebhook(Buffer.from(JSON.stringify(payload)), KEY_HEX, `twilio:${over.contextId ?? providerEventId}`),
    ...over.row,
  };
}

export class FakeRecordingStore implements RecordingStore {
  call: CallRecord | null = { personId: PERSON, provider: "twilio", externalId: CALL_SID, aiDisclosed: true };
  consents: ConsentRow[] = [consent()];
  /** consents returned by the second lookup, to model revocation during the fetch */
  laterConsents: ConsentRow[] | null = null;
  lookups = 0;
  slotValue: "none" | "same" | "other" | "purged" = "none";
  putResult: PutResult | RecordingError | Error = "stored";
  puts: Array<Parameters<RecordingStore["put"]>[0]> = [];
  async getCall() { return this.call; }
  async findConsents() { this.lookups++; return this.lookups > 1 && this.laterConsents ? this.laterConsents : this.consents; }
  async slot() { return this.slotValue; }
  async put(i: Parameters<RecordingStore["put"]>[0]) {
    this.puts.push(i);
    if (this.putResult instanceof Error) throw this.putResult;
    return this.putResult;
  }
}
export class FakeStorage implements RecordingStorage {
  objects = new Map<string, Uint8Array>();
  failPut = false; failRemove = false; puts = 0; removed: string[] = [];
  async put(path: string, bytes: Uint8Array) {
    this.puts++;
    if (this.failPut) throw new RecordingError("storage_unavailable", true);
    const had = this.objects.has(path);
    this.objects.set(path, bytes);
    return had ? ("exists" as const) : ("created" as const);
  }
  async remove(path: string) {
    if (this.failRemove) throw new RecordingError("storage_unavailable", true);
    this.removed.push(path); this.objects.delete(path);
  }
}

export const wavBytes = (size = 64) => { const b = new Uint8Array(size); b.set([82, 73, 70, 70], 0); b.set([87, 65, 86, 69], 8); return b; };
export const audioResponse = (body: Uint8Array = wavBytes(), type = "audio/x-wav", status = 200) => new Response(body as unknown as BodyInit, { status, headers: { "content-type": type } });

export function scripted(...responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const transport: FetchTransport = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    return next;
  };
  return { transport, calls };
}

export function workerDeps(store: FakeRecordingStore, storage: FakeStorage, transport: FetchTransport, over: Partial<RecordingWorkerDeps> = {}): RecordingWorkerDeps {
  return { store, storage, transport, encryptionKey: KEY_HEX, accountSid: ACCOUNT, authToken: "synthetic-twilio-token", consentVersion: VERSION, timeoutMs: 50, now: () => NOW, ...over };
}
export const spyAll = () => ({ log: vi.spyOn(console, "log"), warn: vi.spyOn(console, "warn"), error: vi.spyOn(console, "error") });
