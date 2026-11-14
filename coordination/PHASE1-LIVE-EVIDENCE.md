# Phase 1 live evidence — 2026-11-14

Parent checks against the configured dedicated Supabase project and Vercel deployment. These are foundation checks, not phone/emergency acceptance.

- Root checkpoint465fe55: frozen workspace installs succeeded; all package typechecks,311 tests and production build passed.
- Production deployment dpl_HKja81kKsmHDfuoNHUQTFj1TRoRH READY; protected GET /api/health200. Existing endpoint is liveness/scaffold only; readiness is still an implementation gap.
- Hosted rollback tests core1_security.sql, signed_timeline.sql and checkpoint_media_metadata.sql executed successfully after the latest foundation migration. Fixtures rolled back.
- Metadata checks: every table in public/sahaj_private/sahaj_checkpoints has RLS enabled; all three care buckets private; browser roles lack checkpoint schema usage; dedicated runtime has no database CREATE; synthetic family and three synthetic people present.
- Both anon/authenticated denied execution on BOTH media metadata RPCs. Both roles lack SELECT on call_content, voice_content and private_items.
- Important test distinction: authenticated intentionally has USAGE on sahaj_private for has_role/is_person authorization helpers used by RLS; anon has no usage. Do not revoke that usage or falsely require authenticated USAGE=false. The private schema remains outside PostgREST exposure and content tables have no browser grants/policies.
- GitHub connector rechecked ADI238IND/SAHAJ visibility: public staging repository. No visibility changes made. Only synthetic data/code; secrets remain ignored.

Remaining Phase1 closure: Antigravity bounded readiness implementation and failure/recovery tests; expanded rollback acceptance suite; final integrated SHA local/deployed readiness evidence. Do not mark100% until these pass.

## Independent verification of Antigravity review fixes

Parent ran API typecheck, full API tests and production build in antigravity-foundation on2026-11-14 around21:01 IST:204 tests passed across15 files (readiness15, ports8, routes5), typecheck and build passed. This exceeds the worker's earlier202-test report by2 readiness regressions. The worktree contained uncommitted edits over tip26aa605; this is a tested working-tree snapshot, not final commit acceptance.

Parent executed that worktree's phase1_security_acceptance.sql against the connected Supabase project: passed, fixtures rolled back. Existing private-schema helper USAGE was preserved. Final worker checkpoint, independent review of any subsequent edits, integration and actual local/deployed readiness remain pending. Do not attribute the new tests to the currently deployed465fe55.

## Final IDE/App integration validation

Integrated IDE8133cf0/26aa605/f1ddedc as e303460/66ffa7e/abc2697; AppQAe862b75 as4da18ec. Frozen install, every package typecheck,372 tests (API237, adapters72, gate39, Atlas24) and production build passed. AppQA30/30 passes on the integrated source; its old18 failures against8133cf0 remain historical only.

Real local production server at127.0.0.1:3101 passed all4 routes: /api/health?probe=liveness, /api/health, /api/health/liveness, /api/health/readiness. All200/no-store/emergency_ready=false; readinessdatabase.status=connected/schema=present. The sandboxed3100 server instead safely reported503/database_unreachable while retaining200liveness; network-enabled verification confirms healthy real connectivity.

The initial SQL suites expected a5argument catalog signature for finish_workflow_job; its declared/live identity has6arguments. Parent corrected both verification artifacts to the actual identity, then executed both complete on-disk suites against hosted Supabase successfully with rollback. No schema or application behavior changed. scripts/check.ps1 now accepts BaseUrl and checks liveness independently of database readiness; it passed against3101, including both unauthenticated-route401 checks. Process-only PowerShell execution-policy bypass was required to run the script; no machine policy changed.

## Phase1 acceptance complete

Final release checkpoint b1904b2a765c83f9e44b243036fb119f5a5eee1b is pushed and deployed as dpl_4b7Xinef1LEeWPKe8qjg3oykCb81 (READY). At2026-11-14T16:40Z, all four protected health routes again returned200/no-store. Default readiness returned connected/present/emergency_ready=false. This final release includes the corrected SQL expectations and liveness smoke script; the earlier006f173 evidence below remains a historical integration check.

Deployment dpl_7rS4QWUJ3n5eeGJMrL8sCHR28UdV, integration commit006f173491f5d074955f20e0564ffd0b906674bc, is READY. Protected fetches of all four health routes returned200 and Cache-Control:no-store. Default and dedicated readiness reported database.status=connected, database.schema=present, emergency_ready=false; voice/care actions remain disabled. Migration20261114150944 is reconciled in Git and hosted migration history; its live readiness RPC reports foundation-v4/schema_ready=true. Phase1 coding and foundation acceptance are100%; provider and emergency acceptance belong to later phases.
