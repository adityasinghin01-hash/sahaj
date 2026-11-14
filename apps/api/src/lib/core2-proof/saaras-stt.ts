import {
  Core2ProofError,
  MAX_STT_AUDIO_BYTES,
  MAX_STT_AUDIO_SECONDS,
  type SaarasSttInput,
  type SaarasSttPort,
  type SaarasSttResult,
} from "./contracts";

const DEFAULT_SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const DEFAULT_SAARAS_MODEL = "saaras:v3";
const DEFAULT_STT_TIMEOUT_MS = 10_000;

export interface SaarasSttConfig {
  apiKey: string;
  endpointUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Normalizes a transcript or word for Devanagari / Romanized Hindi matching:
 * NFC normalization, lowercase, punctuation stripped, whitespace collapsed.
 */
export function normalizeTranscriptText(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchSpokenWord(
  transcript: string,
  wordToken: string,
  aliases: readonly string[] = [],
): boolean {
  const normalized = normalizeTranscriptText(transcript);
  if (!normalized) return false;

  const tokens = normalized.split(" ");
  const tokenSet = new Set(tokens);

  const candidates = [wordToken, ...aliases]
    .map((candidate) => normalizeTranscriptText(candidate))
    .filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    if (tokenSet.has(candidate)) {
      return true;
    }
    if (candidate.includes(" ") && normalized.includes(candidate)) {
      return true;
    }
  }
  return false;
}

function validateSttAudioInput(input: SaarasSttInput): void {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) {
    throw new Core2ProofError("invalid_request", 400, "Voice clip bytes are required.");
  }
  if (input.audio.byteLength > MAX_STT_AUDIO_BYTES) {
    throw new Core2ProofError(
      "invalid_request",
      400,
      `Voice clip exceeds ${MAX_STT_AUDIO_BYTES} byte limit.`,
    );
  }
  if (
    input.durationS !== null &&
    input.durationS !== undefined &&
    (!Number.isFinite(input.durationS) || input.durationS <= 0 || input.durationS > MAX_STT_AUDIO_SECONDS)
  ) {
    throw new Core2ProofError(
      "audio_too_long",
      400,
      `Proof voice clip must be ${MAX_STT_AUDIO_SECONDS} seconds or shorter.`,
    );
  }
}

export function createSaarasSttAdapter(config: SaarasSttConfig): SaarasSttPort {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpointUrl = config.endpointUrl ?? DEFAULT_SARVAM_STT_URL;
  const model = config.model ?? DEFAULT_SAARAS_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;

  return {
    async transcribe(input: SaarasSttInput): Promise<SaarasSttResult> {
      validateSttAudioInput(input);
      if (!config.apiKey) {
        throw new Core2ProofError("unavailable", 503, "SARVAM_API_KEY is not configured for STT.");
      }

      const cleanContentType = input.contentType.split(";")[0]?.trim() || "audio/mp4";
      const ext = cleanContentType.includes("wav")
        ? "wav"
        : cleanContentType.includes("ogg")
          ? "ogg"
          : "m4a";
      const filename = input.filename?.trim() || `proof.${ext}`;

      const form = new FormData();
      const copy = new Uint8Array(input.audio.byteLength);
      copy.set(input.audio);
      form.append("file", new Blob([copy.buffer], { type: cleanContentType }), filename);
      form.append("model", model);
      form.append("mode", "codemix");
      form.append("language_code", input.languageCode ?? "hi-IN");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpointUrl, {
          method: "POST",
          headers: {
            "api-subscription-key": config.apiKey,
          },
          body: form,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Core2ProofError("unavailable", 503, `Saaras STT failed with status ${res.status}.`);
        }

        const json = (await res.json()) as {
          transcript?: unknown;
          language_code?: unknown;
        };
        const transcript = typeof json.transcript === "string" ? json.transcript.trim() : "";
        return {
          transcript,
          languageCode: typeof json.language_code === "string" ? json.language_code : null,
          provider: "saaras",
        };
      } catch (err) {
        if (err instanceof Core2ProofError) throw err;
        throw new Core2ProofError("unavailable", 503, "Saaras STT request failed.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createSaarasSttFromEnv(
  env: Record<string, string | undefined> = process.env,
): SaarasSttPort {
  return createSaarasSttAdapter({
    apiKey: env.SARVAM_API_KEY?.trim() ?? "",
    endpointUrl: env.SARVAM_STT_URL?.trim() || DEFAULT_SARVAM_STT_URL,
    model: env.SARVAM_STT_MODEL?.trim() || DEFAULT_SAARAS_MODEL,
  });
}
