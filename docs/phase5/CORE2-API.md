# Phase 5: Core 2 API Contract & Screen Mapping

Status: **Proposed Contract (Phase 5 Core 2 Server)**  
Scope: Adult-child SOS, going-home watch & escalation, "I'm safe", trusted contacts lifecycle, Maa's reassurance / truth line, and authenticated bounded reads under `/api/core2/**`.  
Mobile & Cross-Lane Boundary: Current [`apps/child/lib/api.ts`](../../apps/child/lib/api.ts) calls `/api/app/**` for Shield only. `apps/child/**`, `apps/parent/**`, `packages/shared/**`, and `/api/app/**` are untouched in this phase; see [`INTEGRATION-CORE2.md`](./INTEGRATION-CORE2.md) for the client-wiring request.

---

## 1. Security, Auth & Persistence Invariants (All `/api/core2/**` Routes)

1. **Authentication (`getUser`)**:
   - Every endpoint requires `Authorization: Bearer <supabase_access_token>` verified via Supabase `auth.getUser(token)` (never local JWT decoding alone).
   - Invalid or missing bearer tokens return `401 { "error": "unauthenticated" }` with `WWW-Authenticate: Bearer` and `Cache-Control: no-store`.
2. **Tenant & Actor Derivation**:
   - Never trust `actorId`, `familyId`, `approved`, `verified`, or authorization booleans supplied in a request body.
   - Server queries `public.family_memberships` for rows matching `user_id` where `revoked_at IS NULL`:
     - `0` active memberships → `403 { "error": "forbidden" }`
     - `1` active membership → selected automatically unless `X-Sahaj-Family-Id` disagrees (`403`)
     - `>1` active memberships → caller MUST send `X-Sahaj-Family-Id: <uuid>`; omission returns `409 { "error": "family_selection_required" }`, non-member family returns `403`.
3. **Strict Request Parsing**:
   - All JSON bodies reject unknown fields (`strict` schema validation), invalid UUIDs, out-of-range integers, non-IANA timezones, or control characters (`400 { "error": "invalid_request" }`).
   - Empty or invalid `Idempotency-Key` headers on mutations return `400 { "error": "idempotency_key_required" }`.
4. **Scoped Idempotency**:
   - Mutations require `Idempotency-Key` (`1..128` printable ASCII chars).
   - Scoped deterministically per `(family_id, actor_person_id, action, sha256(key))`.
   - Same key + identical canonical payload hash → returns original persisted outcome (`idempotent_replay: true`, HTTP `200`/`201`/`202`).
   - Same key + changed canonical payload hash → `409 { "error": "idempotency_conflict" }`.
5. **Encrypted Durable Input Before `202` / State Change**:
   - Before queuing downstream workflow/outbox items, the server encrypts sensitive mutation payloads (SOS note, watch origin/destination/cab note, safe note) using `encryptWebhook` (`WEBHOOK_ENCRYPTION_KEY`) and records them in `public.raw_events` via `public.ingest_raw_event` (`source='core2'`).
   - Missing `WEBHOOK_ENCRYPTION_KEY`, `IDENTITY_HASH_SECRET`, or storage failure fails closed (`503 { "error": "storage_unavailable" }`) and never returns `200`/`201`/`202`.
6. **Authorized Outbox & Cedar (`@sahaj/gate`)**:
   - Routes NEVER invoke Twilio, Sarvam, WhatsApp, or Expo directly.
   - All external dispatches require:
     1. `@sahaj/gate` `evaluateGate` returning `'allow'` (with live `permissions`, `consents`, and `action_answers` where required). `'deny'` fails closed (`403` / persisted `denied` status); `'ask'` leaves work in `awaiting_approval` without dispatching.
     2. Enqueue into `public.outbox` (atomic with domain mutation or workflow lock) via typed `Core2DispatchPort`.
     3. Timeline signature via `public.append_timeline_event` (`Ed25519` + `SHA-256` hash chain) with deterministic `dedupeKey` and redacted `humanLine`.
7. **Common Error Envelope**:
   ```json
   {
     "error": "snake_case_code",
     "message": "Safe non-sensitive summary"
   }
   ```
   Status codes used across Core 2: `200`, `201`, `202`, `400`, `401`, `403`, `404`, `409`, `410`, `422`, `503`.

---

## 2. Resource Contracts

### 2.1 SOS (`/api/core2/sos`, `/api/core2/sos/:sosId`, `/api/core2/sos/:sosId/cancel`)

