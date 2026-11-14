import { createHash } from 'node:crypto';
import { verifyBearerToken, isAllowedSarvamIp } from '../../../../../shield-api/src/lib/auth';
import { maskDigits } from '../../../../../../packages/shield/src/tools/mask';
import { readCommandBody, isValidUuid } from '../validation';

export const FALLBACK_LINE = 'Maaf kijiye, main aapko abhi Riya se jod rahi hoon.';
export const REAL_NEWS_LINE = 'Riya ke baare mein koi bhi phone aaye — kaatiye aur 2 dabaiye. Asli khabar sirf Sahaj se aayegi.';
export const TOOL_NAMES = ['raise_urgent', 'check_status', 'leave_message', 'child_status', 'child_scam_check',
  'record_consent', 'reschedule', 'mark_private', 'cancel_permission', 'medicine_count',
  'accept_incident', 'decline_incident'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export interface ToolContext { familyId: string; parentId: string }
export type ToolInput = Record<string, string | number | boolean>;
export interface ToolResult {
  status?: string;
  responder_name?: string;
  eta_minutes?: number;
  remaining_count?: number;
  refill_proposed?: boolean;
  check_id?: string;
}
export interface SarvamPorts {
  assertParent(ctx: ToolContext): Promise<void>;
  execute(tool: ToolName, ctx: ToolContext, input: ToolInput, idempotencyKey: string): Promise<ToolResult>;
}
class InvalidInput extends Error {}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function uuid(v: unknown): string {
  if (typeof v !== 'string' || !isValidUuid(v.trim())) throw new InvalidInput();
  return v.trim();
}
function text(v: unknown, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new InvalidInput();
  return maskDigits(v.trim());
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InvalidInput();
  return v;
}

/** Shield's extractor is module-private. Keep its envelope precedence/aliases here
 * rather than importing its entire app (which has a different Next alias root). */
export function parseEnvelope(body: unknown) {
  if (!object(body)) throw new InvalidInput();
  const sources = [body.variables, body.agent_variables, body.context, body].filter(object);
  const value = (snake: string, camel = snake): unknown => sources.map(s => s[snake] ?? s[camel]).find(v => typeof v === 'string' && v.trim());
  const family = value('family_id', 'familyId'), parent = value('parent_id', 'parentId');
  if (!family || !parent) return null;
  const input = object(body.input) ? { ...body.input } : object(body.arguments) ? { ...body.arguments } : { ...body };
  for (const key of ['call_id', 'turn_id']) if (input[key] === undefined && value(key)) input[key] = value(key);
  // Responder decisions: the saved ids the server sent as agent variables may come back in the variables/context
  // envelope instead of the tool body. They are still checked against the stored dispatch binding in SQL.
  for (const key of ['incident_id', 'assignment_id', 'responder_person_id']) if (input[key] === undefined && value(key)) input[key] = value(key);
  // Sarvam may echo its own call/attempt id; it must then equal the provider reference we stored for that call.
  if (input.provider_call_ref === undefined) {
    const ref = value('provider_call_ref') ?? value('sarvam_call_id') ?? value('attempt_id');
    if (ref !== undefined) input.provider_call_ref = ref;
  }
  return { ctx: { familyId: uuid(family), parentId: uuid(parent) }, input, body };
}

export function validateToolInput(tool: ToolName, raw: Record<string, unknown>): ToolInput {
  const out: ToolInput = {};
  if (raw.call_id !== undefined) out.call_id = uuid(raw.call_id);
  if (raw.turn_id !== undefined) out.turn_id = text(raw.turn_id, 120);
  switch (tool) {
    case 'raise_urgent':
      out.said = text(raw.said ?? raw.summary);
      if (raw.severity !== undefined && !['routine', 'urgent', 'critical'].includes(String(raw.severity))) throw new InvalidInput();
      out.severity = String(raw.severity ?? 'urgent'); break;
    case 'leave_message': out.transcript = text(raw.transcript ?? raw.said); break;
    case 'child_scam_check': out.asked_for = text(raw.asked_for ?? raw.said, 300); break;
    case 'child_status': if (raw.subject_person_id !== undefined) out.subject_person_id = uuid(raw.subject_person_id); break;
    case 'record_consent':
      if (!['call', 'record', 'share'].includes(String(raw.purpose)) || typeof raw.answer !== 'boolean') throw new InvalidInput();
      out.purpose = String(raw.purpose); out.answer = raw.answer;
      out.call_id = uuid(raw.call_id); out.turn_id = text(raw.turn_id, 120); break;
    case 'reschedule':
      out.schedule_id = uuid(raw.schedule_id); out.hours = integer(raw.hours, 1, 168); break;
    case 'mark_private': out.call_id = uuid(raw.call_id); break;
    case 'cancel_permission':
      if (raw.confirmed !== true) throw new InvalidInput();
      out.permission_id = uuid(raw.permission_id); out.confirmed = true; break;
    case 'medicine_count':
      out.medicine_id = uuid(raw.medicine_id); out.count = integer(raw.count, 0, 999);
      if (raw.vendor_id !== undefined) out.vendor_id = uuid(raw.vendor_id); break;
    case 'accept_incident':
    case 'decline_incident':
      // `call_id` is OUR calls.id (agent variable @call_id). The proof is derived server-side from that call's stored
      // dispatch binding; a client-supplied raw_event_id is no longer needed and is ignored when sent.
      out.call_id = uuid(raw.call_id); out.responder_person_id = uuid(raw.responder_person_id);
      out.incident_id = uuid(raw.incident_id); out.assignment_id = uuid(raw.assignment_id);
      if (raw.provider_call_ref !== undefined) {
        if (typeof raw.provider_call_ref !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.provider_call_ref)) throw new InvalidInput();
        out.provider_call_ref = raw.provider_call_ref;
      }
      if (tool === 'accept_incident') out.promise_minutes = integer(raw.promise_minutes, 1, 180);
      break;
    case 'check_status': break;
  }
  return out;
}

