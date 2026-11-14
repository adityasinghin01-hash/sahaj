# Kiro B: final capability filtering review

Use only `.worktrees/kiro-phase3` and its existing branch. Aditya owns Phase 4/5. Independent review of 7594825/ac0b6d1 found two runtime gaps. Fix and commit scoped changes; no hosted changes or external communications.

1. Enabling any one configured outbound provider runs a dispatch tick whose Phase 2 claim_outbox claims ALL providers. Disabled/unconfigured providers and WhatsApp without a content composer get claimed then failed, burning retries and potentially dead-lettering work while intentionally unavailable. Ensure claim eligibility includes configured, enabled provider/action/content capabilities BEFORE claiming. A Sarvam-only tick must leave Twilio and unavailable WhatsApp rows untouched with unchanged attempts. Coordinate the exact Phase 2 claim contract in a written handoff; do not edit Phase 2-owned files. If unavoidable, expose a safe contract and clearly report the remaining Phase 2 SQL work instead of claiming completion.

2. Recording configuration currently requires Twilio credentials even for Sarvam-only retrieval. Configure independent provider recording capabilities and claim/filter only eligible jobs. Valid Sarvam-only setup must process Sarvam jobs without Twilio credentials and leave Twilio jobs pending. Preserve authorization, consent, exact-path storage and no-unknown-retry rules.

3. Twilio currently infers aiDisclosureAttested=true from an allowlisted configured URL. URL validation alone cannot attest actual AI disclosure or signed Gather behavior. Keep this path unavailable unless backed by an owned renderer with tested provenance; document and test the exact enablement requirements. Do not mark an arbitrary remote URL as disclosure-attested.

Run relevant tests/typechecks and inspect the latest combined tree read-only at `.worktrees/phase23-integration`. Add tests covering both enabled-only paths and preservation of unavailable jobs. Retain explicit environment flags, secret-free diagnostics, durable claims and fenced orchestration. Report commit SHAs and integration contract. Do not merge/push or edit mobile/Shield/shared/Phase4/5.