#### `POST /api/core2/sos`
Initiates an SOS emergency request for the authenticated `child` subject.
- **Role**: `child` (or explicitly trusted `circle`/`parent` acting on self). Never allows a caller to fabricate another person's SOS without matching `person_id`.
- **Headers**: `Authorization`, `Idempotency-Key`, optional `X-Sahaj-Family-Id`.
- **Body**:
  ```json
  {
    "subject_person_id": "uuid (optional, defaults to actor.personId; must equal actor.personId unless delegated)",
    "countdown_seconds": 10,
    "note": "optional <= 240 chars (encrypted at rest, never broadcast verbatim)",
    "client_triggered_at": "optional ISO-8601 UTC"
  }
  ```
- **Server Behaviour**:
  1. Encrypts payload into `public.raw_events` (`source='core2'`, `event_type='core2.sos.triggered'`).
  2. Creates `public.requests` (`kind='sos'`), `public.incidents` (`severity='critical'`, `state='open'`), and `public.core2_sos_events` (`status='countdown'|'escalated'|'pending_contacts'`, `version=1`).
  3. Resolves ONLY active, approved, consented, unrevoked, in-date `core2_trusted_contacts` for `(family_id, subject_person_id)` whose `scopes` includes `'sos'`, ordered by `rank ASC, id ASC`. Same-family membership alone does NOT resolve.
  4. Evaluates `@sahaj/gate` (`action='urgent_responder'`) for each eligible ranked contact; only `'allow'` contacts receive `public.assignments` (`status='offered'`) + authorized `public.outbox` dispatch items (`kind='core2.sos_alert'`).
  5. Records exact status truthfully:
     - `queued` when authorized outbox items were persisted (delivery/acceptance still `pending` — NEVER reports `"alerted"` / `"coming"` / `"accepted"` without persisted verified provider proof).
     - `pending_contacts` if zero active trusted contacts exist.
     - `awaiting_approval` / `denied` when Cedar returns `ask` / `deny`.
  6. Appends signed timeline entry (`core2.sos.triggered`) with redacted `humanLine` (e.g. `"SOS emergency request recorded"` — no address/note/phone).
- **Response (`202 Accepted`)**:
  ```json
  {
    "sos": {
      "id": "uuid",
      "family_id": "uuid",
      "subject_person_id": "uuid",
      "incident_id": "uuid",
      "request_id": "uuid",
      "status": "countdown | queued | pending_contacts | awaiting_approval | cancelled | safe | verified_accepted",
      "delivery_status": "none | queued | delivery_unknown | delivered | failed",
      "responder_accepted": false,
      "version": 1,
      "countdown_until": "ISO-8601 | null",
      "created_at": "ISO-8601"
    },
    "contacts_notified_count": 1,
    "dispatches": [
      { "assignment_id": "uuid", "contact_person_id": "uuid", "rank": 1, "status": "queued" }
    ],
    "idempotent_replay": false
  }
  ```

#### `POST /api/core2/sos/:sosId/cancel`
Cancels an active countdown or marks an SOS safe by the subject.
- **Body**: `{ "reason": "false_alarm | im_safe", "expected_version": 1 }` (both optional `expected_version` / `reason` enum).
- **Atomic Behaviour**: Locks `core2_sos_events` row `FOR UPDATE`, checks `version` if provided (`409 stale_version`), transitions `countdown` → `cancelled` or `queued`/`escalated` → `safe`, cancels NOT-YET-CLAIMED pending outbox items if any via fence without deleting/altering already-dispatched items, optionally enqueues `"safe"` follow-up if external alerts had already gone out, and appends signed timeline event.

#### `GET /api/core2/sos` & `GET /api/core2/sos/:sosId`
Bounded read (`limit` 1..50 default 20, `cursor` timestamp+id). Permitted for subject (`person_id`) or active `child` / `'sos'`-scoped `trusted_contact` for that subject. Never exposes encrypted notes, raw contacts, or private media paths.

---

### 2.2 Going-Home Watch & Escalation (`/api/core2/watches`, `/api/core2/watches/:watchId`, `/api/core2/watches/:watchId/extend`, `/api/core2/watches/:watchId/cancel`, `/api/core2/watches/:watchId/safe`)

#### `POST /api/core2/watches`
Starts a going-home safety watch.
- **Body**:
  ```json
  {
    "eta_minutes": 30,
    "grace_minutes": 10,
    "timezone": "Asia/Kolkata",
    "from_label": "Office, Connaught Place",
    "to_label": "Home, Lajpat Nagar",
    "cab_note": "optional <= 160 chars"
  }
  ```
  Rules: `eta_minutes` integer `1..240`; `grace_minutes` optional integer `1..60` (default `10`); `timezone` valid IANA zone; `from_label` & `to_label` non-empty `<= 160` chars.
