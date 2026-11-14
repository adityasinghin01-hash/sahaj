# Kiro B: final checkpoint concurrency blocker

After completing current fourth-pass work, resume this review. Parent independently reproduced with REAL installed PostgresSaver and committed8957075 fence, using Promise.all([saver.put(...),saver.putWrites(...)]) on a logging pg client:

lock -> BEGIN -> BEGIN -> INSERT -> VERIFY -> INSERT -> COMMIT -> VERIFY -> COMMIT

The facade pool.connect immediately returns the same pinned client and release is a no-op. Concurrent saver operations interleave their transactions; first COMMIT prematurely commits another operation, while rollback/error can affect unrelated writes. Preserve pinned-session lock correctness, but serialize facade client checkout across the WHOLE connect-to-release transaction, and standalone pool.query calls against the same queue. Serializing each statement alone is insufficient. Handle cancellation/fence loss while waiting, ensure transaction release always occurs, and prove with actual PostgresSaver parallel operations one blocked/error operation never commits or rolls back the other. Test in-flight lock loss with competing writes, not only copied SQL fake predicates. Real PostgreSQL concurrency remains a required parent gate.

Keep original ownership and no remote SQL/env/provider traffic. Save tested scoped fixes and report evidence. This replaces any claim that the fence is complete at8957075/73c7b3a.

Second independent SQL blocker: dispatch_authorization_problem checks permission id/family/decision/time but not mutable scope. Under the same atomic claim/family lock, recheck current permission principal_id, person_id, action, target_ids, vendor_ids, item_ids, max_amount_minor against the immutable stored request. Narrowed/reassigned permission must deny queued sends. Treat already-reserved usage separately so no double charge. Add regressions for empty targets, changed principal/person/action, reduced amount/item/vendor scope. Recording table return, acceptance-first urgent outcome, expiry and current approvals are now corrected; preserve them.
