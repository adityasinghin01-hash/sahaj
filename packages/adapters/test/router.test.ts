import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ScamJudgement } from "@sahaj/shared";
import { createRouter, ProviderError, type ProviderRequest, type UnderstandRequest } from "../src/llm/index.js";

type TextProvider = (req: ProviderRequest<unknown>) => Promise<{ kind: "text"; text: string }>;

const schema = z.object({ answer: z.boolean() });
const request: UnderstandRequest<{ answer: boolean }> = {
  task: "shield.classify", system: "Return a judgement.",
  input: "Call <MOBILE_10> and share <OTP> at <URL:example.com>.", schema,
};
const good = () => vi.fn<TextProvider>().mockResolvedValue({ kind: "text", text: '{"answer":true}' });
const down = () => vi.fn<TextProvider>().mockRejectedValue(new ProviderError("connection"));
const setup = () => {
  const providers = { claude: good(), muse: good(), gemini: good() };
  return { ...providers, router: createRouter(providers) };
};
afterEach(() => vi.useRealTimers());

describe("understand", () => {
  it("returns schema-valid Claude output with default options", async () => {
    const { router, claude, muse, gemini } = setup();
    expect(await router.understand(request)).toMatchObject({ ok: true, data: { answer: true }, model: "claude", attempts: [{ model: "claude", task: request.task, ok: true }] });
    expect(claude.mock.calls[0]?.[0]).toMatchObject({ effort: "low", timeoutMs: 10000 });
    expect(muse).not.toHaveBeenCalled();
    expect(gemini).not.toHaveBeenCalled();
  });

  it.each(["not json", '{"answer":"wrong"}'])("retries Claude once after invalid output: %s", async (text) => {
    const { router, claude, muse } = setup();
    claude.mockResolvedValueOnce({ kind: "text", text });
    const result = await router.understand(request);
    expect(result).toMatchObject({ ok: true, model: "claude", attempts: [{ ok: false }, { ok: true }] });
    expect(claude).toHaveBeenCalledTimes(2);
    expect(claude.mock.calls[1]?.[0].input).toContain("Validation error:");
    expect(muse).not.toHaveBeenCalled();
  });

  it.each(["refusal", "max_tokens"] as const)("moves directly to Muse on %s", async (kind) => {
    const { router, claude } = setup();
    claude.mockRejectedValueOnce(new ProviderError(kind));
    expect(await router.understand(request)).toMatchObject({ ok: true, model: "muse", attempts: [{ errorKind: kind }, { ok: true }] });
    expect(claude).toHaveBeenCalledTimes(1);
  });

  it("falls through two Claude validation failures to Muse", async () => {
    const { router, claude } = setup();
    claude.mockResolvedValue({ kind: "text", text: "{}" });
    expect(await router.understand(request)).toMatchObject({ ok: true, model: "muse", attempts: [{ ok: false }, { ok: false }, { ok: true }] });
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("uses Gemini when Claude and Muse fail", async () => {
    const gemini = good();
    const router = createRouter({ claude: down(), muse: down(), gemini });
    expect(await router.understand(request)).toMatchObject({ ok: true, model: "gemini", attempts: [{ model: "claude" }, { model: "muse" }, { model: "gemini" }] });
    expect(gemini).toHaveBeenCalledOnce();
  });

  it("returns all_failed without throwing when all providers throw", async () => {
    const provider = vi.fn<TextProvider>().mockRejectedValue(new Error("secret raw prompt 9876543210"));
    const router = createRouter({ claude: provider, muse: provider, gemini: provider });
    const result = await router.understand(request);
    expect(result).toMatchObject({ ok: false, reason: "all_failed" });
    expect(result.attempts).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each(["input", "system"] as const)("blocks unmasked %s without calling any provider", async (field) => {
    const { router, claude, muse, gemini } = setup();
    expect(await router.understand({ ...request, [field]: "call 9876543210" })).toEqual({ ok: false, reason: "input_not_masked", attempts: [] });
    for (const provider of [claude, muse, gemini]) expect(provider).not.toHaveBeenCalled();
  });

  it("rejects four digits even inside a token, separated digits, and Unicode decimal digits", async () => {
    const { router, claude } = setup();
    for (const input of ["<URL:1234.example>", "OTP 4 8 2 9", "987-654-3210", "(123) 456", "OTP १२३४", "OTP ١٢٣٤", "OTP １２３４"]) {
      expect(await router.understand({ ...request, input })).toMatchObject({ reason: "input_not_masked" });
    }
    expect(claude).not.toHaveBeenCalled();
  });

  it("does not send provider text or schema custom messages back on retry", async () => {
    const { router, claude } = setup();
    const secretSchema = z.string().refine(() => false, "Phone 9876543210");
    claude.mockResolvedValue({ kind: "text", text: '"9876543210"' });
    await router.understand({ ...request, schema: secretSchema });
    expect(claude.mock.calls[1]?.[0].input).toContain("custom");
    expect(claude.mock.calls[1]?.[0].input).not.toContain("9876543210");
  });

  it("times out a hung provider, aborts it, and falls back", async () => {
    vi.useFakeTimers();
    const claude = vi.fn<TextProvider>(() => new Promise(() => {}));
    const router = createRouter({ claude, muse: good(), gemini: good() });
    const result = router.understand({ ...request, timeoutMs: 25, effort: "medium" });
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toMatchObject({ ok: true, model: "muse", attempts: [{ errorKind: "timeout" }, { ok: true }] });
    expect(claude.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits only trace metadata and survives a throwing trace hook", async () => {
    let tick = 0;
    const onTrace = vi.fn(() => { throw new Error("logger down"); });
    const provider = good();
    const router = createRouter({ claude: provider, muse: good(), gemini: good(), now: () => (tick += 5), onTrace });
    expect(await router.understand(request)).toMatchObject({ ok: true, attempts: [{ ms: 5 }] });
    expect(onTrace.mock.calls[0]).toEqual([{ model: "claude", task: "shield.classify", ms: 5, ok: true }]);
  });

  it("validates the actual ScamJudgement schema", async () => {
    const data = { is_scam: true, scam_type: "otp_theft", pressure_signals: ["urgent"], asks_for: ["otp"], confidence: 0.9, hindi_reason: "ओटीपी न दें" };
    const claude = vi.fn<TextProvider>().mockResolvedValue({ kind: "text", text: JSON.stringify(data) });
    const router = createRouter({ claude, muse: down(), gemini: down() });
    expect(await router.understand({ ...request, schema: ScamJudgement })).toMatchObject({ ok: true, data });
  });

  it("rejects schema-invalid fallback output", async () => {
    const invalid = vi.fn<TextProvider>().mockResolvedValue({ kind: "text", text: "{}" });
    const router = createRouter({ claude: down(), muse: invalid, gemini: invalid });
    expect(await router.understand(request)).toMatchObject({ ok: false, reason: "all_failed", attempts: [{ errorKind: "connection" }, { errorKind: "validation" }, { errorKind: "validation" }] });
  });
});

describe("twoLock", () => {
  it("starts Claude and Muse concurrently and keeps their results independent", async () => {
    let finish!: (value: { kind: "text"; text: string }) => void;
    const claude = vi.fn<TextProvider>(() => new Promise((resolve) => { finish = resolve; }));
    const muse = good();
    const gemini = good();
    const router = createRouter({ claude, muse, gemini });
    const pending = router.twoLock(request);
    await vi.waitFor(() => expect(muse).toHaveBeenCalledOnce());
    finish({ kind: "text", text: '{"answer":false}' });
    expect(await pending).toMatchObject({ claude: { ok: true, model: "claude", data: { answer: false } }, muse: { ok: true, model: "muse", data: { answer: true } } });
    expect(gemini).not.toHaveBeenCalled();
  });

  it("reports one lock failing without falling back or retrying", async () => {
    const claude = down();
    const router = createRouter({ claude, muse: good(), gemini: good() });
    expect(await router.twoLock(request)).toMatchObject({ claude: { ok: false, reason: "all_failed" }, muse: { ok: true, model: "muse" } });
    expect(claude).toHaveBeenCalledOnce();
  });

  it("blocks both locks with no calls if either prompt contains digits", async () => {
    const { router, claude, muse } = setup();
    expect(await router.twoLock({ ...request, system: "OTP 1234" })).toEqual({ claude: { ok: false, reason: "input_not_masked", attempts: [] }, muse: { ok: false, reason: "input_not_masked", attempts: [] } });
    expect(claude).not.toHaveBeenCalled();
    expect(muse).not.toHaveBeenCalled();
  });
});