- **Server Behaviour**:
  1. Validates no secret/injection, encrypts `from_label`, `to_label`, `cab_note` into `raw_events` (`source='core2'`, `event_type='core2.watch.started'`). NEVER stores plaintext route/cab in readable incident/outbox rows unless sharing preferences permit during escalation.
  2. Creates `core2_watches` (`state='active'`, `version=1`, `deadline_at = now + eta_minutes`, `grace_until = deadline_at + grace_minutes`, `next_tick_at = deadline_at`). Notice: **nobody is notified at watch start.**
  3. Appends signed timeline entry (`core2.watch.started`) without route/location text.
- **Response (`201 Created`)**: Safe watch DTO (includes `id`, `state: 'active'`, `version: 1`, `deadline_at`, `grace_until`, `timezone`, `created_at`). Route fields are NOT returned to third parties.

#### `POST /api/core2/watches/:watchId/extend`
Extends `deadline_at` and `grace_until` while `state IN ('active', 'checking_in')`.
- **Body**: `{ "add_minutes": 15, "expected_version": 1 }` (`add_minutes` integer `1..120`, `expected_version` required positive int).
- **Atomic Behaviour**: Row lock `FOR UPDATE`; rejects `safe` / `cancelled` / `escalated` (`409 invalid_watch_state`) or version mismatch (`409 stale_version`). Shifts `deadline_at = greatest(deadline_at, now) + add_minutes`, `grace_until = new_deadline + grace_minutes`, `state = 'active'`, `next_tick_at = new_deadline`, `version = version + 1`.

#### `POST /api/core2/watches/:watchId/cancel`
Cancels an un-escalated watch (`expected_version` optional/recommended). Rejects if already `safe` (`409`).

#### `POST /api/core2/watches/:watchId/safe`
**Core Task 3 — Transactional Safe-vs-Timeout Resolution**:
- **Actor**: Watch subject (`actor.personId === watch.subject_person_id`) OR explicitly delegated active trusted contact if permitted (default subject-only for `im_safe` clip/check-in).
- **Body**:
  ```json
  {
    "expected_version": 1,
    "voice_post_id": "uuid (optional existing consented voice clip for Maa)",
    "note": "optional <= 160 chars"
  }
  ```
- **Atomic Transaction (`public.core2_resolve_watch_safe`)**:
  1. Acquires `SELECT ... FROM public.core2_watches WHERE id = p_watch_id AND family_id = p_family_id FOR UPDATE`.
  2. If `expected_version` provided and differs (unless same idempotency key already committed this transition) → `409 stale_version`.
  3. If `state = 'cancelled'` → `409 watch_cancelled`.
  4. If `state = 'safe'` and matching `idempotency_key` → returns existing committed `safe` state idempotently without re-dispatching.
  5. Otherwise (`state IN ('active', 'checking_in', 'escalated')`):
     - Updates `core2_watches` → `state = 'safe'`, `safe_at = now()`, `next_tick_at = NULL`, `version = version + 1`.
     - If `incident_id` is attached, closes incident (`state = 'done'`) and expires unaccepted `offered` assignments.
     - Historical `outbox` rows that were ALREADY dispatched before `safe_at` remain intact with their separate reconciliation history (they cannot be "unsent" by changing a row).
     - Enqueues authorized safe reassurance notification(s) via Cedar + outbox ONLY if watch had already entered `checking_in` / `escalated` OR caller passed `voice_post_id` / requested reassurance.
     - Appends signed timeline entry (`core2.watch.safe`).
- **Concurrency Guarantee**: Any concurrent overdue tick worker calls `public.core2_claim_due_watches`, which locks `FOR UPDATE SKIP LOCKED` and checks `WHERE version = claimed_version AND state IN ('active', 'checking_in')`. If `/safe` committed first, a stale timeout tick sees `state = 'safe'` (0 rows updated), CANNOT re-escalate, and CANNOT insert a new dispatch!

#### `GET /api/core2/watches` & `GET /api/core2/watches/:watchId`
Authenticated bounded read (`limit` 1..50). Visible to subject and `child` role for status; escalated incident status visible to assigned trusted contact without route/cab/location unless preferences allow.

---

### 2.3 Trusted Contacts Lifecycle (`/api/core2/trusted-contacts`, `/api/core2/trusted-contacts/:id/{approve,revoke}`)

