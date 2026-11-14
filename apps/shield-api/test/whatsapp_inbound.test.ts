import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { numberFingerprint } from "@sahaj/shield";
import {
  createWhatsappWebhookHandlers, normalizeWhatsappReply,
  type WhatsappInboundStore, type WhatsappAnswerInput,
} from "@/lib/whatsapp_inbound";

const SECRET = "lab-only-whatsapp-secret-32-characters";
const TOKEN = "lab-only-verify-token";
const PHONE = "919000000003";
const payload = (body = "CONFIRMED", extra = {}) => ({ entry: [{ changes: [{ value: {
  messages: [{ id: "wamid.synthetic", from: PHONE, type: "text", text: { body }, ...extra }],
} }] }] });
const request = (body: unknown, signature?: string) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://lab/api/whatsapp/webhook", { method: "POST", body: raw, headers: {
    "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
  } });
};
function setup(options: { known?: boolean; pending?: boolean; env?: Record<string, string> } = {}) {
  const check: { state: string; answeredAt?: Date } = { state: options.pending === false ? "no_answer" : "asked" };
  const seen = new Set<string>();
  const signed: string[] = [];
  const recordAnswer = vi.fn(async (input: WhatsappAnswerInput) => {
    if (seen.has(input.messageKey)) return;
    seen.add(input.messageKey);
    if (options.known === false || input.phoneHash !== await numberFingerprint(PHONE) || check.state !== "asked") return;
    check.state = input.answer;
    check.answeredAt = input.at;
    signed.push("shield.family_check.answered");
  });
  const store: WhatsappInboundStore = { recordAnswer };
  const handlers = createWhatsappWebhookHandlers(() => ({
    env: options.env ?? { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: TOKEN },
    whatsappInboundStore: store,
  }));
  return { ...handlers, check, seen, signed, recordAnswer };
}
describe("WhatsApp inbound", () => {
  it("GET verifies the token and returns the challenge as plain text", async () => {
    const { GET } = setup();
    const res = await GET(new Request(`http://lab/?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=synthetic-challenge`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("synthetic-challenge");
  });
  it.each(["hub.mode=subscribe&hub.verify_token=wrong", `hub.mode=no&hub.verify_token=${TOKEN}`, ""])("GET rejects %s", async (query) => {
    expect((await setup().GET(new Request(`http://lab/?${query}`))).status).toBe(403);
  });
  it("GET with unconfigured verification token fails closed", async () => {
    expect((await setup({ env: {} }).GET(new Request("http://lab/?hub.mode=subscribe&hub.verify_token=&hub.challenge=x"))).status).toBe(403);
  });
  it.each(["sha256=bad", `sha256=${"0".repeat(64)}`, ""])("bad POST signature → 401", async (signature) => {
    const h = setup();
    expect((await h.POST(request(payload(), signature))).status).toBe(401);
    expect(h.recordAnswer).not.toHaveBeenCalled();
  });
  it.each(["", "short"])("missing/short secret → 500, nothing accepted", async (secret) => {
    const h = setup({ env: { WHATSAPP_APP_SECRET: secret } });
    expect((await h.POST(request(payload()))).status).toBe(500);
    expect(h.recordAnswer).not.toHaveBeenCalled();
  });
  it.each([["CONFIRMED", "confirmed"], ["nahi", "denied"]])("%s reaches the pending family check", async (body, state) => {
    const h = setup();
    expect((await h.POST(request(payload(body)))).status).toBe(200);
    expect(h.check.state).toBe(state);
    expect(h.check.answeredAt).toBeInstanceOf(Date);
    expect(h.signed).toEqual(["shield.family_check.answered"]);
    const input = h.recordAnswer.mock.calls[0]![0];
    expect(input.phoneHash).toBe(await numberFingerprint(PHONE));
    expect(input.messageKey).not.toContain("wamid.synthetic");
    expect(JSON.stringify(input)).not.toContain(PHONE);
  });
  it.each(["haan", "ha", "yes", "1"])("normalizes affirmative %s", (text) => expect(normalizeWhatsappReply(text)).toBe("confirmed"));
  it.each(["DENIED", "na", "no", "2"])("normalizes negative %s", (text) => expect(normalizeWhatsappReply(text)).toBe("denied"));
  it("ignores unknown text and missing message id or invalid sender", async () => {
    const h = setup();
    await h.POST(request(payload("not an answer")));
    await h.POST(request(payload("yes", { id: undefined })));
    await h.POST(request(payload("yes", { from: "not-a-number" })));
    expect(h.recordAnswer).not.toHaveBeenCalled();
  });
  it.each([{ known: false }, { pending: false }])("ignores an unknown sender or absent pending check", async (options) => {
    const h = setup(options);
    expect((await h.POST(request(payload()))).status).toBe(200);
    expect(h.check.state).toBe(options.pending === false ? "no_answer" : "asked");
    expect(h.signed).toEqual([]);
  });
  it("replaying a message cannot answer a later check", async () => {
    const h = setup();
    await h.POST(request(payload()));
    h.check.state = "asked";
    await h.POST(request(payload()));
    expect(h.check.state).toBe("asked");
    expect(h.signed).toHaveLength(1);
  });
  it("statuses-only and malformed signed payloads are acknowledged no-ops", async () => {
    const h = setup();
    for (const body of [{ entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }] }, "{bad json", null, { entry: "bad" }]) {
      expect((await h.POST(request(body))).status).toBe(200);
    }
    expect(h.recordAnswer).not.toHaveBeenCalled();
  });
  it.each([
    { type: "button", button: { payload: "denied", text: "No" } },
    { type: "interactive", interactive: { button_reply: { id: "denied", title: "No" } } },
    { type: "interactive", interactive: { list_reply: { id: "custom", title: "nahi" } } },
  ])("understands button and interactive replies", async (extra) => {
    const h = setup();
    await h.POST(request(payload("", extra)));
    expect(h.check.state).toBe("denied");
  });
  it("rejects bodies over 256 KB even without Content-Length", async () => {
    const h = setup();
    expect((await h.POST(request("x".repeat(256 * 1024 + 1)))).status).toBe(413);
    expect(h.recordAnswer).not.toHaveBeenCalled();
  });
  it("verifies bytes of the raw body, without JSON reserialization", async () => {
    const h = setup();
    const raw = JSON.stringify(payload(), null, 2);
    expect((await h.POST(request(raw))).status).toBe(200);
    expect(h.check.state).toBe("confirmed");
  });
  it("valid signed POST acknowledges store failures without logging private content", async () => {
    const h = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.recordAnswer.mockRejectedValueOnce(new Error("private provider detail"));
      expect((await h.POST(request(payload()))).status).toBe(200);
      expect(log).toHaveBeenCalledWith("shield.whatsapp_inbound.store_failed");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private provider detail");
    } finally { log.mockRestore(); }
  });
  it("registers background work and responds before a slow store completes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const waitUntil = vi.fn();
    const store = { recordAnswer: vi.fn(() => pending) };
    const { POST } = createWhatsappWebhookHandlers(() => ({
      env: { WHATSAPP_APP_SECRET: SECRET }, whatsappInboundStore: store, whatsappInboundWaitUntil: waitUntil,
    }));
    try {
      expect((await POST(request(payload()))).status).toBe(200);
      expect(waitUntil).toHaveBeenCalledOnce();
      expect(store.recordAnswer).toHaveBeenCalledOnce();
    } finally { finish(); }
    await waitUntil.mock.calls[0]![0];
  });
});

