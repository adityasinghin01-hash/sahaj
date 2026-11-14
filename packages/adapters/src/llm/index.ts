import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { createClaudeProvider } from "./claude.js";
import { createMuseProvider } from "./muse.js";
import { createGeminiProvider } from "./gemini.js";
import { createRouter } from "./router.js";
import { ProviderError, type Provider, type TraceOptions } from "./types.js";

export * from "./types.js";
export { createRouter, isMasked } from "./router.js";
export { createClaudeProvider, CLAUDE_MODEL } from "./claude.js";
export { createMuseProvider, MUSE_BASE_URL, MUSE_MODEL } from "./muse.js";
export { createGeminiProvider, GEMINI_MODEL } from "./gemini.js";

/** Missing keys fail as attempts, so available fallback providers can still run. */
export function createDefaultRouter(options: TraceOptions & {
  env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const env = options.env ?? process.env;
  const missing: Provider = async () => { throw new ProviderError("not_configured"); };
  return createRouter({
    ...options,
    claude: env.ANTHROPIC_API_KEY
      ? createClaudeProvider(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, logLevel: "off" })) : missing,
    muse: env.MUSE_API_KEY
      ? createMuseProvider({ apiKey: env.MUSE_API_KEY, baseURL: env.MUSE_BASE_URL, model: env.MUSE_MODEL }) : missing,
    gemini: env.GEMINI_API_KEY
      ? createGeminiProvider(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })) : missing,
  });
}

// Lazy creation reads env on first use and avoids requiring keys merely to import.
let defaultRouter: ReturnType<typeof createRouter> | undefined;
export const understand: ReturnType<typeof createRouter>["understand"] = (req) =>
  (defaultRouter ??= createDefaultRouter()).understand(req);
export const twoLock: ReturnType<typeof createRouter>["twoLock"] = (req) =>
  (defaultRouter ??= createDefaultRouter()).twoLock(req);
