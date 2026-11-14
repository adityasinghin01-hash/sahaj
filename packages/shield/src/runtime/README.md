# Joined Shield runtime: Singhal's integration contract

```ts
import postgres from "postgres";
import { createShieldRuntime } from "@sahaj/shield";

const shield = createShieldRuntime(ports);
```

Create one runtime per server process. `ports.sql` is a **service-role direct or session-mode Postgres connection pool** (`postgres(url, { prepare: false, max_pipeline: 1 })`). Dedicate this pool to Shield storage; callbacks such as `sign`, push and the scheduler must use their own connections if they access Postgres. Brain execution reserves a pool connection, so sharing its exhausted pool with callbacks would deadlock. Transaction-mode poolers are incompatible with the session advisory lock used to serialize brain execution across workers. The runtime uses the two base Shield migrations and the core tables documented in `../db/README.md`, plus the C-04 migration below for drills/evidence; it performs no DDL. It does not own connection shutdown.

## Exact outside-world ports

The exported `ShieldRuntimePorts` in `types.ts` is the authoritative, compiler-checked contract. All these ports are required except the explicitly optional environment fields and log. Adapters must use methods returning promises, including no-result operations.

```ts
import type { Sql } from "postgres";
import type { understand, twoLock } from "@sahaj/adapters";
import type {
  ChildCard, LinkResult, TimelineRow, ShieldTimelineEntry, ShieldCircleInput,
} from "@sahaj/shield";
import type { ShieldAction } from "@sahaj/shared";
```

In expanded form the ports are:

```ts
interface Ports {
  sql: Sql;
  router: { understand: typeof understand; twoLock: typeof twoLock };
  whatsapp: {
    sendFamilyCheckCard(input: {
      familyId: string; toPersonId: string; claimedName: string;
      askedWhat: string; checkId: string;
    }): Promise<void>;
    sendShieldAlert(input: ChildCard & { callToAction: string }): Promise<unknown>;
  };
  push: { childCard(input: ChildCard): Promise<unknown> };
  calls: {
    getParentLine(input: { familyId: string; parentId: string }): Promise<string | null>;
    callParent(input: {
      familyId: string; parentId: string; lineId: string; verdictId: string; attempt: number;
    }): Promise<{ status: "answered" | "busy" | "no_answer" | "failed" }>;
    startResponderCall(input: {
      familyId: string; toPersonId: string; checkId: string;
    }): Promise<void>;
    startCallback(input: { familyId: string; parentId: string; line: string }): Promise<void>;
  };
  scheduler: {
    after(delayMs: number, name: string, payload: Record<string, unknown>): Promise<void>;
    claim(key: string): Promise<boolean>;
  };
  atlas: {
    startCircleChain(input:
      | { verdictId: string; familyId: string; parentId: string }
      | { familyId: string; parentId: string; reason: string }
    ): Promise<unknown>;
    bridgeChild(input: { familyId: string; parentId: string; reason: string }): Promise<void>;
  };
  gate: {
    check(input: { familyId: string; action: ShieldAction }): Promise<{ allowed: boolean }>;
  };
  sign(entry: ShieldTimelineEntry): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  env: {
    SHIELD_DEVICE_PAIRING_SECRET: string; // >= 32 characters
    SAFE_BROWSING_KEY?: string;
    DEMO_TIMER_SCALE?: string;
    SMS_GATEWAY_SECRET?: string;          // >= 32 characters; needed only for /api/sms/gateway
  };
  clock: { now(): Date };
  cache: {
    get(key: string): Promise<LinkResult | null | undefined>;
    set(key: string, value: LinkResult, ttlSeconds: number): Promise<unknown>;
  };
  log?: { error(message: string, meta?: Record<string, unknown>): void };
}
```

`ChildCard = { verdictId: string; familyId: string; parentId: string; verdict: Verdict; quiet: boolean; push: true; offer1930: boolean }`. `Verdict` is the shared schema/type. `push.childCard` must persist the app card and request push delivery; yellow is quiet. `whatsapp.sendShieldAlert` sends the same card, with `📞 Call Maa now` for red. Neither receives the phone event or inbox text. The existing `buildShieldAlert(verdict, { parentName, channel, lang })` message builder is available for adapter presentation; the host chooses names/language from its own family records.

`LinkResult = { domain: string; threat: boolean; status: "checked" | "unavailable" | "blocked"; checkedUrls?: string[] }`. Cache TTL is in **seconds**; the brain uses 86400. Host-side call line lookup returns the configured Aasha Didi line, not a guessed phone number. A missing line returns null and is signed as skipped by the brain.

`ShieldTimelineEntry` is the union of:

