# Tasks for ChatGPT / Codex (web)
Pick one task ID. Follow AGENTS.md. One branch + one PR per task.

## G1 · SMS gateway for keypad parents (Core 3 step 3.4, server side)
A spare Android phone in "gateway mode" forwards every SMS a keypad parent forwards to "1 Sahaj SMS" to our server.
- Add `packages/shield/src/gateway/` with `handleSmsGateway(req, deps)`: web-standard Request → Response. Verify a shared secret header (`x-sahaj-gateway-secret`, constant-time compare, env `SMS_GATEWAY_SECRET`); body `{from, body, received_at, gateway_id}`; `from` must be a registered keypad parent (new db function `findParentByPhoneHash(sha256 of last 10 digits)` — store only hashes); mask the body with the existing rules `mask()`; insert a ShieldEvent with `channel: "gateway_sms"`, idempotency key = sha256(gateway_id + received_at + body); hand to the brain via the existing runtime (`runBrainForEvent`) through `waitUntil`; respond < 1 s.
- Unknown sender → 200 `{ignored:true}` and nothing stored. Wrong secret → 401.
- Wire it into `src/runtime` (new bound handler `handleSmsGateway`) and document the route in `src/runtime/README.md` (`/api/sms/gateway`).
- Tests: valid forward → event + brain run; replay → duplicate; wrong secret; unknown sender; body with an OTP is masked before storage.

## G2 · Router tracing with Langfuse (masked)
- `packages/adapters/src/llm/trace-langfuse.ts`: an `onTrace` implementation that sends one Langfuse trace per router attempt (model, task, ms, ok, error category, token usage if available). Use the official Langfuse JS SDK (check its current docs). Never send prompt or output text — only metadata. Env: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`; if unset → no-op.
- Tests with a fake Langfuse client: payload has no text fields; missing env → no-op; Langfuse throwing never breaks routing.

## G3 · Shield security review + fixes
Read `packages/shield/src/**` and `packages/adapters/src/llm/**` against the ground rules in AGENTS.md. Look for: any path where unmasked text or digits reach the router or the database; signature/timestamp checks that can be bypassed; missing idempotency; SQL built by string concatenation; SSRF gaps in `brain/sandbox.ts`; secrets in logs; RLS gaps in `infra/supabase/migrations/*_shield*.sql`.
- Fix what you find (each fix with a test). Put the full findings list in the PR description (file:line, issue, fix or "not fixed + why").

## G4 · Keypad call gateway screening agent (Core 3 step 3.6)
Only if the Lava test T10 passes (call divert works). Write `packages/shared/prompts/sarvam/screening.md` (a Sarvam phone-agent script: asks an unknown caller who they are and why, in Hindi; known scam scripts → polite end + alert child; genuine → transfer to the parent's second SIM; saved family numbers go straight through) and `packages/shield/src/gateway/screening.ts` (tool `screen_caller`: input = what the caller said (masked) + caller type; output = allow / end + reason; uses rules + router two-lock). Tests with fakes.
