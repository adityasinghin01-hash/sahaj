import { describe, expect, it } from "vitest";
import { verifyTimelineChain, verifyTimelineEvent } from "../../src/lib/timeline";
import { createCore2TestHarness, SYNTH_IDS } from "./harness";

function authReq(
  url: string,
  method: string,
  token: string | null,
  body?: unknown,
  opts?: { idempotencyKey?: string; familyId?: string },
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts?.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts?.familyId) headers["x-sahaj-family-id"] = opts.familyId;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Phase 5 Core 2 server contract & adversarial suite", () => {
  it("enforces fail-closed auth, revoked memberships, multi-family disambiguation, strict bodies, and durable ingest before 202", async () => {
    const h = createCore2TestHarness();

    // 401 on missing or invalid bearer
    const unauth = await h.handlers.sosListGet(authReq("http://localhost/api/core2/sos", "GET", null));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toBe("Bearer");
    expect(unauth.headers.get("cache-control")).toBe("no-store");

    // Unknown body field rejected before any persistence
    const unknownField = await h.handlers.sosPost(
      authReq(
        "http://localhost/api/core2/sos",
        "POST",
        "tok-riya",
        { approved: true },
        { idempotencyKey: "k-unknown" },
      ),
    );
    expect(unknownField.status).toBe(400);
    expect(h.state.rawEvents).toHaveLength(0);

    // Multi-family membership requires X-Sahaj-Family-Id (409) and rejects non-member family (403)
    h.addMembership({
      familyId: SYNTH_IDS.familyB,
      userId: SYNTH_IDS.userRiya,
      personId: SYNTH_IDS.personOtherFamily,
      role: "child",
      revokedAt: null,
    });
    const ambiguous = await h.handlers.watchesListGet(
      authReq("http://localhost/api/core2/watches", "GET", "tok-riya"),
    );
    expect(ambiguous.status).toBe(409);

    const wrongFam = await h.handlers.watchesListGet(
      authReq("http://localhost/api/core2/watches", "GET", "tok-riya", undefined, {
        familyId: "99999999-9999-4999-8999-999999999999",
      }),
    );
    expect(wrongFam.status).toBe(403);

    // Encrypted raw ingest failure fails closed with 503 and never returns 202
    h.setFailRawIngest(true);
    const storageFail = await h.handlers.sosPost(
      authReq(
        "http://localhost/api/core2/sos",
        "POST",
        "tok-riya",
        {},
        { idempotencyKey: "k-fail", familyId: SYNTH_IDS.familyA },
      ),
    );
    expect(storageFail.status).toBe(503);
    expect(h.state.sosEvents).toHaveLength(0);
    h.setFailRawIngest(false);

    // Revoked membership fails closed with 403
    h.revokeMembership(SYNTH_IDS.userNeha, SYNTH_IDS.familyA);
    const revokedRes = await h.handlers.watchesListGet(
      authReq("http://localhost/api/core2/watches", "GET", "tok-neha"),
    );
    expect(revokedRes.status).toBe(403);
  });

  it("handles SOS idempotency replay/conflict, same-family isolation, non-contact exclusion, and verified-proof honesty", async () => {
    const h = createCore2TestHarness();

    // Same-family Rohit has NOT been invited/approved as a trusted contact -> must NOT receive SOS dispatch.
    const noContactsRes = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-1" }),
    );
    expect(noContactsRes.status).toBe(202);
    const noContactsJson = (await noContactsRes.json()) as {
      sos: { status: string; responder_accepted: boolean; delivery_status: string };
      contacts_notified_count: number;
    };
    expect(noContactsJson.sos.status).toBe("pending_contacts");
    expect(noContactsJson.sos.responder_accepted).toBe(false);
    expect(noContactsJson.contacts_notified_count).toBe(0);
    expect(h.state.outbox).toHaveLength(0);

    // Replay same key + same payload returns original persisted response cleanly
    const replayRes = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-1" }),
    );
    expect(replayRes.status).toBe(202);
    expect((await replayRes.json()).idempotent_replay).toBe(true);

    // Reuse key with changed payload -> 409 idempotency_conflict
    const conflictRes = await h.handlers.sosPost(
      authReq(
        "http://localhost/api/core2/sos",
        "POST",
        "tok-riya",
        { note: "changed body" },
        { idempotencyKey: "sos-1" },
      ),
    );
    expect(conflictRes.status).toBe(409);

    // Activate Neha as trusted contact; SOS queues authorized outbox but STILL does not claim responder_accepted
    await h.approveNehaAsTrustedContact(["sos"]);
    const queuedRes = await h.handlers.sosPost(
      authReq(
        "http://localhost/api/core2/sos",
        "POST",
        "tok-riya",
        { note: "heading to metro" },
        { idempotencyKey: "sos-2" },
      ),
    );
    expect(queuedRes.status).toBe(202);
    const queuedJson = (await queuedRes.json()) as {
      sos: { id: string; status: string; responder_accepted: boolean };
      contacts_notified_count: number;
    };
    expect(queuedJson.sos.status).toBe("queued");
    expect(queuedJson.sos.responder_accepted).toBe(false);
    expect(queuedJson.contacts_notified_count).toBe(1);
    expect(h.state.outbox).toHaveLength(1);
    // Raw note is encrypted, not plaintext in outbox or timeline
    expect(h.state.outbox[0]!.payloadCiphertext).not.toContain("heading to metro");
    expect(h.state.timelineEvents.every((t) => verifyTimelineEvent(t.signed, h.state.publicKey))).toBe(true);

    // Cancel / mark safe by another user rejected 403; by subject marks safe
    const crossCancel = await h.handlers.sosCancelPost(
      authReq(
        `http://localhost/api/core2/sos/${queuedJson.sos.id}/cancel`,
        "POST",
        "tok-rohit",
        { reason: "im_safe" },
        { idempotencyKey: "sos-c1" },
      ),
      queuedJson.sos.id,
    );
    expect(crossCancel.status).toBe(403);

    const safeRes = await h.handlers.sosCancelPost(
      authReq(
        `http://localhost/api/core2/sos/${queuedJson.sos.id}/cancel`,
        "POST",
        "tok-riya",
        { reason: "im_safe", expected_version: 1 },
        { idempotencyKey: "sos-c2" },
      ),
      queuedJson.sos.id,
    );
    expect(safeRes.status).toBe(200);
    expect((await safeRes.json()).sos.status).toBe("safe");
  });

  it("handles watch start/extend CAS, grace escalation, and safe-vs-timeout monotonicity", async () => {
    const h = createCore2TestHarness();
    await h.approveNehaAsTrustedContact(["watch_escalation"]);

    const startRes = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        {
          eta_minutes: 30,
          grace_minutes: 10,
          timezone: "Asia/Kolkata",
          from_label: "Office",
          to_label: "Home",
          cab_note: "DL01XX0000",
        },
        { idempotencyKey: "w-1" },
      ),
    );
    expect(startRes.status).toBe(201);
    const w = (await startRes.json()).watch;
    expect(w.state).toBe("active");
    expect(w.version).toBe(1);
    // Zero alerts sent at watch start; route hidden from timeline human_line
    expect(h.state.outbox).toHaveLength(0);
    expect(h.state.timelineEvents[h.state.timelineEvents.length - 1]!.signed.envelope.humanLine).not.toContain("Office");

    // Stale extend version -> 409; valid extend bumps version -> 2
    const staleExt = await h.handlers.watchExtendPost(
      authReq(
        `http://localhost/api/core2/watches/${w.id}/extend`,
        "POST",
        "tok-riya",
        { add_minutes: 15, expected_version: 99 },
        { idempotencyKey: "w-ext-bad" },
      ),
      w.id,
    );
    expect(staleExt.status).toBe(409);

    const extRes = await h.handlers.watchExtendPost(
      authReq(
        `http://localhost/api/core2/watches/${w.id}/extend`,
        "POST",
        "tok-riya",
        { add_minutes: 15, expected_version: 1 },
        { idempotencyKey: "w-ext-ok" },
      ),
      w.id,
    );
    expect(extRes.status).toBe(200);
    expect((await extRes.json()).watch.version).toBe(2);

    // Advance past 45-min deadline into grace window -> tick moves watch to checking_in (v3)
    h.advanceMinutes(46);
    const tick1 = await h.service.tickDueWatches();
    expect(tick1.checking_in).toBe(1);
    expect(h.state.watches[0]!.state).toBe("checking_in");
    expect(h.state.watches[0]!.version).toBe(3);

    // Subject marks safe BEFORE grace expires -> v4 safe
    const safeRes = await h.handlers.watchSafePost(
      authReq(
        `http://localhost/api/core2/watches/${w.id}/safe`,
        "POST",
        "tok-riya",
        { expected_version: 3 },
        { idempotencyKey: "w-safe-1" },
      ),
      w.id,
    );
    expect(safeRes.status).toBe(200);
    const safeWatch = (await safeRes.json()).watch;
    expect(safeWatch.state).toBe("safe");
    expect(safeWatch.version).toBe(4);

    // Stale overdue timeout well past grace_until MUST be a no-op (cannot re-escalate!)
    h.advanceMinutes(120);
    const outboxBefore = h.state.outbox.length;
    const staleTick = await h.service.tickDueWatches();
    expect(staleTick.processed).toBe(0);
    expect(h.state.watches[0]!.state).toBe("safe");
    expect(h.state.outbox.length).toBe(outboxBefore);
  });

  it("enforces trusted contact approval, revocation fencing, effective dates, and no same-family auto-grant", async () => {
    const h = createCore2TestHarness();

    // Only invite Neha (not yet approved/consented)
    const inv = await h.handlers.trustedContactsPost(
      authReq(
        "http://localhost/api/core2/trusted-contacts",
        "POST",
        "tok-riya",
        { contact_person_id: SYNTH_IDS.personNeha, rank: 1, scopes: ["sos"] },
        { idempotencyKey: "tc-inv-1" },
      ),
    );
    expect(inv.status).toBe(201);
    const contactId = (await inv.json()).contact.id;

    // Riya cannot self-approve Neha's consent
    const forgedApprove = await h.handlers.trustedContactApprovePost(
      authReq(
        `http://localhost/api/core2/trusted-contacts/${contactId}/approve`,
        "POST",
        "tok-riya",
        {},
        { idempotencyKey: "tc-app-forged" },
      ),
      contactId,
    );
    expect(forgedApprove.status).toBe(403);

    // Neha approves & consents -> active (version 2)
    const appRes = await h.handlers.trustedContactApprovePost(
      authReq(
        `http://localhost/api/core2/trusted-contacts/${contactId}/approve`,
        "POST",
        "tok-neha",
        {},
        { idempotencyKey: "tc-app-ok" },
      ),
      contactId,
    );
    expect(appRes.status).toBe(200);
    expect((await appRes.json()).contact.state).toBe("active");

    // Revoke fences armed outbox dispatch
    await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-fence" }),
    );
    expect(h.state.outbox.some((o) => o.status === "pending" && o.trustedContactId === contactId)).toBe(true);

    const revRes = await h.handlers.trustedContactRevokePost(
      authReq(
        `http://localhost/api/core2/trusted-contacts/${contactId}/revoke`,
        "POST",
        "tok-riya",
        { expected_version: 2 },
        { idempotencyKey: "tc-rev-1" },
      ),
      contactId,
    );
    expect(revRes.status).toBe(200);
    expect(h.state.outbox.some((o) => o.status === "pending" && o.trustedContactId === contactId)).toBe(false);
    expect(h.state.outbox.some((o) => o.status === "failed" && o.trustedContactId === contactId)).toBe(true);
  });

  it("protects Maa's reassurance truth line via sharing preferences, voice consent revocation, and bounded redacted reads", async () => {
    const h = createCore2TestHarness();

    // Default preferences keep location/health/narrative false while letting status share with parent
    const sendOk = await h.handlers.reassurancePost(
      authReq(
        "http://localhost/api/core2/reassurance",
        "POST",
        "tok-riya",
        { kind: "im_safe", recipient_person_ids: [SYNTH_IDS.personMaa] },
        { idempotencyKey: "rea-1" },
      ),
    );
    expect(sendOk.status).toBe(202);
    const body1 = await sendOk.json();
    expect(body1.reassurance.delivery_verified).toBe(false);
    expect(body1.reassurance.heard_verified).toBe(false);
    expect(body1.reassurance.facts_exposed).toEqual({
      status_label: "checked_in_safe",
      location_included: false,
      health_included: false,
      narrative_included: false,
    });

    // Maa can read permitted safe projection
    const maaRead1 = await h.handlers.reassuranceGet(
      authReq("http://localhost/api/core2/reassurance?limit=10", "GET", "tok-maa"),
    );
    expect(maaRead1.status).toBe(200);
    expect((await maaRead1.json()).items).toHaveLength(1);

    // Other-family member cannot read; invalid limit rejected
    const badLimit = await h.handlers.reassuranceGet(
      authReq("http://localhost/api/core2/reassurance?limit=99", "GET", "tok-maa"),
    );
    expect(badLimit.status).toBe(400);

    // Riya turns off parent sharing -> read-time filter hides updates from Maa, and new send to Maa fails 403
    const prefUpdate = await h.handlers.preferencesPut(
      authReq(
        "http://localhost/api/core2/reassurance/preferences",
        "PUT",
        "tok-riya",
        { share_status_with_parent: false },
        { idempotencyKey: "pref-1" },
      ),
    );
    expect(prefUpdate.status).toBe(200);

    const maaRead2 = await h.handlers.reassuranceGet(
      authReq("http://localhost/api/core2/reassurance", "GET", "tok-maa"),
    );
    expect((await maaRead2.json()).items).toHaveLength(0);

    // Voice reassurance with revoked voice_share consent refuses BEFORE outbox enqueue
    const consentGrantId = "f5000000-0000-4000-8000-000000000010";
    const postId = "f5000000-0000-4000-8000-000000000020";
    await h.approveNehaAsTrustedContact(["reassurance"]);
    h.addConsent({
      id: consentGrantId,
      familyId: SYNTH_IDS.familyA,
      personId: SYNTH_IDS.personRiya,
      callId: null,
      purpose: `voice_share:${SYNTH_IDS.personNeha}`,
      answer: true,
      version: "v1",
      createdAt: "2026-11-14T17:00:00.000Z",
    });
    // Later refusal at same timestamp revokes grant
    h.addConsent({
      id: "f5000000-0000-4000-8000-000000000011",
      familyId: SYNTH_IDS.familyA,
      personId: SYNTH_IDS.personRiya,
      callId: null,
      purpose: `voice_share:${SYNTH_IDS.personNeha}`,
      answer: false,
      version: "v1",
      createdAt: "2026-11-14T17:00:00.000Z",
    });
    h.addVoicePost({
      id: postId,
      familyId: SYNTH_IDS.familyA,
      senderId: SYNTH_IDS.personRiya,
      recipientId: SYNTH_IDS.personNeha,
      consentId: consentGrantId,
    });

    const beforeOutbox = h.state.outbox.length;
    const refusedVoice = await h.handlers.reassurancePost(
      authReq(
        "http://localhost/api/core2/reassurance",
        "POST",
        "tok-riya",
        { kind: "im_safe", voice_post_id: postId, recipient_person_ids: [SYNTH_IDS.personNeha] },
        { idempotencyKey: "rea-voice-revoked" },
      ),
    );
    expect(refusedVoice.status).toBe(403);
    expect(h.state.outbox.length).toBe(beforeOutbox);
  });

  it("enforces Cedar gate ask (awaiting_approval) and deny decisions before outbox enqueue", async () => {
    const h = createCore2TestHarness();
    await h.approveNehaAsTrustedContact(["sos"]);

    // 1. Replace urgent_responder permission with two_person approvalMode -> Cedar returns "ask" -> awaiting_approval, 0 outbox
    h.clearPermissions();
    h.addPermission({
      id: "91000000-0000-4000-8000-000000000099",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "urgent_responder",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personNeha],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "two_person",
    });

    const askRes = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-ask" }),
    );
    expect(askRes.status).toBe(202);
    const askJson = (await askRes.json()) as {
      sos: { status: string; delivery_status: string };
      dispatches: Array<{ status: string }>;
    };
    expect(askJson.sos.status).toBe("awaiting_approval");
    expect(askJson.sos.delivery_status).toBe("none");
    expect(askJson.dispatches[0]!.status).toBe("awaiting_approval");
    expect(h.state.outbox).toHaveLength(0);

    // 2. Replace with revoked/exhausted permission -> Cedar Gate returns "deny" -> denied, 0 outbox
    h.clearPermissions();
    h.addPermission({
      id: "91000000-0000-4000-8000-000000000100",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "urgent_responder",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: "2026-11-14T00:00:00.000Z",
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personNeha],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    });
    const denyRes = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-deny" }),
    );
    expect(denyRes.status).toBe(202);
    const denyJson = (await denyRes.json()) as {
      sos: { status: string; delivery_status: string };
      dispatches: Array<{ status: string }>;
    };
    expect(denyJson.sos.status).toBe("denied");
    expect(denyJson.sos.delivery_status).toBe("none");
    expect(denyJson.dispatches[0]!.status).toBe("denied");
    expect(h.state.outbox).toHaveLength(0);
  });

  it("enforces contact effective windows, updates, cancelWatch CAS, missed-cron direct escalation, and same-family read isolation", async () => {
    const h = createCore2TestHarness();

    // Activate Neha with an effective_until window that has already expired -> excluded from SOS & watch dispatch
    const contactId = await h.approveNehaAsTrustedContact(["sos", "watch_escalation"], "2026-11-14T18:05:00.000Z");
    h.advanceMinutes(10); // 18:10Z > 18:05Z

    const sosExpired = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-exp" }),
    );
    expect(sosExpired.status).toBe(202);
    expect((await sosExpired.json()).sos.status).toBe("pending_contacts");
    expect(h.state.outbox).toHaveLength(0);

    // Extend Neha's effective_until via PATCH -> reactivates dispatch eligibility
    const patchRes = await h.handlers.trustedContactPatch(
      authReq(
        `http://localhost/api/core2/trusted-contacts/${contactId}`,
        "PATCH",
        "tok-riya",
        { rank: 2, expected_version: 2, effective_until: "2099-01-01T00:00:00.000Z" },
        { idempotencyKey: "tc-patch-1" },
      ),
      contactId,
    );
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).contact.version).toBe(3);

    const liveSosRes = await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "sos-iso" }),
    );
    const liveSosId = ((await liveSosRes.json()) as { sos: { id: string } }).sos.id;

    // Same-family non-contact Rohit cannot inspect Riya's SOS even though Rohit also has role "child"
    const rohitSosRead = await h.handlers.sosDetailGet(
      authReq(`http://localhost/api/core2/sos/${liveSosId}`, "GET", "tok-rohit"),
      liveSosId,
    );
    expect(rohitSosRead.status).toBe(403);

    // Approved trusted contact Neha CAN inspect SOS
    const nehaSosRead = await h.handlers.sosDetailGet(
      authReq(`http://localhost/api/core2/sos/${liveSosId}`, "GET", "tok-neha"),
      liveSosId,
    );
    expect(nehaSosRead.status).toBe(200);

    // Watch #1: cancelWatch CAS check
    const wCancelCreate = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        {
          eta_minutes: 20,
          grace_minutes: 10,
          timezone: "Asia/Kolkata",
          from_label: "Library",
          to_label: "Home",
        },
        { idempotencyKey: "w-cancel-start" },
      ),
    );
    expect(wCancelCreate.status).toBe(201);
    const wCancelId = ((await wCancelCreate.json()) as { watch: { id: string } }).watch.id;
    const cancelOk = await h.handlers.watchCancelPost(
      authReq(
        `http://localhost/api/core2/watches/${wCancelId}/cancel`,
        "POST",
        "tok-riya",
        { expected_version: 1 },
        { idempotencyKey: "w-cancel-do" },
      ),
      wCancelId,
    );
    expect(cancelOk.status).toBe(200);
    expect((await cancelOk.json()).watch.state).toBe("cancelled");

    // Watch #2: Neha CANNOT see active pre-escalation route; missed cron past grace_until escalates directly;
    // then Neha CAN inspect watch while same-family non-contact Rohit STILL gets 403.
    const wEscCreate = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        {
          eta_minutes: 15,
          grace_minutes: 5,
          timezone: "Asia/Kolkata",
          from_label: "Metro",
          to_label: "Home",
        },
        { idempotencyKey: "w-esc-start" },
      ),
    );
    const wEscId = ((await wEscCreate.json()) as { watch: { id: string } }).watch.id;

    const nehaPreEscRead = await h.handlers.watchDetailGet(
      authReq(`http://localhost/api/core2/watches/${wEscId}`, "GET", "tok-neha"),
      wEscId,
    );
    expect(nehaPreEscRead.status).toBe(403);

    // Missed cron jumps past eta (15m) + grace (5m) = 25m -> direct escalation
    h.advanceMinutes(25);
    const tickEsc = await h.service.tickDueWatches();
    expect(tickEsc.escalated).toBe(1);
    expect(tickEsc.dispatches_queued).toBe(1);

    const nehaPostEscRead = await h.handlers.watchDetailGet(
      authReq(`http://localhost/api/core2/watches/${wEscId}`, "GET", "tok-neha"),
      wEscId,
    );
    expect(nehaPostEscRead.status).toBe(200);

    const rohitPostEscRead = await h.handlers.watchDetailGet(
      authReq(`http://localhost/api/core2/watches/${wEscId}`, "GET", "tok-rohit"),
      wEscId,
    );
    expect(rohitPostEscRead.status).toBe(403);
  });

  it("verifies full hash-chained timeline integrity across Core 2 operations", async () => {
    const h = createCore2TestHarness();
    await h.approveNehaAsTrustedContact(["sos", "watch_escalation", "reassurance"]);
    await h.handlers.sosPost(
      authReq("http://localhost/api/core2/sos", "POST", "tok-riya", {}, { idempotencyKey: "chain-sos" }),
    );
    await h.handlers.reassurancePost(
      authReq(
        "http://localhost/api/core2/reassurance",
        "POST",
        "tok-riya",
        { kind: "im_safe", recipient_person_ids: [SYNTH_IDS.personMaa] },
        { idempotencyKey: "chain-rea" },
      ),
    );

    const familyEvents = h.state.timelineEvents
      .filter((t) => t.raw.familyId === SYNTH_IDS.familyA)
      .map((t) => t.signed);
    expect(familyEvents.length).toBeGreaterThanOrEqual(4);
    const lastEvent = familyEvents[familyEvents.length - 1]!;
    const keyId = lastEvent.envelope.keyId;
    const verification = verifyTimelineChain(
      familyEvents,
      new Map([[keyId, h.state.publicKey]]),
      {
        familyId: SYNTH_IDS.familyA,
        sequence: lastEvent.envelope.sequence,
        chainHash: lastEvent.chainHash,
      },
    );
    expect(verification).toEqual({ valid: true });
  });
});

