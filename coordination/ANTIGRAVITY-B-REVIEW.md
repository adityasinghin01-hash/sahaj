# Antigravity B: review of 91f2604

Continue only in D:/Projects/SAHAJ/.worktrees/antigravity-b, original command owned paths. Do not merge/push or touch others' files. Fix these independently found blockers before integration:

1. Urgent-help incidentId is accepted without proving the incident belongs to this family. Verify every referenced entity with authoritative stored family ownership before durable ingestion.
2. mediaObjectPath only checks length and '..'. Reject URLs, encoded traversal, wrong bucket/path formats and other-family object paths; validate exact authorized family/subject and expected private storage convention, with object ownership evidence where required.
3. Raw client idempotency key is used as providerEventId under global unique(source,id), causing unrelated families/users to collide. Derive a stable domain-separated hash binding family, authenticated actor and client key. Preserve body conflict detection and replay semantics.
4. getMembership ignores requested familyIdFilter and selects arbitrary active membership. Resolve the explicitly requested family, or reject ambiguity without choosing an arbitrary family. Test users with multiple active families.
5. Circle capabilities must depend on live linked circle record/permission, not role alone; missing/revoked circle entry fails closed.
6. Verify duplicate reporting through actual repository adapter and add mocked-Supabase adapter tests, rather than service fakes only.
7. Reject unknown fields with strict payload schemas. Align the exported BaseCommandEnvelope nested payload contract with actual flat request handling, or use one clear contract consistently.
8. Map invalid encryption configuration to503, including WebhookError raised by malformed hex, rather than500. Keep errors free of secrets.

Run tests/typecheck, commit scoped fixes and report SHA, test evidence and remaining blockers. No actual provider calls or env reads. Parent will independently re-review before integration.