```ts
type TimelineRow = {
  familyId: string; parentId: string; eventKey: string; verdictId?: string;
  step: string; status: "ok" | "denied" | "failed" | "skipped";
  action?: ShieldAction; details?: Record<string, string | number | boolean>;
};
type VoiceTimelineEntry = {
  familyId: string; type: string; line: string; data?: Record<string, unknown>;
};
```

`sign` must **sign and persist**, not merely return a signature. Brain entries contain fixed metadata. Existing voice entries can include masked descriptions and family names: apply the family's access policy and the existing timeline writer's retry policy. Runtime fixed error logging never logs provider errors, secrets or message text. Supply Vercel's `waitUntil` (or an equivalent lifecycle primitive), not a bare unobserved fire-and-forget callback.

`scheduler.claim` is an atomic durable run-once ledger, returning true once for a key across workers/restarts. `scheduler.after` stores durable jobs; do not implement delays with process timers. Scheduler delivery must be deduplicated by job name, verdict/check id and attempt. Existing tool jobs claim their own run-once keys; brain jobs rely on host delivery deduplication. The host must make external call/Atlas effects idempotent with these same identifiers. The clock and signing ports must be consistent with production time.

## Returned API and routing

```ts
shield.handleShieldPair(req: Request): Promise<Response>
shield.handleShieldEvent(req: Request): Promise<Response>
shield.handleSmsGateway(req: Request): Promise<Response>
shield.createPairingCode({ familyId, userId }): Promise<CreatePairingCodeResult>
shield.shieldTools.run(name, ctx, input): Promise<ToolOutputForName>
shield.handleScheduledJob(name: string, payload: unknown): Promise<void | ShieldJobResult>
shield.runBrainForEvent(eventId: string): Promise<{ verdict: Verdict; verdictId?: string }>
```

`ctx = { familyId: string; parentId: string }`. The generic `run` preserves each tool's input/output type and uses the original Zod validation/fixed safe fallback. Names: `classify_scam`, `check_message`, `family_check`, `family_check_result`, `check_code_word`, `money_sent`. A runtime-invalid name throws. Inputs/outputs remain those exported by `src/tools`; there is no second JSON envelope to translate.

Singhal adds these **five one-line Next.js route exports**, each in its own `route.ts`, with `shield` imported from his server-only runtime singleton. For tools import `isShieldToolName` from Shield. These examples use native `Response.json`.

```ts
// /api/shield/pair
export const POST = (req: Request) => shield.handleShieldPair(req);
// /api/shield/pair/code
export const POST = async (req: Request) => Response.json(await shield.createPairingCode(await requireChildFamily(req)));
// /api/shield/event
export const POST = (req: Request) => shield.handleShieldEvent(req);
// /api/sms/gateway
export const POST = (req: Request) => shield.handleSmsGateway(req);
// /api/sarvam/tool/[name]
export const POST = async (req: Request, route: { params: Promise<{ name: string }> }) => { const { name } = await route.params; if (!isShieldToolName(name)) return Response.json({ error: "unknown_tool" }, { status: 404 }); return Response.json(await shield.shieldTools.run(name, await requireSarvamCtx(req), await req.json())); };
```

`requireChildFamily(req): Promise<{ familyId: string; userId: string }>` authenticates the logged-in child and authorizes their family; derive ids from the session/membership, not request JSON. `requireSarvamCtx(req): Promise<{ familyId: string; parentId: string }>` authenticates the provider webhook and resolves its active call/session to the family and parent. These two auth helpers and the server-only singleton belong to the host. The runtime independently checks that tool parents belong to their family. Phone events authenticate with `SHIELD_HEADERS` and the shared raw-body HMAC rule. Pairing exchanges a single-use code for a device secret.

## SMS gateway: `/api/sms/gateway`

A spare Android phone in gateway mode forwards every SMS that a keypad parent forwards to "1 Sahaj SMS".

- Auth: header `x-sahaj-gateway-secret` must equal env `SMS_GATEWAY_SECRET` (compared in constant time over SHA-256 digests). Wrong or missing → `401 {error:"unauthorized"}`. A missing or short env secret → `500`, nothing accepted.
- Body (JSON, ≤ 16 KB): `{ from: string, body: string, received_at: ISO-8601 with offset | unix ms, gateway_id: [A-Za-z0-9._-]{1,64} }`.
- `from` is looked up only as `hex(SHA-256(last 10 digits))` in `public.shield_gateway_parents` (migration `20261114000500_shield_gateway.sql`, service role only). Not registered → `200 {ignored:true}` and nothing is stored. The host's onboarding inserts `(phone_hash, family_id, parent_id)`; `numberFingerprint()` computes the hash.
- The body is masked with the rules `mask()` (plus the digit mask as a second pass) before storage; the raw body and number are never stored or logged. The event is `channel: "gateway_sms", kind: "sms"`, no device. Idempotency key = `sha256(gateway_id + "\n" + received_at as UTC ISO + "\n" + masked body)`.
- New event → `200 {ok:true, event_id}` after one lookup and one insert; `runBrainForEvent` runs through `waitUntil`. Replay → `200 {ok:true, duplicate:true}`, no second brain run.
- With `ports.sql` the runtime uses `createGatewayPg`; offline test storage may set `ShieldRuntimeDb.gateway`.