function response(status: number, error: string): Response {
  return Response.json({ line_hi: FALLBACK_LINE, result: { error }, transfer: true }, {
    status, headers: { 'cache-control': 'no-store' },
  });
}
const CHILD_LINES: Record<string, string> = {
  private: 'Riya apni khabar khud degi. Aap chinta mat kijiye.',
  responder_accepted: 'Riya ke paas madad pahunch rahi hai. Parivar saath hai.',
  en_route: 'Riya raaste mein hai. Sahaj saath hai.',
  checking_in: 'Riya se haal pooch rahe hain. Khabar milte hi bataayenge.',
  family_checking: 'Parivar Riya ka haal pooch raha hai. Khabar milte hi bataayenge.',
  safe: 'Riya ne bataya hai ki woh surakshit hai.',
  ok: 'Riya ki taraf se abhi koi madad ki khabar nahi hai.',
};
function spoken(tool: ToolName, result: ToolResult): string {
  switch (tool) {
    case 'raise_urgent': return 'Main abhi Sharma uncle ko bula rahi hoon';
    case 'child_scam_check': return REAL_NEWS_LINE;
    case 'child_status': return CHILD_LINES[result.status ?? ''] ?? 'Riya ka haal pooch rahe hain. Khabar milte hi bataayenge.';
    case 'check_status':
      if (result.status === 'none') return 'Abhi madad ka koi khula anurodh nahi hai. Madad chahiye toh bataiye.';
      if (result.status === 'accepted') {
        const name = result.responder_name ? maskDigits(result.responder_name).slice(0, 60) : 'Parivar ke sadasya';
        const minutes = result.eta_minutes;
        return `${name} aa rahe hain${Number.isInteger(minutes) && minutes! > 0 && minutes! < 1000 ? `, ${minutes} minute` : ''}.`;
      }
      return 'Madad ke liye parivar se baat kar rahe hain. Main aapke saath hoon.';
    case 'leave_message': return 'Aapke shabdon ka AI se likha sandesh Riya ko bhej rahi hoon.';
    case 'record_consent': return 'Theek hai, aapka jawab likh liya hai.';
    case 'reschedule': return 'Theek hai, main baad mein phone karungi.';
    case 'mark_private': return 'Theek hai, is call ki niji baat Riya ke saath nahi baantungi.';
    case 'cancel_permission': return 'Theek hai, woh ijazat band kar di hai.';
    case 'medicine_count': return result.refill_proposed ? 'Goliyon ki ginti likh li. Dawa mangwane ki ijazat parivar se pooch rahi hoon.' : 'Theek hai, goliyon ki ginti likh li hai.';
    case 'accept_incident': return 'Shukriya, aapka jawab Riya ko bhej diya hai.';
    case 'decline_incident': return result.status === 'escalated'
      ? 'Koi baat nahi. Main Riya ko bata rahi hoon.'
      : 'Koi baat nahi, agle vyakti se pooch rahi hoon.';
  }
}
function publicResult(result: ToolResult): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  const statuses = ['saved', 'queued', 'none', 'open', 'offered', 'accepted', 'declined', 'reopened', 'escalated', 'checking', 'unknown_person', ...Object.keys(CHILD_LINES)];
  if (result.status && statuses.includes(result.status)) safe.status = result.status;
  if (typeof result.remaining_count === 'number' && Number.isInteger(result.remaining_count) && result.remaining_count >= 0 && result.remaining_count < 1000) safe.remaining_count = result.remaining_count;
  if (typeof result.refill_proposed === 'boolean') safe.refill_proposed = result.refill_proposed;
  if (result.check_id && isValidUuid(result.check_id)) safe.check_id = result.check_id;
  return safe;
}

