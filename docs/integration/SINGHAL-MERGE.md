# C-09 foundation / Shield integration

This work joins lead e0e57d3 and unrelated Singhal e57b58e on p6/singhal-merge.
The merge is deliberately uncommitted. See ../../.cards/C-09.report.md for actual gates and limitations.
No live lab, secret files, providers, mobile builds, commits or pushes are part of this task.

## Conflict resolutions

| Conflict | Resolution |
| --- | --- |
| .gitignore | Union of both ignore sets, including the lead native-module exception and Singhal editor/worktree rules. |
| package.json | Union of scripts, Node 22, pnpm 12.18.0; Core 1 dev/build retained and Shield harness retained. |
| pnpm-workspace.yaml | Both app/package globs, hoisted linker, union of esbuild / version-pinned esbuild / protobufjs allowBuilds. |
| pnpm-lock.yaml | Regenerated using pnpm install --config.strict-dep-builds=false. |
| README.md | Sections for Shield/family apps and Core 1; original Core 1 operational caveats retained. |
| packages/adapters/package.json | Union of dependencies and scripts; both main/types and exports retained. |
| packages/adapters/src/index.ts | Both APIs exported. Existing lead ProviderRequest remains; provider-dispatch contract is AdapterProviderRequest to avoid collision (direct ./contracts API unchanged). |
| packages/adapters/tsconfig.json | Shared strict base, includes src and both test directories; vitest likewise includes both test/**/*.test.ts and tests/**/*.test.ts (upstream config otherwise hid the lead suite). |

.nvmrc contained Node 24 upstream (not a conflict); normalized to the card's Node 22.
The root adds pinned dev dependency tsx@4.20.6 so the required Shield harness runs reproducibly without a global npm cache or an implicit download.

## Migration order

Foundation migrations 20261114125704 through 20261114150944 are byte-for-byte unchanged.
Then apply 20261114160000_shield_foundation_bridge.sql, followed by:

| Previous | New |
| --- | --- |
| 20261114000100_shield.sql | 20261114160100_shield.sql |
| 20261114000200_shield_pairing.sql | 20261114160200_shield_pairing.sql |
| 20261114000300_shield_busy_warnings.sql | 20261114160300_shield_busy_warnings.sql |
| 20261114000400_shield_drills_evidence.sql | 20261114160400_shield_drills_evidence.sql |
| 20261114000500_shield_gateway.sql | 20261114160500_shield_gateway.sql |
| 20261114000600_shield_dev.sql | 20261114160600_shield_dev.sql |
| 20261114000700_app_push_tokens.sql | 20261114160700_app_push_tokens.sql |
| 20261114000800_shield_experience_drills.sql | 20261114160800_shield_experience_drills.sql |
| 20261114000900_shield_heartbeat.sql | 20261114160900_shield_heartbeat.sql |

Every migration runner applies all SQL files in lexical order and runs each file in a transaction.
This matters for the foundation checkpoint migration's SET LOCAL ROLE. The old standalone stub is
removed. Disposable tests bootstrap only the Supabase platform surface (roles, auth, storage), then
apply the actual foundation. Production migration execution assumes real Supabase, with no bootstrap.
The lab source scripts are updated for future fresh databases only; no lab command has been executed.
Renumbered/changed Shield files must not be applied in place to the existing demo database.

## Schema bridge

- All Shield/host authorization uses family_memberships with revoked_at IS NULL, including service-role
  app membership reads, push targets, evidence reads/writes, drill gates and Shield RLS.
- Database people names use display_name while existing API DTOs keep their name field.
- Shield needs aliases for exact family-check matching. The bridge adds people.aliases; foundation's
  explicit client column grants do not expose it. Code-word hashes live in a new service-only,
  RLS-enabled shield_family_security table, since families' table SELECT grant would expose a new column.
- No plaintext phone column or compatibility family_members view is created.
- The ONE Shield contact port is apps/shield-api/src/ports/contacts.ts (types in contacts.types.ts).
  Outbound WhatsApp, Sarvam, gateway registration and call-gateway saved-family matching use it.
  Resolution requires a unique enabled, unrevoked contact binding for the exact family, person,
  provider and configured account; corrupt/mismatched ciphertext and missing keys fail closed.
- Foundation had no contact_ciphertext writer. Its encryptWebhook/decryptWebhook/identityHash helper
  is extracted unchanged into adapters/contact-crypto and re-exported from its original API module.
  New contact AAD is JSON ["contact",family_id,person_id,source,account_id,external_id_hash].
  Identity index uses the foundation HMAC over JSON [source,account_id,provider digits without +].
  Only validated E.164 contacts are returned internally to provider routing. Never log/serialize these.
- Config: WEBHOOK_ENCRYPTION_KEY and IDENTITY_HASH_SECRET are shared server-only env names from
  foundation. WhatsApp account is WHATSAPP_PHONE_NUMBER_ID; Sarvam account is SARVAM_APP_ID
  (fallback SARVAM_AGENT_ID_CHECKIN). Provider API tokens retain their existing env names.
- WhatsApp signature validation precedes sender processing. The account must match webhook metadata;
  only an HMAC index is handed to background work and resolved without decrypting inbound contacts.
  Unknown, revoked, disabled or ambiguous bindings cannot answer a family check.
- Synthetic seed keeps the original family/person/user UUIDs and adds real auth-backed memberships
  and encrypted provider identities. Public test-only fixture configuration is in infra/supabase/dev/README.md;
  never use it for real contacts. Real provider sending remains disabled in disposable E2E scripts.

## Two hosts and later route move

Both apps/api (Core 1) and apps/shield-api remain independent Next.js hosts for now.
Core 1 now also builds with webpack and workspace extension aliases: its previous Turbopack build
could not resolve the lead adapter exports that use ESM .js specifiers. The readiness GET handler
now requires the Request parameter Next route typing expects; its two direct tests pass explicit
requests. No routes were moved.
A later reviewed move should add the Shield workspace transpilation/extension aliases to apps/api,
move Shield app/api route handlers and server ports as a unit, keep URL/auth/webhook contracts stable,
then run both teams' unit, SQL and HTTP suites against one disposable database before retiring the
second host. Share connection pooling and verified provider ingress deliberately; do not merge
unrelated authentication, timeline or dispatch semantics by renaming routes alone.

## Needs Singhal / lead review

Confirm the new contact AAD contract and Sarvam account choice before any real identity provisioning.
Agree the eventual relationship between Shield dev_timeline and foundation signed timeline_events;
this integration preserves both and does not claim their chains are unified. Likewise Shield Atlas
and permission adapters retain their current outbox/gate behavior; merge does not prove live care dispatch.
Review synthetic auth bootstrap only for disposable local tests; hosted auth users need normal provisioning.
The sandbox denied writes to the external worktree index, so resolved content could not be staged;
Git still lists eight unmerged paths. initdb also failed at shared memory creation, so PostgreSQL
and HTTP/database gates remain unverified. Exact outputs and the review handoff are in the report.
coordination/**, phase assignments and foundation migrations are untouched.
