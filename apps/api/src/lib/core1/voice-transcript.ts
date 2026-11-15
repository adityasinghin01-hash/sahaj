/**
 * Keypad voice notes over Sarvam: Maa's keypad phone cannot play Riya's recording, so the callback agent reads an AI
 * transcript of it ("Riya ka sandesh: …, ye AI ka likha transcript hai"). This transcribes the uploaded note with Sarvam
 * Saaras (same adapter as the voice proof) ONLY for a keypad recipient on the Sarvam call path. Any failure, an oversized
 * clip or a missing key returns null, and the call falls back to the fixed "awaaz bheji hai" line. Nothing is stored:
 * the transcript lives only in this call's masked agent variables.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSaarasSttAdapter } from '../core2-proof/saaras-stt';
import { MAX_STT_AUDIO_BYTES } from '../core2-proof/contracts';
import { callProvider } from './sarvam-calls';
import type { PersonDeviceInfo } from './voice-notify';

export interface KeypadTranscriptDeps {
  getPerson: (familyId: string, personId: string) => Promise<PersonDeviceInfo | null>;
  download: (objectPath: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  transcribe: (input: { audio: Uint8Array; contentType: string; filename: string }) => Promise<string>;
}

const OBJECT_PATH = /^[A-Za-z0-9/_.-]{1,300}$/;

export async function keypadVoiceTranscript(
  deps: KeypadTranscriptDeps,
  input: { familyId: string; recipientId: string; objectPath?: string | null },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  try {
    if (callProvider(env) !== 'sarvam' || !env.SARVAM_API_KEY || !input.objectPath || !OBJECT_PATH.test(input.objectPath)) return null;
    if (!input.objectPath.startsWith(`${input.familyId}/`)) return null;
    const recipient = await deps.getPerson(input.familyId, input.recipientId);
    if (!recipient || recipient.device !== 'keypad') return null;
    const media = await deps.download(input.objectPath);
    if (!media || media.bytes.byteLength === 0 || media.bytes.byteLength > MAX_STT_AUDIO_BYTES) return null;
    const ext = media.contentType.includes('wav') ? 'wav' : media.contentType.includes('ogg') ? 'ogg' : 'm4a';
    const text = (await deps.transcribe({ audio: media.bytes, contentType: media.contentType, filename: `voice.${ext}` })).trim();
    return text.length >= 2 ? text.slice(0, 600) : null;
  } catch {
    return null;
  }
}

export function createSupabaseKeypadTranscriptDeps(
  db: SupabaseClient,
  getPerson: KeypadTranscriptDeps['getPerson'],
  env: Readonly<Record<string, string | undefined>> = process.env,
): KeypadTranscriptDeps {
  const stt = createSaarasSttAdapter({ apiKey: env.SARVAM_API_KEY ?? '', timeoutMs: 8_000 });
  return {
    getPerson,
    async download(objectPath) {
      const { data, error } = await db.storage.from('sahaj-voice').download(objectPath);
      if (error || !data) return null;
      return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || (objectPath.endsWith('.wav') ? 'audio/wav' : objectPath.endsWith('.ogg') ? 'audio/ogg' : 'audio/mp4') };
    },
    async transcribe(input) {
      return (await stt.transcribe({ ...input, durationS: null, languageCode: 'hi-IN' })).transcript;
    },
  };
}
