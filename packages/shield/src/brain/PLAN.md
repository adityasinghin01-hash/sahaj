# Shield brain implementation plan

Goal: execute C-02 inside its allowed paths, without commits or changes to other agents' rules/server code.

Architecture: a compiled LangGraph StateGraph runs load → rules → links → ai → verdict → gate → respond → sign. Explicit injected ports isolate rules, persistence, safety approvals, notifications, durable scheduling, calls, Atlas and signing. The existing adapters router supplies the default twoLock. No checkpointer or delayed ladder timers live in this package.

1. Define the ports and fake fixtures in `types.ts` and `test/brain/helpers.ts`. Write graph and ladder acceptance tests first; verify they fail before implementation.
2. Implement `sandbox.ts`: public-address validation, pinned DNS at connection, remote-address validation, HTTP(S) HEAD with GET fallback, manual redirects, a cumulative two-second deadline, no response-body consumption. Test private/metadata/transition addresses, rebinding, redirects and timeout without network.
3. Implement `links.ts`: Safe Browsing v4 POST using the documented client/threatInfo body, domain cache for a day, shortener expansion, destination checks, bounded concurrent work and explicit unavailable results.
4. Implement `judgement.ts` and `graph.ts`: masked-only twoLock, conservative failure/disagreement merging, bilingual reasons, safe ladder action selection, gate denials, verdict persistence before response and signed node outcomes.
5. Implement `respond.ts`: quiet yellow card; red confirmation/call, WhatsApp and push; durable retries (three total call attempts), reaction check, gate rechecks, explicit money-loss-only offer, scaled scheduler delays and signed effects.
6. Export public entry points from brain/index.ts and add one package index export line. Add only required package dependencies; install without rewriting the shared lockfile.
7. Run the full shield typecheck and tests, inspect scope and diff, and finish `.cards/C-02.report.md` with verified counts, ports, operational assumptions and sources.

Validation: no live providers or alerts; all tests fake dependencies/network. Acceptance covers rules-red KYC with three reasons and no AI, agree/disagree/provider failures, clean green, threat match/cache, SSRF and redirects, keypad retry cap, reaction suppression/escalation, action denials, every node signed, Unicode digit masking, scaled delays and rules-only latency under four seconds.

Sources checked: https://docs.langchain.com/oss/javascript/langgraph/graph-api ; https://developers.google.com/safe-browsing/v4/lookup-api ; https://developers.google.com/safe-browsing/reference/rest/v4/threatMatches/find .
