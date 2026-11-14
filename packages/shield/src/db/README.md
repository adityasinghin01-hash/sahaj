# packages/shield/src/db

Postgres implementation of the two Shield database interfaces (card K-B3).

## DEPENDS ON

Core tables owned by Singhal's migration. Only these columns are read:

| Table | Columns used |
|---|---|
| `public.shield_family_security` | `family_id uuid`, `code_word_hash text` (hex SHA-256 of the normalised code word, nullable) |
| `public.people` | `id uuid`, `family_id uuid`, `display_name text`, `aliases text[] default '{}'`, `role text` |
| `public.family_memberships` | `family_id`, `user_id`, `person_id`, `role` (read only by the RLS policies in the Shield migration, not by this code) |

Plus the two Shield migrations: `infra/supabase/migrations/20261114160100_shield.sql` and `20261114160200_shield_pairing.sql`.

## Use

```ts
import postgres from "postgres";
import { createShieldPg } from "@sahaj/shield";

// DATABASE_URL = Supabase pooler, service role. Port 6543 (transaction mode) needs prepare: false.
// Supavisor before 2.10 hangs on pipelined queries, hence max_pipeline: 1 (postgres.js 4.x docs).
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max_pipeline: 1, query_timeout: 5 });
const pg = createShieldPg(sql);

const serverDeps = { db: pg.server, /* atlas, waitUntil, env, clock, log */ };  // ShieldServerDeps
const toolDeps   = { db: pg.tools,  /* llm, rules, whatsapp, ... */ };          // ShieldDeps
```

`pg.server` satisfies `ShieldServerDb`; `pg.tools` satisfies `ShieldDeps["db"]`. `createShieldPg` accepts any postgres.js `ISql`, so it also works on a transaction (`sql.begin(tx => createShieldPg(tx)...)`).

## Behaviour

- Every query is a postgres.js tagged template. No SQL is built from strings.
- Lookups by id (`getDevice`, `getPerson`, `getFamilyCheck`, the `familyId` of every read) return "not found" for a value that is not a uuid, instead of throwing a Postgres cast error. These ids come from headers, request bodies and AI tool input.
- `claimPairingCode` is one conditional `UPDATE … WHERE used_at IS NULL AND expires_at > $now RETURNING id`. Concurrent claims queue on the row lock, and the losers re-check the WHERE and update nothing.
- `insertEvent` uses `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`. No row back means duplicate. Any other error (check constraint, foreign key) throws.
- `touchHeartbeat` never moves `last_heartbeat_at` backwards (heartbeats run in the background and can land out of order).
- `findPersonByName`: same family only; NFC, trim, collapse whitespace, lowercase on both sides; exact match on `display_name` or on any element of `aliases`. A name match beats an alias match; ties go to the lowest id. No partial or `LIKE` matching. Hindi names match as typed (no transliteration).
- `createFamilyCheck` writes `channel = 'whatsapp'` and `asked_at = created_at = input.createdAt`. `askedWhat` is **not stored**: `family_checks` has no column for it.
- `getFamilyCheck` returns `state`, `familyId`, and `toPersonId` / `claimedName` when the row has them.
- Times come from the caller's `now`/`at` arguments (the app clock), not from the database's `now()`.

## Test

`bash infra/supabase/test/run-shield-db-test.sh` (throwaway local cluster, no Docker). Without `DATABASE_URL`, `test/db` is skipped by plain `pnpm test`.
