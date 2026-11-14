# Model router

```ts
import { understand, twoLock, createDefaultRouter } from "@sahaj/adapters";
import { ScamJudgement } from "@sahaj/shared";

const req = {
  task: "shield.classify",
  system: "Classify this masked message for scam signals.",
  input: "Send <OTP> to <MOBILE_10> immediately.",
  schema: ScamJudgement,
} as const;

const result = await understand(req);
if (result.ok) console.log(result.model, result.data.is_scam);
const locks = await twoLock(req); // Compare the two successful judgements yourself.

const router = createDefaultRouter({
  onTrace: (attempt) => console.log(attempt), // Metadata only.
});
await router.understand(req);
```

`understand` calls Claude, retries Claude once for JSON/schema validation
failures with a safe validation summary appended to the input, then tries Muse
and Gemini. Refusals, truncation, transport failures, and timeouts move straight
to the next provider. Fallbacks receive the original request. Each call returns
a discriminated `Result<T>` and ordered attempts; model failures do not throw.

`twoLock` calls Claude and Muse concurrently, once each, with independent results
and attempt lists. It does not fall back to another model. It leaves agreement
and the action decision to the caller.

Defaults: `effort: "low"`, `timeoutMs: 10000` **per attempt**. The router enforces
the deadline even for an injected provider that ignores cancellation. Built-in
providers receive an abort signal; SDK automatic retries are disabled. A caller
can therefore see up to four attempts in `understand`. Anthropic's optional
server-side fallback runs inside its single HTTP request.

The guard rejects four or more consecutive decimal digits in either prompt,
including non-ASCII decimal digits, before calling any provider. No token is
exempted: `<MOBILE_10>`, `<OTP>` and `<URL:example.com>` pass, but
`<URL:1234.example>` fails. The caller must mask text before using the router.

Trace events contain only `model`, `task`, `ms`, `ok`, and optional `errorKind`.
Keep `task` a fixed identifier such as `shield.classify`. Provider errors, output,
Zod custom messages, received values, and paths are never traced or echoed into
the retry prompt. The retry summary uses fixed issue codes. A failing trace hook
does not change the result.

## Environment

| Variable | Use |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude (`claude-opus-5-5`) |
| `MUSE_API_KEY` | Meta Model API bearer token |
| `MUSE_BASE_URL` | Optional API root; defaults to `https://api.meta.ai/v1` |
| `MUSE_MODEL` | Optional model; defaults to `muse-spark-1.3` |
| `GEMINI_API_KEY` | Gemini (`gemini-3.8-flash`) |

Missing keys produce `not_configured` attempts and allow other providers to run.
The top-level functions lazily cache their router on first use. Use
`createDefaultRouter({ env, now, onTrace })` for explicit environment snapshots
or `createRouter({ claude, muse, gemini, now, onTrace })` for injection.

## Injected providers

A `Provider` receives the request, normalized effort/deadline, and `signal`.
Return `{ kind: "text", text: JSON.stringify(value) }`; the router parses JSON and
validates it with the request's exact schema. Throw `new ProviderError(kind)` for
a known failure category; other exceptions become `unknown` attempts.

The alternate `{ kind: "parsed", data: T }` contract is for SDK adapters that
have already validated the data with the exact request schema. Claude uses it to
avoid running Zod refinements/transforms twice. Its SDK parser is guarded so a
parse exception cannot hide `stop_reason: "refusal"` or `"max_tokens"`.

Schemas must be representable by the provider's JSON schema converter and API
subset. Unsupported schemas become failed attempts. Use JSON-compatible schemas
such as `ScamJudgement`; live provider behavior is not tested in the offline suite.

## Official references (checked 2026-11-14)

- [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude refusal fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Meta SDK support](https://dev.meta.ai/docs/sdks) — no separate Meta SDK required.
- [Meta Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions)
- [Meta structured output](https://dev.meta.ai/docs/structured-output)
- [Meta reasoning effort](https://dev.meta.ai/docs/reasoning)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google GenAI JavaScript SDK](https://github.com/googleapis/js-genai)
