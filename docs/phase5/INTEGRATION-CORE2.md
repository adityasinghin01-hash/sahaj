# Core 2 Integration Requests (Owned Outside AGY-P5C2)

AGY-P5C2 intentionally left all files outside its ownership untouched. The seams below are required to wire Core 2 into the full worker loop, child mobile app, and Kiro Phase 2/3 Command Kit without altering `/api/core2/**` contracts.

## 1. Cron Tick Hook (`apps/api/src/app/api/cron/tick/route.ts`)

Currently `POST /api/cron/tick` drains `claim_raw_events` and `dispatch_raw_event` only. Add Core 2 watch tick progression after `claim_raw_events`:

```ts
import { getCore2Service } from "@/lib/core2";

// Inside authenticated POST /api/cron/tick handler (after x-cron-secret check):
const watchTick = await getCore2Service().tickDueWatches(25);
```

- `tickDueWatches(limit)` calls `core2_tick_due_watches` (`FOR UPDATE SKIP LOCKED`), evaluates `@sahaj/gate` (`check_in` for subjects entering `checking_in`; `urgent_responder` for trusted contacts upon `escalated`), enqueues fenced `public.outbox` rows + `core2_dispatch_fences`, and appends signed `timeline_events`.
- Worker dispatch claiming Core 2 outbox items should call `SELECT public.core2_claim_fenced_dispatch(p_outbox_id, now())` inside the worker delivery transaction before calling Twilio/push providers; if it returns `false`, skip delivery and rely on the `failed` status written by the fence.

## 2. Next.js Standalone Runtime WASM Loading (`apps/api/next.config.ts`)

`apps/api/next.config.ts` currently lists `transpilePackages: ["@sahaj/adapters", "@sahaj/atlas", "@sahaj/gate", "@sahaj/shared"]`. `@sahaj/gate` imports `@cedar-policy/cedar-wasm/nodejs`, whose CommonJS glue resolves `path.join(__dirname, "cedar_wasm_bg.wasm")` at load time.

- Dynamic import in `apps/api/src/lib/core2/supabase.ts` (`loadGateModule()`) keeps `next build --webpack` passing during `collect page data`.
- For standalone production `next start` runtime execution of `/api/core2/**` routes that invoke `evaluateGate`, add:

```ts
serverExternalPackages: ["@cedar-policy/cedar-wasm"],
```

to `apps/api/next.config.ts` so Node loads `cedar_wasm_bg.wasm` from `node_modules/@cedar-policy/cedar-wasm/nodejs/`.

## 3. Child App Wiring (`apps/child/lib/api.ts`, `apps/child/app/{sos,watch,safe}.tsx`)

`apps/child/lib/api.ts` currently exposes only Shield endpoints (`/api/app/**`). Add typed methods hitting the frozen Core 2 routes (sending `Authorization: Bearer <token>`, optional `X-Sahaj-Family-Id`, and a unique `Idempotency-Key` per action):

- `apps/child/app/sos.tsx`:
  - Trigger (`POST /api/core2/sos`) after the 3s hold + countdown -> render `sos.status`, `contacts_notified_count`, and keep responder status unconfirmed until `sos.responder_accepted === true`.
  - Cancel / Safe (`POST /api/core2/sos/:sosId/cancel` with `{ reason: "false_alarm" | "im_safe", expected_version }`).
- `apps/child/app/watch.tsx`:
  - Start watch (`POST /api/core2/watches` with `{ eta_minutes, grace_minutes, timezone, from_label, to_label, cab_note }`).
  - Extend `+15m` (`POST /api/core2/watches/:watchId/extend` with `{ add_minutes: 15, expected_version }`).
  - Mark reached safe (`POST /api/core2/watches/:watchId/safe` with `{ expected_version }`).
  - Cancel (`POST /api/core2/watches/:watchId/cancel` with `{ expected_version }`).
- `apps/child/app/safe.tsx`:
  - Main safe hoon (`POST /api/core2/reassurance` with `{ kind: "im_safe", recipient_person_ids, voice_post_id? }` after uploading audio via existing `/api/media/voice/**` upload flow with `voice_share:<recipient>` consent).
  - Sharing preferences toggles (`GET / PUT /api/core2/reassurance/preferences`) and trusted contacts screens (`GET/POST /api/core2/trusted-contacts`, `PATCH`, `/approve`, `/revoke`).

## 4. Kiro Phase 2/3 Reconciliation (`Core2DispatchPort` / `DispatchAuthorizer`)

Because Phase 2/3 branches (`singhal/phase23-integration`) and `COMMAND-KIT.md` are not merged on `main` (`11af384`), Core 2 defines a minimal typed port `Core2DispatchPort.enqueueAuthorized` in `apps/api/src/lib/core2/contracts.ts`, backed in `apps/api/src/lib/core2/supabase.ts` by `public.outbox` + `public.core2_dispatch_fences`.

When merging Phase 2/3 with Phase 5:
1. Replace or wrap the `public.outbox` insert inside `createSupabaseDispatchPort` with Kiro's `enqueueAuthorized` / `DispatchAuthorizer` so outbound dispatches also write to `dispatch_ledger`.
2. Preserve `core2_dispatch_fences` linkage (`trusted_contact_id` / `watch_id`) and have Kiro's claimer call `core2_claim_fenced_dispatch` before `dispatch_ledger` transitions from `queued` to `claimed`.
3. Keep migration timestamps ordered cleanly (`20261114201500..20261114213000` sit strictly before `20261114230000_phase5_core2.sql`).

## 5. Auth Membership Onboarding

`authenticateCore2Actor` requires an active `family_memberships` row (`revoked_at IS NULL`) and corresponding `people` row; dev/onboarding scripts must provision `family_memberships` for parent/child/circle actors before hitting `/api/core2/**`.
