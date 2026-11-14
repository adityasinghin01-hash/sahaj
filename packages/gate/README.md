# Cedar permission gate

`evaluateGate(input)` uses the actual pinned Cedar WebAssembly evaluator, with a fixed policy for explicit setup permissions. Results are `allow`, `deny`, or `ask`, with machine-readable reasons and the selected permission ID. This package performs no external actions.

Load actor membership, permissions, period usage, approvals and consent from trusted server storage. Never construct these facts from user claims or model output. Pass an explicit clock, immutable request ID and durable target ID. Costs use integer minor currency units. A refill requires explicit amount, vendor and items. Cedar checks family, actor, action, target, amount, vendor, items, validity and usage limits.

Explicit setup permissions can preauthorize a refill within their amount, vendor, item and frequency limits. Permissions with `approvalMode: 'two_person'` require two distinct authorized people. Approvals bind `requestFingerprint(request)`, permission and family, and expire; self-approval, duplicate identities, expired/revoked and unauthorized approvals fail closed. Recordings and sharing additionally require current consent bound to subject and recipient. Payment, OTP collection and diagnosis are always prohibited.

Execution integration must reauthorize and reserve usage / consume approvals atomically inside a database transaction before any provider call. Serialize or lock permission usage so simultaneous requests cannot exceed limits. Persist the immutable request and decision for audit, then execute through a durable outbox. `allow` authorizes an attempt; it does not establish delivery or responder acceptance. Rechecking after an interrupt must reload all server facts. This pure package does not implement those persistence or concurrency controls.

Use the Node.js runtime. The Cedar `nodejs` package reads its shipped WASM file; configure Next.js `serverExternalPackages: ['@cedar-policy/cedar-wasm']` when importing this gate in API routes and verify the deployed artifact includes the package/WASM.

Run `pnpm --filter @sahaj/gate typecheck` and `pnpm --filter @sahaj/gate test`.
