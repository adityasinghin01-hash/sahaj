# Sahaj

AI care for parents and their adult children. Synthetic hackathon demo data only.

## Shield and family apps

`packages/shield`, `packages/shield-kotlin`, `packages/adapters/src/llm`,
`apps/shield-api`, `apps/parent`, and `apps/child` provide Shield and the family experience.
See [integration decisions](docs/integration/SINGHAL-MERGE.md) for the combined schema,
setup and migration order. Use Node 22 and pnpm 12.18.0 with hoisted dependencies.

## Core 1 foundation


Core 1 and shared-backend staging monorepo for Vihaan X. Current coding progress, tested checkpoints and deployment limits are recorded in [PROGRESS.md](PROGRESS.md). This is not an operational emergency response service.

Use Windows PowerShell, Node.js22 and pnpm12.18.0. From the repository root:

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

Build scripts are explicitly approved for `esbuild@0.28.2` in `pnpm-workspace.yaml`. Review any new script/version before approving it; retain supply-chain verification.

For local development, copy `apps/api/.env.example` to ignored `apps/api/.env.local`, configure server-only values securely, then run `pnpm.cmd dev`. Never put secret values in chat, logs or Git. The API listens on localhost:3000 by default.

The current health route is liveness-only and reports scaffold limitations. Verified webhooks persist encrypted, person-bound input before acknowledging it. Cron currently moves input into a durable job queue; that is not evidence a care action ran. Media requires live family membership, consent and Cedar; production media authorization denies until the real gate is wired. The Twilio voice test route remains501. Provider dispatch and Atlas execution are being integrated in separate worktrees.

## Database setup

Use a dedicated Supabase project and an administrative migration connection. Apply reviewed migrations in recorded order; never reset an existing hosted database:

1. `infra/supabase/migrations/20261114125704_foundation.sql`
2. `infra/supabase/migrations/20261114130240_core1_security_workflows.sql`
3. `infra/supabase/migrations/20261114131827_signed_timeline.sql`
4. `infra/supabase/migrations/20261114141830_checkpoint_media_metadata.sql`
5. `infra/supabase/migrations/20261114150944_foundation_readiness.sql`
6. All `20261114160000…20261114160900` Shield migrations, in filename order (see integration map).

Apply `infra/supabase/seed.sql` explicitly for synthetic demo data. It creates no authenticated memberships or consent. Future migrations must be reviewed before application. See [database contracts](infra/supabase/README.md) and [Atlas setup](packages/atlas/README.md) for private schema, runtime-role and verified TLS details. Run rollback-only SQL suites under `infra/supabase/tests/` through the administrative test connection.

From the repository root, with ignored runtime configuration already saved:

```powershell
node apps/api/scripts/check-runtime.mjs
node --env-file=apps/api/.env.local packages/atlas/scripts/setup-checkpointer.mjs
node --env-file=apps/api/.env.local packages/atlas/scripts/check-postgres-restart.mjs
```

The checkpoint setup command verifies the administratively provisioned schema and hardens access; it does not grant database CREATE. The restart test uses synthetic identifiers and removes its thread after success.

## Parallel work and release

Phase ownership and worktree prompts are under `coordination/`. Each worker commits only its owned files; Codex independently reviews, integrates, runs combined checks and deploys. Keep `packages/shared`, mobile applications and Shield outside this backend scope. Root/app manifest and lockfile changes require integration coordination.

Vercel uses Node24, Next.js and root directory `apps/api`, with workspace source outside the root enabled. Configure runtime values as sensitive server-side environment variables. Verify the exact deployed commit and protected health/readiness response; a successful build alone does not prove working care features.

This staging repository was verified public on2026-11-14. Use synthetic data only. No real phone numbers, health records, voice recordings, credentials, OTPs or payment details belong in Git, prompts or logs. AI speech must disclose itself. Recordings and sharing require consent. Authorize external actions through Cedar; never infer responder acceptance from enqueueing, a model response or a generic completed-call callback.