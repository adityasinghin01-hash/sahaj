import { NextResponse } from 'next/server';
import { tryServiceDatabase, voiceJsonError } from '@/lib/core1/voice-auth';
import {
  createSupabaseVoicePlayedDeps,
  handleMarkVoicePlayed,
} from '@/lib/core1/voice-played';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const db = tryServiceDatabase();
  if (!db) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }
  try {
    const { id } = await context.params;
    const res = await handleMarkVoicePlayed(
      request,
      id,
      createSupabaseVoicePlayedDeps(db),
    );
    return NextResponse.json(res.body, { status: res.status });
  } catch (error) {
    return voiceJsonError(error);
  }
}
