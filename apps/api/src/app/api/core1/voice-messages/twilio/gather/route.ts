import { NextResponse } from 'next/server';
import { tryServiceDatabase, voiceJsonError } from '@/lib/core1/voice-auth';
import {
  createSupabaseVoiceTwilioDeps,
  handleTwilioVoiceGather,
} from '@/lib/core1/voice-twilio';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const db = tryServiceDatabase();
  if (!db) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }
  try {
    const res = await handleTwilioVoiceGather(request, createSupabaseVoiceTwilioDeps(db));
    return new NextResponse(res.xml, {
      status: res.status,
      headers: { 'content-type': 'text/xml; charset=utf-8' },
    });
  } catch (error) {
    return voiceJsonError(error);
  }
}
