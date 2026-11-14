import { z } from "zod";
import { attachUsage, ProviderError, type Provider, type TokenUsage } from "./types.js";

export const MUSE_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_MODEL = "muse-spark-1.3";

const Completion = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }),
  })),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
});

/** Meta has no dedicated SDK; this uses its documented Chat Completions REST API. */
export function createMuseProvider(options: {
  apiKey: string; baseURL?: string; model?: string; fetch?: typeof fetch;
}): Provider {
  return async (req) => {
    const response = await (options.fetch ?? fetch)(`${(options.baseURL ?? MUSE_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: options.model ?? MUSE_MODEL,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.input }],
        reasoning_effort: req.effort,
        response_format: { type: "json_schema", json_schema: { name: "sahaj_output", schema: z.toJSONSchema(req.schema) } },
      }),
    });
    if (!response.ok) {
      throw new ProviderError(response.status === 429 ? "rate_limit"
        : response.status === 401 || response.status === 403 ? "authentication"
        : response.status === 408 || response.status === 504 ? "timeout" : "api");
    }
    const envelope = Completion.safeParse(await response.json());
    if (!envelope.success) throw new ProviderError("validation");
    const choice = envelope.data.choices[0];
    if (choice?.message.refusal || choice?.finish_reason === "content_filter") throw new ProviderError("refusal");
    if (choice?.finish_reason === "length") throw new ProviderError("max_tokens");
    if (!choice?.message.content) throw new ProviderError("validation");
    const output = { kind: "text" as const, text: choice.message.content };
    const u = envelope.data.usage;
    if (u) {
      const usage: TokenUsage = {
        ...(typeof u.prompt_tokens === "number" ? { inputTokens: u.prompt_tokens } : {}),
        ...(typeof u.completion_tokens === "number" ? { outputTokens: u.completion_tokens } : {}),
        ...(typeof u.total_tokens === "number" ? { totalTokens: u.total_tokens } : {}),
      };
      attachUsage(output, usage);
    }
    return output;
  };
}
