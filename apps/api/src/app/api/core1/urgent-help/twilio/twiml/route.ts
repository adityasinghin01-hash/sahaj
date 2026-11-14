import { NextResponse } from 'next/server';
import { verifyTwilioFormSignature } from '@sahaj/adapters';
import { buildUrgentResponderTwiml } from '@/lib/core1/urgent-help-service';
import { Core1CommandError } from '@/lib/core1/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolveGatherCallbackUrl(requestUrl: URL): string {
  const explicit = process.env.TWILIO_GATHER_CALLBACK_URL?.trim();
  if (explicit) return explicit;
  const base =
    process.env.PUBLIC_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    requestUrl.origin;
  return `${base.replace(/\/+$/, '')}/api/twilio/gather`;
}

async function serveUrgentTwiml(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sig = request.headers.get('x-twilio-signature');
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (request.method === 'POST' && sig && authToken) {
    const raw = await request.text();
    const params = new URLSearchParams(raw);
    const configuredUrl =
      process.env.PUBLIC_API_BASE_URL?.trim()
        ? `${process.env.PUBLIC_API_BASE_URL.replace(/\/+$/, '')}/api/core1/urgent-help/twilio/twiml${url.search}`
        : url.toString();
    const ok = verifyTwilioFormSignature(configuredUrl, params, sig, authToken);
    if (!ok) {
      return NextResponse.json({ error: 'invalid_twilio_signature' }, { status: 403 });
    }
  }

  try {
    const gatherActionUrl = resolveGatherCallbackUrl(url);
    const twiml = buildUrgentResponderTwiml({ gatherActionUrl });
    return new NextResponse(twiml, {
      status: 200,
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'twiml_render_failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return serveUrgentTwiml(request);
}

export async function POST(request: Request) {
  return serveUrgentTwiml(request);
}