export function createSarvamHandler(getPorts: () => SarvamPorts, env: Readonly<Record<string, string | undefined>> = process.env) {
  return async (request: Request, name: string): Promise<Response> => {
    if (!verifyBearerToken(request, env.SARVAM_TOOL_TOKEN) || !isAllowedSarvamIp(request, env)) return response(401, 'unauthorized');
    if (!TOOL_NAMES.includes(name as ToolName)) return response(404, 'unknown_tool');
    let envelope: ReturnType<typeof parseEnvelope>;
    let input: ToolInput;
    let key: string;
    try {
      envelope = parseEnvelope(JSON.parse((await readCommandBody(request)).toString('utf8')));
      if (!envelope) return response(400, 'missing_context');
      input = validateToolInput(name as ToolName, envelope.input);
      // Responder decisions are idempotent per call id (one decision per call); SQL refuses a different second decision.
      const candidate = request.headers.get('idempotency-key') ?? envelope.body.idempotency_key ??
        (input.call_id && input.turn_id ? `${input.call_id}:${input.turn_id}`
          : (name === 'accept_incident' || name === 'decline_incident') && input.call_id ? `responder-decision:${input.call_id}` : undefined);
      if (candidate !== undefined && (typeof candidate !== 'string' || candidate.length < 8 || candidate.length > 200 || /[\r\n]/.test(candidate))) throw new InvalidInput();
      // Sarvam's dashboard tools cannot always send a per-invocation id. Without one, derive a stable key from the
      // exact request + a 2-minute window: a retried tool call dedupes, a genuinely new request later still runs.
      const windowStart = Math.floor(Date.now() / 120_000);
      key = typeof candidate === 'string' ? candidate : createHash('sha256')
        .update(JSON.stringify(['check_status', 'child_status'].includes(name) ? input : { name, ctx: envelope.ctx, input, windowStart }))
        .digest('hex');
    } catch { return response(400, 'invalid_request'); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    try {
      const operation = async () => {
        const ports = getPorts();
        await ports.assertParent(envelope.ctx);
        if (abandoned) throw new Error('tool_deadline');
        return ports.execute(name as ToolName, envelope.ctx, input, key);
      };
      const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abandoned = true; reject(new Error('tool_deadline')); }, 4500);
      })]);
      return Response.json({ line_hi: spoken(name as ToolName, result), result: publicResult(result), transfer: false }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      console.error(`[sarvam-tool] ${name} unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
      return response(200, 'unavailable');
    }
    finally { if (timer) clearTimeout(timer); }
  };
}