## Workflows and durable jobs

- A new authenticated phone event is inserted once. The real handler gives its brain promise to `waitUntil`, returns 200, and the runtime loads the event by id. It evaluates `buildVerdict`/`findPatterns` over the current event and bounded history, maps extracted domains to URLs, uses the injected router's `twoLock` when required, persists the gated verdict, alerts and signs. Client `local_level` and `matched_rules` cannot force a server decision.
- `runBrainForEvent` serializes across runtimes/workers with a session advisory lock. If a verdict already exists it returns that decision without rerunning the graph or notifications. Autocommit writes ensure the verdict exists before alert calls begin. A phone replay returns `{ ok: true, duplicate: true }` and does not enqueue the brain again.
- Existing voice tools retain their rules/AI logic and fixed speech/bridge/family-check flow. Their `atlas.alertChild` adapter creates a minimal masked voice event, gates and persists the tool verdict, then invokes the brain's alert response branch for app/push and red WhatsApp. It does **not reclassify the tool result through another graph** or call Maa a second time. Bridges and circle-chain operations are gated and kept alive by `waitUntil`. Family-check waiting jobs use the existing scheduled tools. This joins their intentionally different decision interfaces without changing their modules.
- `retryCallParent`: `{ verdictId: string; attempt: 2 | 3 }`; `shield.no_reaction_check`: `{ verdictId: string }`. Both load durable verdicts, recheck consent and sign. `feedback_at IS NOT NULL OR child_feedback IS NOT NULL` counts as a reaction, including a call-parent tap if the host records `feedback_at` for it.
- `shield.family_check.escalate` and `shield.family_check.callback`: `{ check_id: string; family_id: string; parent_id: string }`. Runtime supplies the job ledger and conditional `asked → no_answer` write missing from the base DB adapter. The host's authenticated WhatsApp/call answer handler persists `confirmed`/`denied` and `answered_at` in `family_checks`; that answer route is outside this card.
- Delays are two minutes for brain retry/no-reaction and voice callback, one minute for family escalation, divided by positive finite `DEMO_TIMER_SCALE` (default one). No in-process escalation timers are introduced.

## Tests and boundaries

`pnpm -F @sahaj/shield typecheck` and `pnpm -F @sahaj/shield test`. The joined scenes use real handlers, real JSON rules, real graph and a real router with fake providers/effects. With `DATABASE_URL`, they use `createShieldRuntimePg` and the real existing DB layer; otherwise they inject `ShieldRuntimeDb` through `ShieldRuntimeTestPorts`. The test DB requires the migrations/core fixture schema and service-role access. To create a throwaway local cluster and run the **whole** Shield suite: `bash packages/shield/test/e2e/run-postgres.sh` (Postgres binaries default to `/opt/homebrew/bin`; override `PG_BIN`). This runner deletes only its own temporary cluster on exit.

No production migration or external service calls happen at runtime construction. The host remains responsible for service credentials, auth helpers, durable scheduling, notification/call delivery, timeline persistence/retries and answer/reaction recording. A crash after verdict persistence but before every effect completes needs host reconciliation/idempotent delivery; this card does not add a transactional outbox. A masked `<URL:host>` only permits domain/root reputation checking, because the phone has already removed its original path.

## C-04: helper drills and evidence packs

Apply `20261114000400_shield_drills_evidence.sql` after the earlier Shield migrations. `createShieldRuntimePg` now supplies `db.drills` and `db.evidence`. They are optional on **offline test** storage for compatibility; the corresponding feature fails closed when its storage is absent.

Add these two ports to enable the new features:

```ts
// All types are exported by @sahaj/shield.
const extraPorts = {
  drillStories: stories, // readonly DrillStory[]; inject the shared catalogue
  timeline: {
    async entriesFor(eventIds: string[]): Promise<EvidenceTimelineEntry[]> {
      // Read the host's persisted, signed actions for exactly these DB event IDs.
      return timelineStore.entriesFor(eventIds);
    },
    async chainHashFor(eventIds: string[]): Promise<string> {
      // Return its real SHA-256 checkpoint as 64 hex characters.
      return timelineStore.chainHashFor(eventIds);
    },
  },
};
```

