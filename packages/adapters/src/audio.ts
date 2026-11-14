import { AdapterError } from "./contracts";

export interface AudioChunk { index: number; startSeconds: number; endSeconds: number }
export const MAX_CHUNK_SECONDS = 28;

/** Timing plan only: actual media decoding and cutting belongs to a codec worker. */
export function planAudioChunks(durationSeconds: number, maxSeconds = MAX_CHUNK_SECONDS): AudioChunk[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600 || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_CHUNK_SECONDS) throw new AdapterError("invalid_payload");
  const count = Math.ceil(durationSeconds / maxSeconds);
  if (count > 10000) throw new AdapterError("invalid_payload");
  return Array.from({ length: count }, (_, index) => ({ index, startSeconds: index * maxSeconds, endSeconds: Math.min((index + 1) * maxSeconds, durationSeconds) }));
}

/** The AI always says it is an AI. Prepended to every synthetic voice or AI call opening. */
export const AI_DISCLOSURE = {
  Hindi: "नमस्ते, मैं सहज का एआई सहायक हूँ, कोई इंसान नहीं।",
  English: "Hello, I am Sahaj's AI assistant, not a person.",
} as const;
export type DisclosureLanguage = keyof typeof AI_DISCLOSURE;

/** Text for synthetic speech. Always starts with the AI disclosure. */
export function withAiDisclosure(text: string, language: DisclosureLanguage = "Hindi"): string {
  if (typeof text !== "string" || text.length > 2000) throw new AdapterError("invalid_payload");
  return `${AI_DISCLOSURE[language]} ${text}`.trim();
}

/** Real family recordings play only with explicit consent from the recorded person. */
export interface RecordingConsent { granted: boolean; personId: string; recordingId: string }
export function requireRecordingConsent(consent: RecordingConsent | undefined, personId: string, recordingId: string): void {
  if (!consent || consent.granted !== true || consent.personId !== personId || consent.recordingId !== recordingId) throw new AdapterError("authorization_denied");
}

export type AudioFormat = "wav" | "mp3" | "ogg_opus" | "mulaw_8k";
export interface AudioBlob { format: AudioFormat; data: Uint8Array; durationSeconds: number }
/** Implemented by a codec worker (ffmpeg or similar). */
export interface AudioConverter { convert(input: AudioBlob, target: AudioFormat): Promise<AudioBlob> }
export interface SpeechToText { transcribe(chunk: AudioBlob, language: string): Promise<{ text: string; confidence: number }> }
export interface TextToSpeech { synthesize(text: string, language: string): Promise<AudioBlob> }

/** Transcribe long audio through the provider's per-request limit. */
export async function transcribeInChunks(
  audio: AudioBlob,
  slicer: (audio: AudioBlob, chunk: AudioChunk) => Promise<AudioBlob>,
  stt: SpeechToText,
  language: string,
): Promise<string> {
  const parts: string[] = [];
  for (const chunk of planAudioChunks(audio.durationSeconds)) {
    const piece = await slicer(audio, chunk);
    if (piece.durationSeconds > MAX_CHUNK_SECONDS + 0.001) throw new AdapterError("invalid_payload");
    parts.push((await stt.transcribe(piece, language)).text);
  }
  return parts.join(" ");
}

/** Deterministic, no-network test doubles. */
export class MockAudioConverter implements AudioConverter {
  readonly calls: AudioFormat[] = [];
  async convert(input: AudioBlob, target: AudioFormat): Promise<AudioBlob> { this.calls.push(target); return { ...input, format: target }; }
}
export class MockSpeechToText implements SpeechToText {
  constructor(private readonly script: string[] = ["synthetic transcript"]) {}
  calls = 0;
  async transcribe(): Promise<{ text: string; confidence: number }> { return { text: this.script[this.calls++ % this.script.length]!, confidence: 0.9 }; }
}
export class MockTextToSpeech implements TextToSpeech {
  readonly spoken: string[] = [];
  async synthesize(text: string, _language?: string): Promise<AudioBlob> { this.spoken.push(text); return { format: "wav", data: new Uint8Array([1, 2, 3]), durationSeconds: Math.min(MAX_CHUNK_SECONDS, Math.max(1, text.length / 15)) }; }
}