Canonical invariant: **Same-family membership (`family_memberships` / `circle`) alone is NOT a trusted emergency contact grant.** Dispatch resolves ONLY rows in `core2_trusted_contacts` where `state = 'active' AND revoked_at IS NULL AND now() >= effective_from AND (effective_until IS NULL OR now() < effective_until)` AND scope matches (`'sos' | 'watch_escalation' | 'reassurance'`).

- **`POST /api/core2/trusted-contacts`** (Invite contact):
  - Body: `{ "subject_person_id": "uuid (optional=self)", "contact_person_id": "uuid", "rank": 1, "scopes": ["sos", "watch_escalation", "reassurance"], "effective_from": "ISO-8601 (optional=now)", "effective_until": "ISO-8601 | null" }`.
  - Validates `contact_person_id !== subject_person_id`, both belong to `family_id` (`people` composite FK), `rank` `1..20`, `effective_until > effective_from`, non-empty `scopes`.
  - Creates row in `state = 'invited'` (or `'pending_consent'` if invitee differs). Does NOT become active until contact approval & consent exist.
- **`POST /api/core2/trusted-contacts/:id/approve`** (Approve + Consent):
  - Actor MUST be `contact_person_id` (authenticated active family member) or have explicit verified consent proof (`consent_id` referencing `public.consents` where `person_id = contact_person_id`, `purpose = 'trusted_contact'`, `answer = true`).
  - Records `consents` row (if contact is authenticated actor consenting), sets `approved_at = now()`, `consent_at = now()`, `consent_id`, `state = 'active'`, `version = version + 1`.
- **`PATCH /api/core2/trusted-contacts/:id`**: Update `rank`, `scopes`, `effective_until` (`expected_version`). Subject-owned.
- **`POST /api/core2/trusted-contacts/:id/revoke`** (Revocation Fenced Against Dispatch):
  - Actor: subject (`subject_person_id`), `contact_person_id` (self-withdrawal), or family `child` owner.
  - Takes family advisory lock `pg_advisory_xact_lock(hashtextextended('core2:dispatch:' || family_id, 0))` shared with `core2_authorize_and_enqueue_dispatch`:
    1. Sets `revoked_at = now()`, `state = 'revoked'`, `version = version + 1`.
    2. Marks any pending un-dispatched `core2_dispatch_intents` / pre-claim assignments for this contact as `cancelled_revoked` so no claim worker can send a stale dispatch!
    3. Records signed timeline event (`core2.contact.revoked`).
- **`GET /api/core2/trusted-contacts`**: Bounded read (`limit <= 50`). Returns `id`, `subject_person_id`, `contact_person_id`, `display_name`, `rank`, `scopes`, `state`, `effective_from`, `effective_until`, `revoked_at`, `version`. Never returns phone numbers, emails, or `provider_identities`.

---

### 2.4 Reassurance & Maa's Truth Line (`/api/core2/reassurance`, `/api/core2/reassurance/preferences`)

- **`GET /api/core2/reassurance/preferences` & `PUT /api/core2/reassurance/preferences`**:
  - Subject configures per-family sharing defaults (all private fields default `false`!):
    - `share_status_with_parent`: boolean (default `true` — high-level safe/check-in status only)
    - `allow_location_share`: boolean (default `false`)
    - `allow_health_share`: boolean (default `false`)
    - `allow_narrative_share`: boolean (default `false`)
  - Only `actor.personId === subject_person_id` (and active `child` role) may update preferences.
- **`POST /api/core2/reassurance`**:
  - Sends a reassurance update ("Main safe hoon" / truth line) to verified recipients (parent and/or active trusted contacts in `'reassurance'` scope).
  - Body: `{ "kind": "im_safe | reached_home | truth_line", "watch_id": "uuid (opt)", "sos_id": "uuid (opt)", "voice_post_id": "uuid (opt)", "recipient_person_ids": ["uuid"] }`.
  - Validations:
    - If `voice_post_id` is supplied, validates it belongs to `(family_id, sender_id = actor.personId, recipient_id)` and holds current `voice_share:<recipient>` consent in `public.consents`.
    - Evaluates `@sahaj/gate` (`action = voice_post_id ? 'voice_message' : 'share_data'`).
    - Constructs redacted factual reassurance projection purely from persisted server rows + preferences (**zero LLM-generated facts, zero unverified delivery/heard claims, zero location/health/private narrative unless explicitly enabled**).
    - Enqueues via `outbox` (`kind='core2.reassurance'`) and appends signed timeline event (`core2.reassurance.queued`).
  - **Response (`202 Accepted`)**:
    ```json
    {
      "reassurance": {
        "id": "uuid",
        "kind": "im_safe",
        "status": "queued | delivered | failed | denied",
        "delivery_verified": false,
        "facts_exposed": {
          "status_label": "checked_in_safe",
          "location_included": false,
          "health_included": false,
          "narrative_included": false
        },
        "created_at": "ISO-8601"
      }
    }
    ```
