# Phase1 final test correction — IDE and App workers

Parent integrated IDEf1ddedc and AppQAe862b75 after independent review. Runtime readiness migration20261114150944 is already reconciled and live RPC returns connected/schema_ready=true. Do not create a new migration to fit a test.

Hosted final SQL test FAILED on an incorrect catalog signature. Actual declaration and live pg_proc both confirm:
`public.finish_workflow_job(uuid,uuid,text,text,text,text)`
(job_id,lease_token,state,checkpoint_ref,interrupt_ref,error_code).

IDE owner, in antigravity-foundation:
- Correct infra/supabase/tests/phase1_security_acceptance.sql expected identity signature from5args to6args. Default arguments permit shorter CALL expressions, but to_regprocedure must use the full identity signature.
- Parent explicitly extends your ownership to scripts/check.ps1: smoke liveness via /api/health?probe=liveness, retain auth-negative checks and no emergency-ready assertions. Add optional BaseUrl parameter if useful (default localhost:3000) so parent can test isolated port3100. Keep readiness separate; no synthetic fake-success credentials. Update obsolete scaffold-only wording.
- Run syntax/checks, commit only your owned changes and report SHA. No cloud/env reads/merge/push.

App QA owner, in antigravity-phase1-qa:
- Correct the same5arg signature in infra/supabase/tests/phase1_independent_qa.sql to the actual6arg identity signature. Audit other listed signatures against actual baseline migrations, not overloaded calls.
- Do not edit IDE files or application code. Commit QA correction and report SHA.

Parent will cherry-pick the tiny fixes, rerun BOTH rollback SQL suites, final combined tests/build and real local/protected deployed readiness. No Phase1100%until those pass.
