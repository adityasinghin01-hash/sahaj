# Phase1 review — required fixes before closure

Continue only existing foundation owned files in D:/Projects/SAHAJ/.worktrees/antigravity-foundation. Independent draft review passed19 health tests and typecheck, but these scenarios are missing or incorrect. No need to change production grants.

1. evaluateReadiness must require probe.schemaOk === true as well as connected/ok. Add regression connected+schemaOk=false =>503, never200ready.
2. Enforce an independent bounded deadline around the injected probe, even when the dependency ignores its timeout or never settles. Clear timers, propagate cancellation where supported, and never expose error details. Add never-resolving fake probe and recovery tests using fake timers. isConfigured exceptions must also fail safely.
3. A families-only probe cannot prove schema readiness. Applied migration infra/supabase/migrations/20261114150944_foundation_readiness.sql supplies service-only public.foundation_readiness() RPC returning JSON {database:'connected',schema_ready:boolean,schema_version:'foundation-v4'}. Consume exact result defensively and handle missing RPC/malformed response/false schema as503. Use bounded Supabase abortSignal plus independent deadline; recognize SDK abort {error} responses as timeout where appropriate. Do not query/expose private schemas directly.
4. SQL must preserve authenticated USAGE on sahaj_private for has_role/is_person RLS helpers. Instead assert anon has no usage and browser roles lack direct private content table privileges. See root coordination/PHASE1-LIVE-EVIDENCE.md.
5. PUBLIC is an ACL pseudo-role, not a named PostgreSQL role. Do not call has_schema_privilege('public',...). Inspect ACL grantee=0 through aclexplode when needed.
6. Assert required table names/RPC signatures actually exist before iterating ACLs/RLS; absent objects must not vacuously pass. All three named care buckets must exist AND be private.
7. Read root coordination/PHASE1-ACCEPTANCE-AUDIT.md and PHASE1-LIVE-EVIDENCE.md. Document final migration/schema dependency (parent will provide exact readiness migration filename), tests and explicit remaining live readiness evidence. No provider/Atlas feature readiness claims.

Run API tests/typecheck/build, commit owned fixes and report SHA. Parent independently runs PostgreSQL closure suite and local/deployed readiness before marking100%.