- **`GET /api/core2/reassurance`**:
  - Bounded read (`limit <= 50`) for authenticated `parent`, `child`, or active `'reassurance'`/`'sos'` trusted contact.
  - Enforces subject's current `core2_sharing_preferences` at read time (if preferences tightened or contact was revoked after creation, hidden/redacted fields remain omitted!).
  - Returns safe redacted state (`status_label`, `delivery_verified`, `occurred_at`, bounded `voice_post_id` reference only if caller is permitted recipient). Never exposes raw `raw_events`, `payload_ciphertext`, storage object paths, or unrestricted `timeline_events.human_line`.

---

## 3. Mapping to Riya's App Screens (`apps/child`, Read-Only Reference)

| Screen File (Read-Only) | Current UI Action / Stage | Core 2 Endpoint & Mapping | UI Honesty / Truth Requirement |
|---|---|---|---|
| `apps/child/app/sos.tsx` | Hold 3 s → countdown (`sos.cancelSeconds`) | `POST /api/core2/sos` when hold completes (or after countdown); returns `sos.id`, `version`, `status` | Cannot display `"Circle alerted · <name> is coming"` until `responder_accepted === true` from verified provider proof. Before proof, display `"SOS requested · waiting for response"`. |
| `apps/child/app/sos.tsx` | Tap `"Cancel alert"` during countdown | `POST /api/core2/sos/:sosId/cancel` (`{ reason: "false_alarm", expected_version }`) | Displays `"SOS cancelled"` only after `200`/`202` confirms `status === "cancelled"`. |
| `apps/child/app/sos.tsx` | Tap `"I'm safe now"` after alerted | `POST /api/core2/sos/:sosId/cancel` (`{ reason: "im_safe", expected_version }`) + optional `POST /api/core2/reassurance` (`{ kind: "im_safe", sos_id }`) | Prior alert rows keep their own delivery status; follow-up reassurance shows `queued` until verified. |
| `apps/child/app/watch.tsx` | Fill `eta_minutes`, `From`, `To`, `Cab note`, tap `"Start watch"` | `POST /api/core2/watches` → returns `watch.id`, `version`, `deadline_at`, `grace_until` | Encrypted route stays server-side; circle gets nothing until escalation + grace expiry. |
| `apps/child/app/watch.tsx` | Tap `"+15 min"` | `POST /api/core2/watches/:watchId/extend` (`{ add_minutes: 15, expected_version }`) | Updates local countdown from server `deadline_at` & increments `version`. |
| `apps/child/app/watch.tsx` | Tap `"I've reached"` | `POST /api/core2/watches/:watchId/safe` (`{ expected_version }`) | Handles `safe` atomically even concurrently with late timeout; updates from server `watch.state === "safe"`. |
| `apps/child/app/watch.tsx` | Late / `"Checking you're safe"` & `"<friend> is checking on you"` | Polls / subscribes `GET /api/core2/watches/:watchId` | Shows `"Checking in"` (`checking_in`) vs `"Contact notified (pending reply)"` vs `"Confirmed"` only per server state. |
| `apps/child/app/safe.tsx` | Record 3–5 s voice clip + send `"Main safe hoon"` | Uploads clip through Core 1 private media port → `POST /api/core2/reassurance` (`{ kind: "im_safe", voice_post_id, watch_id }`) (and `/watches/:id/safe` if watch active) | Must NOT show `"Maa heard your voice ✓✓"` purely on submit or local timer; show `"Queued for Maa"` until `delivery_verified === true` / verified heard proof arrives. |

---

## 4. Proposed Cron / Worker Hook

Core 2 does NOT start a second ad-hoc interval loop inside route handlers or duplicate Kiro's lease tables. Overdue watch checks and escalations run via an idempotent server processor (`tickCore2Watches(port, now)`) suitable for invocation from [`apps/api/src/app/api/cron/tick/route.ts`](../../apps/api/src/app/api/cron/tick/route.ts) or Kiro's worker after integration review (documented in [`INTEGRATION-CORE2.md`](./INTEGRATION-CORE2.md)).