`DrillStory = { id, scam_type, story_hi, good_answers: string[], risky_answers: string[], teach_line_hi }`. No production stories are fabricated while the shared catalogue is absent. An empty catalogue returns no drill. With ten or fewer stories, the exact last-ten exclusion eventually exhausts the pool and returns null; more stories must be supplied before another unseen drill can be issued.

`EvidenceTimelineEntry = { at: string, step: string, status: "ok" | "denied" | "failed" | "skipped", action?: string, details?: string, money_sent?: boolean }`. Resolve database event IDs to the host's existing event keys/verdict IDs inside this adapter. Read the actual signed records/checkpoint, with the host's normal snapshot/retry policy. `money_sent` must be an explicit parent report associated with the incident. No timeline implementation or signature verification is invented by Shield.

The runtime adds:

```ts
await shield.pickDrill({ familyId, parentId, now: clock.now() }); // { drill_id, story_hi } | null
await shield.shieldTools.run("drill_answer", { familyId, parentId }, { drill_id, said });
await shield.scamSense({ familyId, parentId, month: "2026-11" });
await shield.buildEvidencePack({ familyId, verdictId, viewerUserId });
```

Use `isShieldToolName` / `shieldTools` / `ShieldToolName` from the **package root or runtime** for the complete seven-tool registration. The legacy internal `src/tools` map stays unchanged. Input validation, family/parent membership checks, issuance lookup, AI scoring and answer writes are inside the drill tool's 2800 ms response budget. Its router soft budget is 1800 ms, each provider attempt requests 600 ms, and storage/provider failures produce a fixed kind fallback. A slow model uses keyword scoring: any affirmative risky phrase = zero, one good phrase = one, two or more good phrases = two. Local keyword checks happen before masking so the public helpline keyword cannot collide with a different masked number; only masked text reaches providers and storage. Numeric Unicode digits and separated numbers are masked. First answers are serialized and immutable. A timed-out late read/model result cannot initiate an answer write. Already-started database operations may settle after the speech deadline; the runtime keeps their lifecycle promise alive.

Weekly means seven rolling days from the latest **asked** drill, including unanswered drills. Selection and answers use one parent-scoped advisory transaction lock across workers. `scamSense` uses UTC calendar months, averages completed 0–2 scores and multiplies by 2.5 (one decimal place). `drills_this_month` counts scored drills; unanswered ones are excluded. Trend compares the unrounded current average with the previous month's; no comparable answers means `flat`, and an empty current month displays zero. The tool sets `teach_line_played` when handing off its teaching line; physical audio playback is the host's responsibility.

The evidence API authorizes a current `family_members.role = 'child'` before reading the red verdict and all its source events. It distinguishes planned actions from signed performed-action statuses, recognizes the existing server-authored `voice.money_sent` report, and says `unknown; ask Maa` when no money report exists. Its number field always says `number: ask Maa / check her call log`. The database stores **only receipts**: canonical creation time, the SHA-256 contents hash and original chain hash, family/verdict/viewer references. Child membership and red-incident scope are checked again at the receipt write.

All returned pack fields satisfy the card's strict four-digit rule, including hash and time fields. `created_at` is a UTC RFC 850 display timestamp with a two-digit year (for example `Saturday, 14-Nov-26 10:00:00 GMT`), and `chain_hash` is losslessly encoded as `hex-ap:` plus 64 letters `a..p` for original hex nibbles `0..f`. Use `decodeChainHash(pack.chain_hash)` for the original standard hex checkpoint; `encodeChainHash` is also exported. The receipt keeps the original hex. No claim of verified signature is implied by the export itself. The contents hash covers the deterministic UTF-8 JSON of all returned pack fields **except export `created_at`**, so exporting unchanged incident content again has the same hash. The fixed helpline label alone retains `1930`.

The existing Postgres runner remains the C-03 regression gate and applies only its original two migrations. Run the additional C-04 runner to apply the new migration and execute the real concurrency, storage, scope, constraint and API-role RLS tests:

```sh
bash packages/shield/test/drills/run-postgres.sh
# Or against a disposable database with all three migrations and test role grants:
SHIELD_DRILLS_DB_TEST_REQUIRED=1 DATABASE_URL=... pnpm -F @sahaj/shield test
```

The extra runner grants the throwaway service login permission to assume the two test API roles; this grant is test bootstrap only, never a production migration. Without that explicit C-04 test flag, its three database scenarios skip. Both runners delete only their own temporary cluster. Neither runner changes an existing database.
