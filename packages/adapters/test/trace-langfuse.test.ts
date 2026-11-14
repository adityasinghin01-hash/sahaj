import Anthropic from "@anthropic-ai/sdk";
import { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createClaudeProvider, createDefaultRouter, createGeminiProvider, createLangfuseTrace,
  createMuseProvider, createRouter, ProviderError,
  type LangfuseTraceClient, type LangfuseTracePayload, type ProviderRequest, type SpanExporterOption,
} from "../src/llm/index.js";

const schema = z.object({ answer: z.boolean() });
const request = {
  task: "shield.classify",
  system: "UNIQUE_SYSTEM_PROMPT_NEVER_EXPORT",
  input: "UNIQUE_USER_INPUT_NEVER_EXPORT Share <OTP>.",
  schema,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Langfuse tracing hook (trace-langfuse)", () => {
  it("is a no-op when LANGFUSE env vars are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    for (const env of [
      {},
      { LANGFUSE_PUBLIC_KEY: "pk-only", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" },
      { LANGFUSE_SECRET_KEY: "sk-only", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" },
    ]) {
      const tracer = createLangfuseTrace({ env });
      expect(tracer.enabled).toBe(false);
      tracer.onTrace({ model: "claude", task: "shield.classify", ms: 12, ok: true });
      await tracer.flush();
      await tracer.shutdown();
    }

    const router = createDefaultRouter({ env: {} });
    await router.understand(request);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emits one Langfuse generation span per router attempt with metadata & usage only (no text)", async () => {
    const exportedSpans: Array<{ name: string; attributes: Record<string, unknown>; status: unknown }> = [];
    const exporter: NonNullable<SpanExporterOption> = {
      export(spans, resultCallback) {
        for (const span of spans) {
          exportedSpans.push({
            name: span.name,
            attributes: { ...span.attributes },
            status: span.status,
          });
        }
        resultCallback({ code: 0 });
      },
      shutdown: async () => {},
    };

    const tracer = createLangfuseTrace({
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
      },
      now: () => 1_763_113_400_000,
      exporter,
    });
    expect(tracer.enabled).toBe(true);

    const claude = vi.fn(async () => { throw new ProviderError("rate_limit"); });
    const muse = vi.fn(async () => ({
      kind: "text" as const,
      text: '{"answer":true}',
      usage: { inputTokens: 18, outputTokens: 6, totalTokens: 24 },
    }));
    const gemini = vi.fn(async () => ({ kind: "text" as const, text: '{"answer":false}' }));

    let t = 0;
    const router = createRouter({ claude, muse, gemini, now: () => (t += 7), onTrace: tracer.onTrace });
    const res = await router.understand(request);
    expect(res).toMatchObject({ ok: true, model: "muse" });

    await tracer.flush();
    await tracer.shutdown();

    expect(exportedSpans).toHaveLength(2);
    const [failedSpan, okSpan] = exportedSpans;

    expect(failedSpan!.name).toBe("llm.attempt");
    expect(failedSpan!.attributes["langfuse.observation.type"]).toBe("generation");
    expect(failedSpan!.attributes["langfuse.observation.model.name"]).toBe("claude");
    expect(failedSpan!.attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(failedSpan!.attributes["langfuse.observation.status_message"]).toBe("rate_limit");
    expect(failedSpan!.attributes["langfuse.observation.metadata.task"]).toBe(JSON.stringify("shield.classify"));
    expect(failedSpan!.attributes["langfuse.observation.metadata.ok"]).toBe(JSON.stringify(false));
    expect(failedSpan!.attributes["langfuse.observation.metadata.errorKind"]).toBe(JSON.stringify("rate_limit"));

    expect(okSpan!.name).toBe("llm.attempt");
    expect(okSpan!.attributes["langfuse.observation.model.name"]).toBe("muse");
    expect(okSpan!.attributes["langfuse.observation.level"]).toBe("DEFAULT");
    expect(okSpan!.attributes["langfuse.observation.usage_details"]).toBe(JSON.stringify({ input: 18, output: 6, total: 24 }));

    const dumped = JSON.stringify(exportedSpans);
    expect(dumped).not.toContain("langfuse.observation.input");
    expect(dumped).not.toContain("langfuse.observation.output");
    expect(dumped).not.toContain("UNIQUE_SYSTEM_PROMPT_NEVER_EXPORT");
    expect(dumped).not.toContain("UNIQUE_USER_INPUT_NEVER_EXPORT");
    expect(dumped).not.toContain('"answer"');
  });

  it("strips any unexpected text fields passed onto Attempt before forwarding to fake client", () => {
    const received: LangfuseTracePayload[] = [];
    const client: LangfuseTraceClient = {
      traceAttempt(payload) { received.push(payload); },
    };
    const tracer = createLangfuseTrace({ client });
    tracer.onTrace({
      model: "claude",
      task: "shield.classify",
      ms: 5,
      ok: true,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      ...({ input: "secret", output: "secret", prompt: "secret" } as Record<string, unknown>),
    });

    expect(received).toEqual([{
      model: "claude",
      task: "shield.classify",
      ms: 5,
      ok: true,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }]);
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("forwards token usage from Claude, Muse, and Gemini adapters into Langfuse client", async () => {
    const received: LangfuseTracePayload[] = [];
    const tracer = createLangfuseTrace({ client: { traceAttempt: (p) => { received.push(p); } } });

    const claudeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: '{"answer":true}' }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 4 },
    }), { headers: { "Content-Type": "application/json" } }));
    const claude = createClaudeProvider(new Anthropic({ apiKey: "fake", fetch: claudeFetch, maxRetries: 0, logLevel: "off" }));

    const museFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":false}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
    })));
    const muse = createMuseProvider({ apiKey: "fake", fetch: museFetch });

    const geminiClient = new GoogleGenAI({ apiKey: "fake" });
    const gemResp = new GenerateContentResponse();
    Object.defineProperty(gemResp, "text", { value: '{"answer":true}' });
    gemResp.usageMetadata = { promptTokenCount: 15, candidatesTokenCount: 6, totalTokenCount: 21 };
    vi.spyOn(geminiClient.models, "generateContent").mockResolvedValue(gemResp);
    const gemini = createGeminiProvider(geminiClient);

    const down = async (_req: ProviderRequest<unknown>) => { throw new ProviderError("connection"); };

    await createRouter({ claude, muse: down, gemini: down, onTrace: tracer.onTrace }).understand(request);
    await createRouter({ claude: down, muse, gemini: down, onTrace: tracer.onTrace }).understand(request);
    await createRouter({ claude: down, muse: down, gemini, onTrace: tracer.onTrace }).understand(request);

    expect(received.find((r) => r.model === "claude" && r.ok)?.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 });
    expect(received.find((r) => r.model === "muse" && r.ok)?.usage).toEqual({ inputTokens: 20, outputTokens: 7, totalTokens: 27 });
    expect(received.find((r) => r.model === "gemini" && r.ok)?.usage).toEqual({ inputTokens: 15, outputTokens: 6, totalTokens: 21 });
  });

  it("never breaks routing if Langfuse throws synchronously or asynchronously", async () => {
    const syncThrowTracer = createLangfuseTrace({
      client: { traceAttempt() { throw new Error("langfuse down"); } },
    });
    const asyncThrowTracer = createLangfuseTrace({
      client: { traceAttempt: async () => { throw new Error("langfuse async down"); } },
    });
    const provider = vi.fn(async () => ({ kind: "text" as const, text: '{"answer":true}' }));

    for (const tracer of [syncThrowTracer, asyncThrowTracer]) {
      const router = createRouter({ claude: provider, muse: provider, gemini: provider, onTrace: tracer.onTrace });
      expect(await router.understand(request)).toMatchObject({ ok: true, model: "claude", data: { answer: true } });
    }
  });
});