import { loadLiveAdapters, loadLiveEnv, runLiveChecks } from "../../../scripts/lab/live-check.mjs";

function liveHarness(options: { send?: boolean; noKeys?: boolean; fallback?: boolean; staleTrace?: boolean; failFeed?: boolean; failSend?: boolean } = {}) {
  const env: Record<string, string> = options.noKeys ? { LAB_API_URL: "http://127.0.0.1:3100" } : {
    ANTHROPIC_API_KEY: "fake-claude-secret", MUSE_API_KEY: "fake-muse-secret",
    LANGFUSE_PUBLIC_KEY: "fake-public", LANGFUSE_SECRET_KEY: "fake-langfuse-secret", LANGFUSE_BASE_URL: "https://trace.example",
    WHATSAPP_TOKEN: "fake-whatsapp-secret", WHATSAPP_PHONE_NUMBER_ID: "123", LAB_PHONE_ROHIT: "+919000000003",
  };
  let runTask = "";
  const requests: { url: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  const routerEnvs: Record<string, string>[] = [];
  const trace = { enabled: true, onTrace: vi.fn(), flush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
  const fetchFn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const text = String(url);
    requests.push({ url: text, init });
    if (text.includes("openphish")) return new Response(options.failFeed ? "" : "https://phishing.example/a\n");
    if (text.includes("rdap.org")) return Response.json({ ldhName: "GOOGLE.COM" });
    if (text.endsWith("/api/health")) return Response.json({ ok: true, ports: { router: "real" } });
    // Langfuse retired GET /api/public/traces (410); the checker reads v2 observations with metadata.
    if (text.includes("/api/public/v2/observations?")) return Response.json({ data: [{ id: "synthetic-observation", metadata: { task: options.staleTrace ? "unrelated-task" : runTask } }] });
    if (init.method === "POST") return options.failSend ? new Response("private provider failure", { status: 400 }) : Response.json({ messages: [{ id: "synthetic-message" }] });
    return Response.json({ id: "123" });
  }) as unknown as typeof fetch;
  const adapters = {
    createLangfuseTrace: vi.fn(() => trace),
    createDefaultRouter: vi.fn(({ env: routerEnv, onTrace }: { env: Record<string, string>; onTrace: (attempt: unknown) => void }) => {
      routerEnvs.push(routerEnv);
      return { understand: vi.fn(async (request: { task: string; input: string; system: string }) => {
        expect(request.input).not.toMatch(/[0-9]{4}/);
        expect(request.system).not.toMatch(/[0-9]{4}/);
        runTask = request.task;
        const model = routerEnv.ANTHROPIC_API_KEY ? "claude" : "muse";
        onTrace({ model, task: runTask, ok: true, ms: 1 });
        return { ok: true, model: options.fallback ? "gemini" : model };
      }) };
    }),
  };
  const run = () => runLiveChecks({ env, sendWhatsapp: options.send, fetchFn, loadAdapters: async () => adapters, output: (line: string) => lines.push(line), sleep: async () => {} });
  return { run, requests, lines, routerEnvs, trace, env, fetchFn };
}
describe("opt-in live checker (fake providers and fetch only)", () => {
  it("loads the actual adapters offline and runs the keyless router without network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const { createDefaultRouter } = await loadLiveAdapters();
      expect((await createDefaultRouter({ env: {}, onTrace: () => {} }).understand({
        task: "offline", system: "Classify masked input", input: "OTP ******", schema: { safeParse: () => ({ success: true }) },
      })).ok).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("missing env skips keyed checks while key-free checks run; never sends without flag", async () => {
    const h = liveHarness({ noKeys: true });
    const result = await h.run();
    expect(result.exitCode).toBe(0);
    expect(result.results.filter((r) => r.status === "SKIPPED")).toHaveLength(5);
    expect(h.requests).toHaveLength(3);
    expect(h.requests.some((r) => r.init.method === "POST")).toBe(false);
  });
  it("checks all providers, isolates model keys, flushes and verifies this run's trace", async () => {
    const h = liveHarness();
    const result = await h.run();
    expect(result.results.filter((r) => r.status === "PASS")).toHaveLength(7);
    expect(h.routerEnvs[0]).toEqual({ ANTHROPIC_API_KEY: h.env.ANTHROPIC_API_KEY });
    expect(h.routerEnvs[1]?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(h.trace.flush).toHaveBeenCalledOnce();
    expect(h.trace.shutdown).toHaveBeenCalledOnce();
    const observations = h.requests.find((r) => r.url.includes("/api/public/v2/observations?"))?.url ?? "";
    expect(observations).toContain("fields=core%2Cbasic%2Cmetadata");
    expect(h.requests.some((r) => r.url.includes("/api/public/traces"))).toBe(false);
    const rdap = h.requests.find((r) => r.url.includes("rdap.org"));
    expect(new Headers(rdap?.init.headers).get("User-Agent")).toMatch(/^sahaj-shield\//);
    const text = h.lines.join("\n");
    for (const secret of [h.env.ANTHROPIC_API_KEY, h.env.MUSE_API_KEY, h.env.WHATSAPP_TOKEN, h.env.LAB_PHONE_ROHIT]) expect(text).not.toContain(secret);
  });
  it("a model fallback cannot hide failed Claude or Muse keys", async () => {
    const result = await liveHarness({ fallback: true }).run();
    expect(result.exitCode).toBe(1);
    expect(result.results.slice(0, 2).every((r) => r.status === "FAIL")).toBe(true);
  });
  it("an unrelated Langfuse trace cannot pass the gate", async () => {
    const h = liveHarness({ staleTrace: true });
    const result = await h.run();
    expect(result.exitCode).toBe(1);
    expect(result.results.find((r) => r.name === "Langfuse")?.status).toBe("FAIL");
  });
  it("a failed key-free feed check fails the exit status and other checks still run", async () => {
    const result = await liveHarness({ failFeed: true }).run();
    expect(result.exitCode).toBe(1);
    expect(result.results).toHaveLength(8);
    expect(result.results.find((r) => r.name === "OpenPhish")?.status).toBe("FAIL");
  });
  it.each([false, true])("--send-whatsapp makes exactly one POST, even on failure=%s", async (failSend) => {
    const h = liveHarness({ send: true, failSend });
    const result = await h.run();
    const sends = h.requests.filter((r) => r.init.method === "POST");
    expect(sends).toHaveLength(1);
    expect(JSON.parse(String(sends[0]!.init.body))).toEqual({ messaging_product: "whatsapp", to: "919000000003", type: "text", text: { body: "Sahaj lab test ✓" } });
    expect(result.exitCode).toBe(failSend ? 1 : 0);
  });
  it("loads only the explicitly selected env file with shell precedence", () => {
    expect(loadLiveEnv({ NODE_ENV: "test", LAB_ENV_FILE: "", MUSE_API_KEY: "synthetic" }).MUSE_API_KEY).toBe("synthetic");
  });
});
