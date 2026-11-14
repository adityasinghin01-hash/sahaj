import { NextResponse } from 'next/server';
import { tryServiceDatabase, voiceJsonError } from '@/lib/core1/voice-auth';
import { createSupabaseVoiceUploadDeps, handleVoiceUpload } from '@/lib/core1/voice-upload';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const db = tryServiceDatabase();
  if (!db) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }
  try {
    const result = await handleVoiceUpload(request, createSupabaseVoiceUploadDeps(db));
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return voiceJsonError(error);
  }
}
