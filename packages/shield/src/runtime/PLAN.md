# C-03 implementation plan

Goal: join the existing handlers, JSON rules, graph, tools, jobs and messages without changing their implementations. No commits; edits stay in the card's permitted paths.

1. Rename only the brain dependency type to `ShieldBrainDeps`, including its imports, tests and example. Verify the package export clash is gone.
2. Add `runtime/types.ts`, `rules.ts`, `pg.ts` and `index.ts`. Production builds on `createShieldPg(sql)`; the extra storage contract covers event/history/verdict persistence and per-event locking. Tests inject the same contract in memory. Resolve parent call lines through the calls adapter and durable tool job claims through the scheduler adapter.
3. Write failing end-to-end scenes using real handlers, rules and graph, a real adapters router with fake providers, fake external effects, independent phone HMAC signing and signed timeline records. Run all scenes with Postgres when `DATABASE_URL` is present, otherwise the memory store. Add replay/concurrency, consent and shared job-dispatch checks.
4. Bind the six scheduled tools, adapt their verdict alerts to persistent records and the brain's alert response branch, and retain their fixed spoken lines and existing bridge/family workflows. Register background work with `waitUntil`. Route both brain and tool job names.
5. Document exact host ports and four Next.js route lines in `runtime/README.md`. Run typecheck, the complete Shield suite, and the new scenes against a throwaway Postgres. Review scope/diff and write `.cards/C-03.report.md` with measured results and any out-of-scope limitations.
