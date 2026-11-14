import { NextResponse } from 'next/server';
import { tryServiceDatabase, voiceJsonError } from '@/lib/core1/voice-auth';
import {
  createSupabaseVoiceTwilioDeps,
  handleTwilioVoiceRecording,
} from '@/lib/core1/voice-twilio';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const db = tryServiceDatabase();
  if (!db) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }
  try {
    const res = await handleTwilioVoiceRecording(request, createSupabaseVoiceTwilioDeps(db));
    return NextResponse.json(res.body, { status: res.status });
  } catch (error) {
    return voiceJsonError(error);
  }
}
