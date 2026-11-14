import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createClaudeProvider, createDefaultRouter, createGeminiProvider, createMuseProvider,
  createRouter, ProviderError, type Provider, type ProviderRequest,
} from "../src/index.js";

const schema = z.object({ answer: z.boolean() });
const request: ProviderRequest<{ answer: boolean }> = {
  task: "shield.classify", system: "Classify.", input: "Send <OTP>.", schema,
  effort: "medium", timeoutMs: 100, signal: new AbortController().signal,
};
const message = (text: string | null, stop_reason = "end_turn") => ({
  id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: text === null ? [] : [{ type: "text", text }], stop_reason, stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const claudeWith = (payload: unknown, status = 200) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
  const client = new Anthropic({ apiKey: "fake", fetch, maxRetries: 0, logLevel: "off" });
  const parse = vi.spyOn(client.beta.messages, "parse");
  return { provider: createClaudeProvider(client), fetch, parse };
};
const down: Provider = async () => { throw new ProviderError("connection"); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Claude SDK adapter (fake HTTP only)", () => {
  it("uses the typed beta parse API with fallback, schema, effort, and exact model", async () => {
    const { provider, fetch, parse } = claudeWith(message('{"answer":true}'));
    expect(await provider(request)).toEqual({ kind: "parsed", data: { answer: true } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/v1/messages");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5", max_tokens: 2000,
      system: request.system, messages: [{ role: "user", content: request.input }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } },
      fallbacks: "default",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(parse.mock.calls[0]?.[1]).toMatchObject({ timeout: request.timeoutMs, signal: request.signal, maxRetries: 0 });
    for (const field of ["thinking", "temperature", "top_p", "top_k", "tool_choice"]) expect(body).not.toHaveProperty(field);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["refusal", "max_tokens"])("prioritizes %s over parse errors", async (stop) => {
    const { provider } = claudeWith(message("not JSON", stop));
    await expect(provider(request)).rejects.toMatchObject({ kind: stop });
  });

  it.each([null, "not JSON", '{"answer":"wrong"}'])("rejects missing/invalid parsed output: %s", async (text) => {
    const { provider } = claudeWith(message(text));
    await expect(provider(request)).rejects.toMatchObject({ kind: "validation" });
  });

  it("repairs an actual SDK parse failure through the router", async () => {
    const { provider, fetch } = claudeWith(message("bad JSON"));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(message("bad JSON")), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(message('{"answer":true}')), { headers: { "Content-Type": "application/json" } }));
    const router = createRouter({ claude: provider, muse: down, gemini: down });
    expect(await router.understand(request)).toMatchObject({ ok: true, model: "claude", attempts: [{ ok: false }, { ok: true }] });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[0].content).toContain("Validation error:");
  });

  it("does not run the schema refinement twice for SDK-parsed data", async () => {
    const refine = vi.fn(() => true);
    const { provider } = claudeWith(message('{"answer":true}'));
    const router = createRouter({ claude: provider, muse: down, gemini: down });
    expect(await router.understand({ ...request, schema: schema.refine(refine) })).toMatchObject({ ok: true });
    expect(refine).toHaveBeenCalledOnce();
  });

  it.each([[429, "rate_limit"], [401, "authentication"], [403, "authentication"], [500, "api"], [408, "timeout"]])("categorizes HTTP %s by SDK error types", async (status, kind) => {
    const { provider, fetch } = claudeWith({ type: "error", error: { type: "api_error", message: "private text" } }, status as number);
    await expect(provider(request)).rejects.toMatchObject({ kind });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("categorizes typed SDK connection and timeout errors without message matching", async () => {
    const { provider, fetch } = claudeWith(message(null));
    fetch.mockRejectedValue(new TypeError("private text"));
    await expect(provider(request)).rejects.toMatchObject({ kind: "connection" });
    const client = new Anthropic({ apiKey: "fake", logLevel: "off" });
    vi.spyOn(client.beta.messages, "parse").mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
    await expect(createClaudeProvider(client)(request)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("Muse REST adapter (fake fetch only)", () => {
  const completion = (content = '{"answer":true}', finish_reason = "stop") => ({ choices: [{ message: { content }, finish_reason }] });
  it("uses the documented endpoint, bearer key, model and JSON schema", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(completion())));
    const provider = createMuseProvider({ apiKey: "fake", fetch });
    expect(await provider(request)).toEqual({ kind: "text", text: '{"answer":true}' });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.meta.ai/v1/chat/completions");
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fake");
    expect(init?.signal).toBe(request.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "muse-spark-1.3", reasoning_effort: "medium", response_format: { type: "json_schema", json_schema: { name: "sahaj_output", schema: { type: "object" } } } });
  });

  it("honors endpoint and model overrides", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(completion())));
    await createMuseProvider({ apiKey: "fake", fetch, baseURL: "https://example.test/v1/", model: "custom" })(request);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/v1/chat/completions");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe("custom");
  });

  it.each([[429, "rate_limit"], [401, "authentication"], [500, "api"], [504, "timeout"]])("categorizes HTTP %s", async (status, kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("private provider error", { status: status as number }));
    await expect(createMuseProvider({ apiKey: "fake", fetch })(request)).rejects.toMatchObject({ kind });
  });

  it.each([[completion("{}", "length"), "max_tokens"], [completion("{}", "content_filter"), "refusal"], [{ choices: [] }, "validation"], [{ unexpected: true }, "validation"]])("rejects unsuccessful completions", async (payload, kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(createMuseProvider({ apiKey: "fake", fetch })(request)).rejects.toMatchObject({ kind });
  });
});

