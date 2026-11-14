import { ApiError, type GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { ProviderError, type Provider } from "./types.js";

export const GEMINI_MODEL = "gemini-3.8-flash";

export function createGeminiProvider(client: Pick<GoogleGenAI, "models">, model = GEMINI_MODEL): Provider {
  return async (req) => {
    try {
      const response = await client.models.generateContent({
        model, contents: req.input,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(req.schema),
          thinkingConfig: { thinkingLevel: req.effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW },
          httpOptions: { timeout: req.timeoutMs, retryOptions: { attempts: 1 } },
          abortSignal: req.signal,
        },
      });
      if (response.promptFeedback?.blockReason) throw new ProviderError("refusal");
      const reason = response.candidates?.[0]?.finishReason;
      if (reason === "MAX_TOKENS") throw new ProviderError("max_tokens");
      if (reason && reason !== "STOP") throw new ProviderError("refusal");
      const text = response.text;
      if (!text) throw new ProviderError("validation");
      return { kind: "text", text };
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ProviderError(error.status === 429 ? "rate_limit"
          : error.status === 401 || error.status === 403 ? "authentication"
          : error.status === 408 || error.status === 504 ? "timeout" : "api");
      }
      throw error;
    }
  };
}
