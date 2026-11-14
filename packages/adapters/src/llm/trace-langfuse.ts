import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation, type LangfuseGenerationAttributes } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Attempt, ErrorKind, Model, TokenUsage } from "./types.js";

export type SpanExporterOption = NonNullable<ConstructorParameters<typeof LangfuseSpanProcessor>[0]>["exporter"];

/** Strictly metadata-only trace payload for Langfuse; never holds prompt or output text. */
export type LangfuseTracePayload = {
  model: Model;
  task: string;
  ms: number;
  ok: boolean;
  errorKind?: ErrorKind;
  usage?: TokenUsage;
};

export interface LangfuseTraceClient {
  traceAttempt(payload: LangfuseTracePayload): void | Promise<void>;
  flush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export type LangfuseTraceOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  exporter?: SpanExporterOption;
  client?: LangfuseTraceClient;
};

export type LangfuseTracer = {
  enabled: boolean;
  onTrace: (attempt: Attempt) => void;
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

function toUsageDetails(usage: TokenUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {
    ...(typeof usage.inputTokens === "number" ? { input: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { output: usage.outputTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { total: usage.totalTokens } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function sanitizePayload(attempt: Attempt): LangfuseTracePayload {
  const usage = attempt.usage ? {
    ...(typeof attempt.usage.inputTokens === "number" ? { inputTokens: attempt.usage.inputTokens } : {}),
    ...(typeof attempt.usage.outputTokens === "number" ? { outputTokens: attempt.usage.outputTokens } : {}),
    ...(typeof attempt.usage.totalTokens === "number" ? { totalTokens: attempt.usage.totalTokens } : {}),
  } : undefined;
  return {
    model: attempt.model,
    task: String(attempt.task),
    ms: Math.max(0, Number(attempt.ms) || 0),
    ok: Boolean(attempt.ok),
    ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function createOtelClient(
  config: { publicKey: string; secretKey: string; baseUrl?: string; exporter?: SpanExporterOption },
  now: () => number,
): LangfuseTraceClient {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.exporter ? { exporter: config.exporter, exportMode: "immediate" as const } : {}),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);

  return {
    traceAttempt(payload) {
      const endMs = now();
      const startTime = new Date(Math.max(0, endMs - payload.ms));
      const endTime = new Date(endMs);
      const usageDetails = toUsageDetails(payload.usage);
      const attributes: LangfuseGenerationAttributes = {
        model: payload.model,
        level: payload.ok ? "DEFAULT" : "ERROR",
        ...(payload.errorKind ? { statusMessage: payload.errorKind } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        metadata: {
          task: payload.task,
          ms: payload.ms,
          ok: payload.ok,
          ...(payload.errorKind ? { errorKind: payload.errorKind } : {}),
        },
      };
      const generation = startObservation("llm.attempt", attributes, { asType: "generation", startTime });
      generation.end(endTime);
    },
    flush: () => processor.forceFlush(),
    shutdown: async () => {
      try {
        await provider.shutdown();
      } finally {
        setLangfuseTracerProvider(null);
      }
    },
  };
}

/**
 * Builds an `onTrace` hook backed by the official `@langfuse/tracing` + `@langfuse/otel` SDK.
 * Sends one generation observation per router attempt with metadata + token usage only, never prompts or outputs.
 * Returns a safe no-op when `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_SECRET_KEY` is unset.
 */
export function createLangfuseTrace(options: LangfuseTraceOptions = {}): LangfuseTracer {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  let client = options.client;
  if (!client) {
    const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
    const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
    const baseUrl = env.LANGFUSE_BASE_URL?.trim();
    if (!publicKey || !secretKey) {
      return {
        enabled: false,
        onTrace: () => {},
        flush: async () => {},
        shutdown: async () => {},
      };
    }
    try {
      client = createOtelClient({ publicKey, secretKey, baseUrl, exporter: options.exporter }, now);
    } catch {
      return {
        enabled: false,
        onTrace: () => {},
        flush: async () => {},
        shutdown: async () => {},
      };
    }
  }

  return {
    enabled: true,
    onTrace(attempt) {
      try {
        const result = client.traceAttempt(sanitizePayload(attempt));
        void Promise.resolve(result).catch(() => { /* Tracing failures must never break routing. */ });
      } catch {
        /* Tracing failures must never break routing. */
      }
    },
    async flush() {
      try { await client.flush?.(); } catch { /* Best-effort telemetry flush. */ }
    },
    async shutdown() {
      try { await client.shutdown?.(); } catch { /* Best-effort telemetry shutdown. */ }
    },
  };
}
