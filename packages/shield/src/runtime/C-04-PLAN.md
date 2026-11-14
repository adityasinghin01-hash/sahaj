# C-04 implementation plan

Scope: only the card's allowed modules, migration, runtime wiring, package exports, and final card report. No commits. Existing pnpm-lock.yaml is pre-existing and stays untouched.

1. Add injected DrillStory and storage contracts in src/drills, atomic weekly selection and last-ten exclusion, a validated low-effort rubric tool with local keyword fallback and a bounded response, and monthly average/trend. Test with two inline stories, including masking, replay and deadlines.
2. Add src/evidence contracts, child-membership authorization before incident reads, deterministic bilingual masked summaries, explicit unknown money/number handling, timeline actions and chain-hash retrieval, stable contents hashing, and a Postgres adapter. Test denied roles/families, privacy, deterministic hashing, and adapter mapping.
3. Add the single allowed migration with family RLS, child-only evidence reads, service-only writes, score constraints, and a parent lock for atomic drill issuance. Add a dedicated throwaway Postgres runner that applies this migration and enables the real database scenarios; do not edit the existing runner outside the allowed paths.
4. Wire an augmented runtime tool map/guard, drill APIs and evidence API. Existing runtime callers remain compatible; absent story/timeline configuration cannot invent data. Document exact new ports and returned hash/time representation.
5. Run focused tests, Shield typecheck and full suite, inspect the final diff, and write .cards/C-04.report.md with commands, evidence, integrations and limits. The card reserves the Postgres runner gate for the user; report actual execution separately.

Privacy: mask speech before AI/storage; never store raw answers. Evidence never recovers phone numbers. Pack display fields contain no four-digit runs except the fixed helpline 1930: use a two-digit-year UTC display time and reversible alphabetic encoding for the chain hash, preserving its exact bytes. The database stores canonical timestamps and SHA-256 hashes.
