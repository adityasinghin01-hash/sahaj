import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { attachUsage, ProviderError, type Provider, type TokenUsage } from "./types.js";

// Sonnet 5.5 (his call, 14 Nov): thinking stays adaptive (never send {type:"disabled"} — 400 on this model),
// effort set per request, server-side fallbacks "default" (the array form may only name claude-sonnet-5).
export const CLAUDE_MODEL = "claude-sonnet-5-5";

export function createClaudeProvider(client: Anthropic): Provider {
  return async (req) => {
    const format = zodOutputFormat(req.schema);
    let parseFailure = false;
    // SDK parse normally throws before callers can inspect stop_reason. Defer
    // parse failures until after the refusal/truncation checks below.
    const guardedFormat = {
      ...format,
      parse(text: string) {
        try { return format.parse(text); }
        catch { parseFailure = true; return null; }
      },
    };
    try {
      const response = await client.beta.messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: req.system,
        messages: [{ role: "user", content: req.input }],
        output_config: { effort: req.effort, format: guardedFormat },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }, { timeout: req.timeoutMs, signal: req.signal, maxRetries: 0 });
      if (response.stop_reason === "refusal") throw new ProviderError("refusal");
      if (response.stop_reason === "max_tokens") throw new ProviderError("max_tokens");
      if (parseFailure || response.parsed_output === null) throw new ProviderError("validation");
      const output = { kind: "parsed" as const, data: response.parsed_output };
      const u = response.usage;
      if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
        const usage: TokenUsage = {
          ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
          ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
          ...(typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
            ? { totalTokens: u.input_tokens + u.output_tokens }
            : {}),
        };
        attachUsage(output, usage);
      }
      return output;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.RequestTimeoutError) throw new ProviderError("timeout");
      if (error instanceof Anthropic.RateLimitError) throw new ProviderError("rate_limit");
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new ProviderError("authentication");
      if (error instanceof Anthropic.APIConnectionError) throw new ProviderError("connection");
      if (error instanceof Anthropic.APIError) throw new ProviderError("api");
      throw error;
    }
  };
}
