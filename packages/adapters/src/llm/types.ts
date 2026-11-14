import type { ZodType } from "zod";

export type Model = "claude" | "muse" | "gemini";
export type ErrorKind = "invalid_json" | "validation" | "refusal" | "max_tokens" |
  "timeout" | "rate_limit" | "connection" | "authentication" | "api" |
  "not_configured" | "unknown";

/** Contains metadata only: never prompts, responses, or provider error messages. */
export type Attempt = {
  model: Model;
  task: string;
  ms: number;
  ok: boolean;
  errorKind?: ErrorKind;
};

export type Result<T> =
  | { ok: true; data: T; model: Model; attempts: Attempt[] }
  | { ok: false; reason: "all_failed" | "input_not_masked"; attempts: Attempt[] };

export type UnderstandRequest<T> = {
  task: string;
  system: string;
  input: string;
  schema: ZodType<T>;
  effort?: "low" | "medium";
  /** Per provider attempt, in milliseconds. */
  timeoutMs?: number;
};

export type ProviderRequest<T> = UnderstandRequest<T> & {
  effort: "low" | "medium";
  timeoutMs: number;
  signal: AbortSignal;
};

/** `parsed` is reserved for providers that already validated with req.schema. */
export type ProviderOutput<T> = { kind: "text"; text: string } | { kind: "parsed"; data: T };
export type Provider = <T>(req: ProviderRequest<T>) => Promise<ProviderOutput<T>>;

export type TraceOptions = {
  now?: () => number;
  onTrace?: (attempt: Attempt) => void;
};

export type RouterOptions = TraceOptions & Record<Model, Provider>;

/** Provider failures carry a fixed category, never provider messages or text. */
export class ProviderError extends Error {
  constructor(readonly kind: ErrorKind) {
    super(kind);
    this.name = "ProviderError";
  }
}