describe("Gemini SDK adapter (fake method only)", () => {
  const setup = () => {
    const client = new GoogleGenAI({ apiKey: "fake" });
    const generate = vi.spyOn(client.models, "generateContent");
    const response = new GenerateContentResponse();
    Object.defineProperty(response, "text", { value: '{"answer":true}' });
    generate.mockResolvedValue(response);
    return { provider: createGeminiProvider(client), generate, response };
  };
  it("sends JSON schema, prompt, timeout and cancellation to the official SDK", async () => {
    const { provider, generate } = setup();
    expect(await provider(request)).toEqual({ kind: "text", text: '{"answer":true}' });
    expect(generate).toHaveBeenCalledWith({ model: "gemini-3.8-flash", contents: request.input, config: {
      systemInstruction: request.system, responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(schema),
      thinkingConfig: { thinkingLevel: "MEDIUM" }, httpOptions: { timeout: 100, retryOptions: { attempts: 1 } }, abortSignal: request.signal,
    } });
  });

  it.each(["MAX_TOKENS", "SAFETY"])("rejects %s before parsing", async (finishReason) => {
    const { provider, response } = setup();
    response.candidates = [{ finishReason: finishReason as never }];
    await expect(provider(request)).rejects.toMatchObject({ kind: finishReason === "MAX_TOKENS" ? "max_tokens" : "refusal" });
  });

  it("rejects prompt blocks", async () => {
    const { provider, response } = setup();
    response.promptFeedback = { blockReason: "SAFETY" as never };
    await expect(provider(request)).rejects.toMatchObject({ kind: "refusal" });
  });

  it.each([[429, "rate_limit"], [403, "authentication"], [500, "api"], [504, "timeout"]])("categorizes typed SDK status %s", async (status, kind) => {
    const { provider, generate } = setup();
    generate.mockRejectedValue(new ApiError({ status: status as number, message: "private error" }));
    await expect(provider(request)).rejects.toMatchObject({ kind });
  });
});

describe("environment factory", () => {
  it("works without keys and performs no network calls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const router = createDefaultRouter({ env: {} });
    expect(await router.understand(request)).toMatchObject({ ok: false, reason: "all_failed", attempts: [{ errorKind: "not_configured" }, { errorKind: "not_configured" }, { errorKind: "not_configured" }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads MUSE_API_KEY, MUSE_BASE_URL and MUSE_MODEL after missing Claude credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":true}' }, finish_reason: "stop" }] })));
    vi.stubGlobal("fetch", fetch);
    const router = createDefaultRouter({ env: { MUSE_API_KEY: "fake", MUSE_BASE_URL: "https://example.test/v1", MUSE_MODEL: "test" } });
    expect(await router.understand(request)).toMatchObject({ ok: true, model: "muse" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/v1/chat/completions");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe("test");
  });

  it("blocks unmasked requests before any configured default provider can send them", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const router = createDefaultRouter({ env: { ANTHROPIC_API_KEY: "fake", MUSE_API_KEY: "fake", GEMINI_API_KEY: "fake" } });
    expect(await router.understand({ ...request, input: "call 9876543210" })).toMatchObject({ reason: "input_not_masked" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
