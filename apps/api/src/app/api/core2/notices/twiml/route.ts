import { verifyTwilioFormSignature } from '@sahaj/adapters';
import { serviceDatabase } from '@/lib/database';
import { careNoticeBody } from '@/lib/core2/authorized-delivery';
import { UUID } from '@/lib/atlas-runtime/db';
export const runtime = 'nodejs';
const xmlEscape = (s: string) => s.replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]!));
export async function POST(request: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const account = process.env.TWILIO_ACCOUNT_SID;
  const base = process.env.TWILIO_VOICE_BASE_URL?.replace(/\/+$/, '');
  if (!token || !account || !base) return new Response('', { status: 503 });
  const url = new URL(request.url);
  const params = new URLSearchParams(await request.text());
  if (!verifyTwilioFormSignature(`${base}${url.pathname}${url.search}`, params,
    request.headers.get('x-twilio-signature'), token) || params.get('AccountSid') !== account)
    return new Response('', { status: 401 });
  const id = url.searchParams.get('outboxId');
  if (!id || !UUID.test(id)) return new Response('', { status: 400 });
  const { data, error } = await serviceDatabase().rpc('read_care_notice', { p_outbox_id: id, p_call_sid: params.get('CallSid') });
  if (error || !data) return new Response('', { status: 403 });
  const body = careNoticeBody(data.kind, data.details);
  // Receiving this AI notice is never treated as an acceptance, delivered/heard proof, or a family member speaking.
  return new Response(`<Response><Say language="hi-IN">${xmlEscape('Namaste. Main Sahaj AI hoon. ' + body)}</Say></Response>`,
    { headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } });
}
