# Phase 4 Core 1: Integration & Seams Review Proposal

## 1. Executive Summary
Phase 4 Core 1 provides real pure domain logic, authenticated family command endpoints, durable Supabase repository adapters, rollback-safe schema migrations, and comprehensive adversarial test suites. This document details cross-lane seams, runtime wiring requirements, and schema compatibility proposals for parent integration review.

---

## 2. Injected Seams & Runtime Wiring Dependencies

Phase 2 (provider-dispatch) and Phase 3 (atlas-runtime) contracts are currently under parent review. Core 1 uses typed injected ports (`Core1RepositoryPort`, `AuthPort`, `Core1ServicePorts`, `Clock`) to maintain clean decoupled seams without inventing parallel infrastructure:

| Component / Port | Implemented Contract | Runtime Wiring Required from Parent / Lead Lane |
|---|---|---|
| **Auth Verification** (`AuthPort`) | Supabase bearer token verification via `getUser` | `serviceDatabase().auth.getUser(token)` with live Supabase Auth service role. |
| **Durable Ingestion** (`RepositoryPort`) | Persists encrypted raw command events to `public.raw_events` before returning HTTP 202 | Requires `WEBHOOK_ENCRYPTION_KEY` (64-character hex) in server environment. |
| **Incident Offer & Outbox** | RPC `create_urgent_incident_offer` creates incident and offers assignment to ranked circle member | Bridge to Phase 2 `bind_outbox_dispatch` for outbound Twilio call placement with DTMF Gather (`POST /api/twilio/gather`). |
| **Acceptance Verification** | RPC `accept_responder_assignment_verified` and domain `handleResponderResponse` | Ingestion must route Twilio Gather events to Kiro Phase 2 `record_responder_acceptance`, creating normalized `responder.accepted` proof with `normalized_proof: true`, `verified_by: 'twilio_signature'`, `call_id`, and `account_id`. |
| **Medicine Refill Gate** | `generateRefillProposal` constructs Cedar-compliant `GateRequest` with `medicine_refill` action, `amountMinor`, `vendorId`, `itemIds`, and `two_person_required` | Evaluated against Cedar `evaluateGate` before enqueueing into outbox; requires affirmative family approval before payment (autonomous payment strictly prohibited). |
| **Two-Way Voice Dispatch** | Validates `voice_share:<recipient>` consent and private path convention `<familyId>/voice/...` | Enqueues outbound media notification via Kiro Phase 2 WhatsApp / Twilio worker; `syntheticCloningProhibited: true` enforced. |

---

## 3. Combined Schema Analysis & Leader Shield Observations

### Incompatibility Observation
- The Leader Shield schema (`packages/shield/src/db/**`) expects `family_members`, `name`, and plaintext contact columns (`plainphone`).
- The Core 1 foundation schema (`infra/supabase/migrations/`) strictly enforces:
  - `public.people` with `display_name`, `role`, and synthetic UUIDs.
  - `public.family_memberships` mapping auth users to people.
  - `public.provider_identities` storing encrypted contact ciphertext and HMAC hashes (`<MOBILE_10>`, `<NUM>`).
  - Zero plaintext phone numbers or OTPs reach any AI model or unauthenticated route.

### Proposal for Parent / Lead Review
1. **Never Add Plaintext Contact Columns to Core Tables**: Core 1 adheres to the hackathon ground rule (Ground Rule 1 & 4 in `AGENTS.md`).
2. **Postgres View / Compatibility Mapping**: Propose a definer view `public.shield_family_members_view` or service-role abstraction in `packages/shield/src/db` that projects masked or securely decrypted identifiers for Shield's scam detection pipeline without mutating Core 1 tables or weakening RLS.
3. **Combined Migration Sequencing**:
   - `20261114130240_core1_security_workflows.sql` (Base)
   - `20261114201500_phase3_atomic_orchestration.sql` (Phase 3 Base)
   - `20261114201600_phase2_dispatch_recording.sql` (Phase 2 Dispatch)
   - `20261114210000_phase3_review_fixes.sql` (Phase 3 Review)
   - `20261114213000_phase3_bridge.sql` (Phase 3 Bridge)
   - `20261114220000_phase4_core1.sql` (Phase 4 Domain Functions & RPCs)

---

## 4. Manifest / Package Export Proposals

Per ownership instructions, manifests (`package.json`) and lockfiles were not edited. For clean monorepo imports in future phases, the following export addition is proposed for parent review:

```json
// packages/atlas/package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./postgres": "./src/postgres.ts",
    "./core1": "./src/core1/index.ts"
  }
}
```

Currently, all tests and route handlers import cleanly via TypeScript module resolution.
