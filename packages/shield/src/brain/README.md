# Shield brain integration

```ts
import { buildShieldGraph, handleScheduledJob, type ShieldDeps } from "@sahaj/shield";

// Implement ShieldDeps using the host's persistent adapters.
const graph = buildShieldGraph(deps);
const state = await graph.invoke({ event: maskedShieldEvent });
const { verdict, verdictId } = state.decision;

// The durable worker routes these two names back to this package:
await handleScheduledJob(job.name, job.payload, deps);
```

`deps` above is the host's `ShieldDeps`; the complete port signatures are in `types.ts`. Register this compiled graph with Atlas. It has no checkpointer. Input is `{ event: ShieldEvent }`; output `decision` has the gated `verdict` and persisted `verdictId`.

## Host responsibilities

- `db.getParent` returns `{ id, family_id, line_id? }`. `line_id` identifies Maa's configured Aasha Didi call line; the brain does not infer a number. Scope DB queries by family and parent. The brain also filters returned history by parent/family and the last thirty minutes relative to `now()`.
- `db.insertVerdict({ event, parent, verdict })` persists the gated verdict and returns `{ id }`. Use the event's `idempotency_key` for uniqueness. Publish verdict changes through the existing Supabase realtime adapter. The child-facing projection must contain the verdict/card, not the event or Maa's inbox.
- `db.getVerdict(verdictId)` returns `{ id, event, parent, verdict }` for durable jobs. `hasChildReaction({ verdictId })` means **any tap/reaction**, not notification delivery. Keep reaction state durable.
- `gate.check({ familyId, action })` returns `{ allowed }`. The setup flow owns preapproval of safety actions. A failed/denied check fails closed and is signed. Jobs check the gate again, so revoked consent applies.
- `sign(row)` must sign **and persist** each timeline row. Node outcomes, individual gate decisions, call outcomes, alerts, schedules and escalation are recorded. Signing errors propagate. Fixed metadata never contains raw messages, phone/line identifiers, URLs, provider errors or prompts.
- `notify.childCard` is a child-app card **and push** (`push: true`), quiet only for yellow. `whatsapp.sendShieldAlert` receives the same verdict plus `📞 Call Maa now` for red. They receive no event/inbox text. Honor `offer1930` and the gated verdict action list.
- `calls.callParent` initiates Aasha Didi's call for the configured `lineId` and reports `answered`, `busy`, `no_answer` or `failed`. The first call is attempt one. Attempts two and three are durable `retryCallParent` jobs; no fourth attempt is emitted. A missing line is signed as skipped while child alerts still run.
- `scheduler.after(delayMs, name, payload)` durably enqueues jobs. `retryCallParent` has `{ verdictId, attempt: 2 | 3 }`; `shield.no_reaction_check` has `{ verdictId }`. The delay is two minutes divided by positive finite `DEMO_TIMER_SCALE` (default one). There are no in-memory escalation waits.
- The host scheduler must deduplicate job delivery by verdict/name/attempt; external calls and Atlas should also use these identifiers as idempotency keys. The brain does not introduce an in-memory job ledger. `atlas.startCircleChain` takes `{ verdictId, familyId, parentId }`; it owns the family-chain workflow.

## Decisions and safety

Rules are injected via `evaluate(event, recentEvents) → { verdict, needs_ai, links }`. Rules remain responsible for look-alikes, APKs and their bilingual reasons. A rules-red or Safe-Browsing-red result skips AI. Otherwise only `masked_text` reaches the adapters' `twoLock`, with additional Unicode digit-run masking and a digit-free fixed system prompt. No history, IDs, context, line or numbers enter the prompt.

Both scam judgements raise to red; disagreement or one successful scam judgement raises to yellow. Failed checks cannot independently raise to red. Existing rules risk is never downgraded. `models_agreed` lists both successful model names only when both agree. Provider failure contributes a fixed bilingual availability reason.

Green produces no effects. Yellow produces a quiet card/push. Red confirms the device's existing red screen, or calls Maa for keypad/gateway/busy-watch events, and sends WhatsApp plus app push. With approved `circle_chain`, the reaction-check job starts Atlas if no tap was recorded. Only a literal `event.context.money_already_left === true` adds `offer_1930`. Arbitrary rule-supplied actions are replaced by this ladder; nothing blocks, deletes or hangs up calls/messages.

## Link checks and configuration

- `SAFE_BROWSING_KEY` configures Google's fixed v4 endpoint. Only that endpoint uses normal `fetch`; redirects are rejected. Inject `safeBrowsingFetch` in tests. The documented POST includes `client`, `threatInfo`, URL entries and threat/platform types; batches contain at most five hundred entries.
- `cache.get/set` stores reputation results under `shield.domain.v1:<actual hostname>`, with TTL **86400 seconds**. Cached URL coverage prevents a safe path from blessing other paths or one bad short URL from contaminating every URL at a shared shortener. Expanded destinations are cached under their own domains. Unavailable checks are never cached as clean.
- Common shortener hosts expand through `createSandbox()`. HTTP(S) only; no credentials; HEAD with GET fallback only when HEAD is unsupported. Every redirect hop re-resolves and rejects all non-public DNS answers. The transport pins a validated IP, preserves TLS hostname/certificate checks, disables connection pooling, and validates the actual connected address. Five redirects maximum; no body is read/parsed/rendered.
- Private, loopback, link-local, CGNAT, metadata, unspecified, multicast, mapped target, reserved and IPv6 transition ranges are refused. An IPv4-mapped socket representation of an otherwise public IPv4 peer is normalized for comparison.
- A cumulative two-second deadline covers the whole link node, including cache and DNS; the sandbox also enforces two seconds per expansion. AI has a one-second outer deadline and nine-hundred-millisecond parallel provider attempt deadlines. These are operation deadlines, not response-ladder waits.
- Unavailable/blocked links add a bilingual unverified reason and a yellow floor. Network/cache errors cannot turn a verified threat green. Production latency also depends on the host DB/gate/sign/notification/call adapters; the offline acceptance test proves rules-red completion below four seconds, not live delivery to a handset. Response branches run concurrently so a slow parent call cannot delay either child-alert request.

Default AI uses the existing `@sahaj/adapters` router. Optional `twoLock`, `sandbox`, `safeBrowsingFetch`, `now` and `env` injections support deterministic offline tests. No live services are needed to import or test this graph.

References checked for C-02: [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api), [Google v4 lookup guide](https://developers.google.com/safe-browsing/v4/lookup-api), [threatMatches.find](https://developers.google.com/safe-browsing/reference/rest/v4/threatMatches/find).
