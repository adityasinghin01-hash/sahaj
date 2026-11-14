import { z } from "zod";
import { ProviderError, readUsage, type Attempt, type ErrorKind, type Model, type Result,
  type RouterOptions, type TokenUsage, type UnderstandRequest } from "./types.js";

/** Also covers decimal digits in Hindi and other scripts, including short-separated runs. Tokens get no exemption. */
export function isMasked(text: string): boolean {
  return !/\p{Decimal_Number}(?:[\s\-.,/()]{0,2}\p{Decimal_Number}){3,}/u.test(text);
}

const blocked = <T>(): Result<T> => ({ ok: false, reason: "input_not_masked", attempts: [] });
const failed = <T>(attempts: Attempt[]): Result<T> => ({ ok: false, reason: "all_failed", attempts });

export function createRouter(options: RouterOptions) {
  const now = options.now ?? Date.now;

  async function attempt<T>(model: Model, req: UnderstandRequest<T>): Promise<{
    result: Result<T>; validationError?: string;
  }> {
    // Guard each outgoing attempt too, including the validation-repair prompt.
    if (!isMasked(req.input) || !isMasked(req.system)) return { result: blocked() };
    const timeoutMs = Number.isFinite(req.timeoutMs) && (req.timeoutMs ?? 0) > 0
      ? Math.min(req.timeoutMs!, 2_147_483_647) : 10000;
    const controller = new AbortController();
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errorKind: ErrorKind | undefined;
    let validationError: string | undefined;
    let usage: TokenUsage | undefined;
    let data!: T;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProviderError("timeout"));
          controller.abort();
        }, timeoutMs);
      });
      const output = await Promise.race([
        Promise.resolve().then(() => options[model]({ ...req, effort: req.effort ?? "low", timeoutMs, signal: controller.signal })),
        timeout,
      ]);
      usage = readUsage(output);
      if (output.kind === "parsed") {
        // The Claude SDK has already run this exact schema. Do not run transforms twice.
        data = output.data;
      } else {
        const parsed: unknown = JSON.parse(output.text);
        const checked = req.schema.safeParse(parsed);
        if (!checked.success) {
          // Zod messages, paths and received values can contain sensitive model output.
          // Send only fixed issue codes back on a repair request.
          validationError = [...new Set(checked.error.issues.map((issue) => issue.code))].join(", ");
          throw new ProviderError("validation");
        }
        data = checked.data;
      }
    } catch (error) {
      errorKind = error instanceof ProviderError ? error.kind
        : error instanceof SyntaxError ? "invalid_json"
        : error instanceof z.ZodError ? "validation" : "unknown";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const trace: Attempt = {
      model, task: req.task, ms: Math.max(0, now() - started), ok: errorKind === undefined,
      ...(errorKind ? { errorKind } : {}),
      ...(usage ? { usage } : {}),
    };
    try { options.onTrace?.({ ...trace }); } catch { /* Logging must not break routing. */ }
    return {
      result: errorKind ? failed([trace]) : { ok: true, data, model, attempts: [trace] },
      ...(errorKind === "invalid_json" || errorKind === "validation"
        ? { validationError: validationError ?? errorKind } : {}),
    };
  }

  async function understand<T>(req: UnderstandRequest<T>): Promise<Result<T>> {
    if (!isMasked(req.input) || !isMasked(req.system)) return blocked();
    const attempts: Attempt[] = [];
    const first = await attempt("claude", req);
    attempts.push(...first.result.attempts);
    if (first.result.ok) return first.result;
    if (first.validationError) {
      const retry = await attempt("claude", {
        ...req, input: `${req.input}\n\nValidation error: ${first.validationError}. Return JSON matching the supplied schema.`,
      });
      attempts.push(...retry.result.attempts);
      if (retry.result.ok) return { ...retry.result, attempts };
    }
    for (const model of ["muse", "gemini"] as const) {
      const next = await attempt(model, req);
      attempts.push(...next.result.attempts);
      if (next.result.ok) return { ...next.result, attempts };
    }
    return failed(attempts);
  }

  async function twoLock<T>(req: UnderstandRequest<T>): Promise<{ claude: Result<T>; muse: Result<T> }> {
    if (!isMasked(req.input) || !isMasked(req.system)) return { claude: blocked(), muse: blocked() };
    const [claude, muse] = await Promise.all([attempt("claude", req), attempt("muse", req)]);
    return { claude: claude.result, muse: muse.result };
  }

  return { understand, twoLock };
}
