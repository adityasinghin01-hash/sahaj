import { describe, expect, it } from "vitest";
import { verifyTimelineChain } from "../../src/lib/timeline";
import { createCore2TestHarness, SYNTH_IDS } from "./harness";

const PRIYA_IDS = {
  userId: "a5000000-0000-4000-8000-000000000011",
  personId: "c5000000-0000-4000-8000-000000000011",
  token: "tok-priya",
} as const;

const SURESH_IDS = {
  userId: "a5000000-0000-4000-8000-000000000012",
  personId: "c5000000-0000-4000-8000-000000000012",
  token: "tok-suresh",
} as const;

function authReq(
  url: string,
  method: string,
  token: string,
  body?: unknown,
  opts?: { idempotencyKey?: string; familyId?: string },
): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (opts?.idempotencyKey) headers.set("idempotency-key", opts.idempotencyKey);
  if (opts?.familyId) headers.set("x-sahaj-family-id", opts.familyId);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cronReq(secret: string | null, body?: unknown): Request {
  const headers = new Headers();
  if (secret !== null) headers.set("x-cron-secret", secret);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost/api/core2/cron/overdue", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function truthReq(token: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/core2/truth-line", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function setupRankedResponders(h: ReturnType<typeof createCore2TestHarness>) {
  h.addTrustedActor({ ...PRIYA_IDS, displayName: "Priya Auntie", role: "circle" });
  h.addTrustedActor({ ...SURESH_IDS, displayName: "Suresh Uncle", role: "circle" });
  h.addPermission({
    id: "91000000-0000-4000-8000-000000000011",
    familyId: SYNTH_IDS.familyA,
    actorId: SYNTH_IDS.personRiya,
    action: "urgent_responder",
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    maxAmountMinor: 0,
    vendorIds: [],
    itemIds: [],
    targetIds: [PRIYA_IDS.personId, SURESH_IDS.personId],
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2099-01-01T00:00:00.000Z",
    maxUses: 100,
    usedCount: 0,
    approvalMode: "setup",
  });
}

describe("AGY-C2X: Core 2 overdue escalation, single-owner incident respond, and Sarvam truth line", () => {
  it("G1: enforces CRON_SECRET auth, sequential rank offering, no duplicate alerts before expiry, and timeout rotation", async () => {
    const h = createCore2TestHarness();
    setupRankedResponders(h);

    await h.approveTrustedContactFor({
      contactPersonId: PRIYA_IDS.personId,
      approverToken: PRIYA_IDS.token,
      rank: 1,
      scopes: ["watch_escalation", "reassurance"],
    });
    await h.approveTrustedContactFor({
      contactPersonId: SURESH_IDS.personId,
      approverToken: SURESH_IDS.token,
      rank: 2,
      scopes: ["watch_escalation", "reassurance"],
    });

    // 1. Auth checks on cron/overdue
    const noSecret = await h.handlers.cronOverduePost(cronReq(null));
    expect(noSecret.status).toBe(401);
    const badSecret = await h.handlers.cronOverduePost(cronReq("wrong-secret"));
    expect(badSecret.status).toBe(401);

    // Unconfigured secret fails closed (503)
    const noConfigHarness = createCore2TestHarness({ env: { CRON_SECRET: undefined } });
    const unconfiguredRes = await noConfigHarness.handlers.cronOverduePost(cronReq("anything"));
    expect(unconfiguredRes.status).toBe(503);

    // 2. Start watch (15m ETA + 5m grace)
    const watchRes = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        {
          eta_minutes: 15,
          grace_minutes: 5,
          timezone: "Asia/Kolkata",
          from_label: "Library",
          to_label: "Home",
        },
        { idempotencyKey: "g1-watch" },
      ),
    );
    expect(watchRes.status).toBe(201);

    // 3. Past ETA (16m) -> checking_in + 1 push check-in dispatch
    h.advanceMinutes(16);
    const t1 = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(t1.checking_in).toBe(1);
    expect(t1.escalated).toBe(0);
    expect(t1.dispatches_queued).toBe(1);

    // 4. Past grace (total 21m) -> escalated; offers ONLY rank #1 Priya
    h.advanceMinutes(5);
    const t2 = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(t2.escalated).toBe(1);
    expect(t2.dispatches_queued).toBe(1);
    expect(h.state.assignments.filter((a) => a.status === "offered")).toHaveLength(1);
    expect(h.state.assignments[0]!.personId).toBe(PRIYA_IDS.personId);

    // 5. Re-running cron 30s later (before 2m offer expiry) MUST NOT spam or rotate
    h.advanceSeconds(30);
    const outboxBefore = h.state.outbox.length;
    const tReplay = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tReplay.rotated_offers).toBe(0);
    expect(tReplay.dispatches_queued).toBe(0);
    expect(h.state.outbox.length).toBe(outboxBefore);

    // 6. Advance past 2m offer expiry -> Priya's offer expires, Suresh (rank 2) offered
    h.advanceSeconds(95);
    const tRotate = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tRotate.rotated_offers).toBe(1);
    expect(tRotate.dispatches_queued).toBe(1);
    expect(h.state.assignments.map((a) => [a.personId, a.status])).toEqual([
      [PRIYA_IDS.personId, "expired"],
      [SURESH_IDS.personId, "offered"],
    ]);

    // 7. Advance past Suresh's 2m offer expiry -> exhausted, repeated cron is no-op
    h.advanceMinutes(3);
    const tExhaust = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tExhaust.exhausted).toBe(1);
    expect(tExhaust.dispatches_queued).toBe(0);

    const tAfterExhaust = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tAfterExhaust.rotated_offers).toBe(0);
    expect(tAfterExhaust.exhausted).toBe(0);
    expect(tAfterExhaust.dispatches_queued).toBe(0);
  });

  it("G1: DEMO_TIMER_SCALE accelerates watch ETA, grace, and escalation offer timeouts with zero WhatsApp channels", async () => {
    const h = createCore2TestHarness({ env: { DEMO_TIMER_SCALE: "60" } });
    setupRankedResponders(h);

    await h.approveTrustedContactFor({
      contactPersonId: PRIYA_IDS.personId,
      approverToken: PRIYA_IDS.token,
      rank: 1,
      scopes: ["watch_escalation"],
    });
    await h.approveTrustedContactFor({
      contactPersonId: SURESH_IDS.personId,
      approverToken: SURESH_IDS.token,
      rank: 2,
      scopes: ["watch_escalation"],
    });

    // 15m ETA / 60 = 15s, 5m grace / 60 = 5s
    const startRes = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        { eta_minutes: 15, grace_minutes: 5, timezone: "Asia/Kolkata", from_label: "Cafe", to_label: "Home" },
        { idempotencyKey: "scaled-watch" },
      ),
    );
    expect(startRes.status).toBe(201);

    h.advanceSeconds(16);
    const tCheck = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tCheck.timer_scale).toBe(60);
    expect(tCheck.checking_in).toBe(1);

    h.advanceSeconds(6);
    const tEsc = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tEsc.escalated).toBe(1);
    expect(h.state.assignments[0]!.personId).toBe(PRIYA_IDS.personId);

    // 2m offer expiry / 60 = 2s
    h.advanceSeconds(3);
    const tRot = await (await h.handlers.cronOverduePost(cronReq("test-cron-secret"))).json();
    expect(tRot.rotated_offers).toBe(1);
    expect(h.state.assignments[1]!.personId).toBe(SURESH_IDS.personId);
    expect(JSON.stringify(h.state.rawEvents)).not.toContain("whatsapp");
    expect(JSON.stringify(h.state.timelineEvents)).not.toContain("whatsapp");
  });

  it("I4: enforces single-owner incident acceptance, immediate rotation on decline, revocation fencing, and closed incident guard", async () => {
    const h = createCore2TestHarness();
    setupRankedResponders(h);

    const priyaTcId = await h.approveTrustedContactFor({
      contactPersonId: PRIYA_IDS.personId,
      approverToken: PRIYA_IDS.token,
      rank: 1,
      scopes: ["watch_escalation", "reassurance"],
    });
    await h.approveTrustedContactFor({
      contactPersonId: SURESH_IDS.personId,
      approverToken: SURESH_IDS.token,
      rank: 2,
      scopes: ["watch_escalation", "reassurance"],
    });

    const wRes = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        { eta_minutes: 10, grace_minutes: 2, timezone: "Asia/Kolkata", from_label: "Work", to_label: "Home" },
        { idempotencyKey: "i4-watch" },
      ),
    );
    const watchId = ((await wRes.json()) as { watch: { id: string } }).watch.id;

    h.advanceMinutes(15);
    await h.handlers.cronOverduePost(cronReq("test-cron-secret"));
    const incidentId = h.state.watches.find((w) => w.id === watchId)!.incidentId!;

    // Suresh cannot accept while Priya holds the offer
    const sureshPremature = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", SURESH_IDS.token, {}),
      incidentId,
    );
    expect(sureshPremature.status).toBe(403);

    // Priya declines -> immediately rotates to Suresh
    const priyaDecline = await h.handlers.incidentDeclinePost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/decline`, "POST", PRIYA_IDS.token, {}),
      incidentId,
    );
    expect(priyaDecline.status).toBe(200);
    const declineBody = await priyaDecline.json();
    expect(declineBody.declined).toBe(true);
    expect(declineBody.next_contact_person_id).toBe(SURESH_IDS.personId);

    // Priya idempotent decline replay returns already_declined
    const priyaDeclineReplay = await h.handlers.incidentDeclinePost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/decline`, "POST", PRIYA_IDS.token, {}),
      incidentId,
    );
    expect(priyaDeclineReplay.status).toBe(200);
    expect((await priyaDeclineReplay.json()).already_declined).toBe(true);

    // Suresh accepts -> becomes sole owner + truth line reflects Suresh
    const sureshAccept = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", SURESH_IDS.token, {}),
      incidentId,
    );
    expect(sureshAccept.status).toBe(200);
    const acceptBody = await sureshAccept.json();
    expect(acceptBody.accepted).toBe(true);
    expect(acceptBody.already_accepted).toBe(false);
    expect(acceptBody.responder_person_id).toBe(SURESH_IDS.personId);

    // Suresh replay is idempotent
    const sureshReplay = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", SURESH_IDS.token, {}),
      incidentId,
    );
    expect(sureshReplay.status).toBe(200);
    expect((await sureshReplay.json()).already_accepted).toBe(true);

    // Priya trying to accept after Suresh accepted -> 409 incident_already_accepted
    const secondOwnerAttempt = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", PRIYA_IDS.token, {}),
      incidentId,
    );
    expect(secondOwnerAttempt.status).toBe(409);
    expect((await secondOwnerAttempt.json()).error).toBe("incident_already_accepted");

    // Cross-family outsider cannot access
    const outsiderAttempt = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", "tok-other", {}),
      incidentId,
    );
    expect(outsiderAttempt.status).toBe(404);

    // Revoked contact cannot accept another incident
    const w2Res = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        { eta_minutes: 10, grace_minutes: 2, timezone: "Asia/Kolkata", from_label: "Mall", to_label: "Home" },
        { idempotencyKey: "i4-watch-2" },
      ),
    );
    const w2Id = ((await w2Res.json()) as { watch: { id: string } }).watch.id;
    h.advanceMinutes(15);
    await h.handlers.cronOverduePost(cronReq("test-cron-secret"));
    const inc2 = h.state.watches.find((w) => w.id === w2Id)!.incidentId!;

    await h.handlers.trustedContactRevokePost(
      authReq(`http://localhost/api/core2/trusted-contacts/${priyaTcId}/revoke`, "POST", "tok-riya", {}, { idempotencyKey: "rev-priya" }),
      priyaTcId,
    );

    const revokedAccept = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${inc2}/accept`, "POST", PRIYA_IDS.token, {}),
      inc2,
    );
    expect(revokedAccept.status).toBe(403);

    // Watch marked safe closes incident; accept on closed incident returns 409 incident_closed
    await h.handlers.watchSafePost(
      authReq(`http://localhost/api/core2/watches/${w2Id}/safe`, "POST", "tok-riya", {}, { idempotencyKey: "safe-w2" }),
      w2Id,
    );
    const closedAccept = await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${inc2}/accept`, "POST", SURESH_IDS.token, {}),
      inc2,
    );
    expect(closedAccept.status).toBe(409);
    expect((await closedAccept.json()).error).toBe("incident_closed");

    // Hash-chained timeline remains valid
    const familyEvents = h.state.timelineEvents
      .filter((t) => t.raw.familyId === SYNTH_IDS.familyA)
      .map((t) => t.signed);
    const lastEvent = familyEvents[familyEvents.length - 1]!;
    expect(
      verifyTimelineChain(
        familyEvents,
        new Map([[lastEvent.envelope.keyId, h.state.publicKey]]),
        {
          familyId: SYNTH_IDS.familyA,
          sequence: lastEvent.envelope.sequence,
          chainHash: lastEvent.chainHash,
        },
      ),
    ).toEqual({ valid: true });
  });

  it("G4: Maa Sarvam truth-line returns deterministic calm Hindi status, enforces auth/role/privacy, and leaks zero location", async () => {
    const h = createCore2TestHarness();
    setupRankedResponders(h);
    await h.approveTrustedContactFor({
      contactPersonId: PRIYA_IDS.personId,
      approverToken: PRIYA_IDS.token,
      rank: 1,
      scopes: ["watch_escalation", "reassurance"],
    });

    // Auth checks
    expect((await h.handlers.truthLinePost(truthReq(null, { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }))).status).toBe(401);
    expect((await h.handlers.truthLinePost(truthReq("wrong", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }))).status).toBe(401);

    // Non-parent role rejected
    expect((await h.handlers.truthLinePost(truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personRiya }))).status).toBe(403);

    // 1. Default ok (no active watch or SOS)
    const okRes = await h.handlers.truthLinePost(
      truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({
      ok: true,
      status: "ok",
      spoken_text: "Riya bilkul theek hai",
    });

    // 2. Active watch before deadline -> calm ETA without any location labels
    const watchRes = await h.handlers.watchesPost(
      authReq(
        "http://localhost/api/core2/watches",
        "POST",
        "tok-riya",
        {
          eta_minutes: 15,
          grace_minutes: 5,
          timezone: "Asia/Kolkata",
          from_label: "SecretMetroStation",
          to_label: "SecretHostelBlockC",
        },
        { idempotencyKey: "g4-watch" },
      ),
    );
    const watchId = ((await watchRes.json()) as { watch: { id: string } }).watch.id;
    h.advanceMinutes(1);

    const enRouteRes = await h.handlers.truthLinePost(
      truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
    );
    const enRouteBody = await enRouteRes.json();
    expect(enRouteBody.status).toBe("en_route");
    expect(enRouteBody.spoken_text).toBe("Riya raste mein hai, 14 minute mein pahunchegi");
    expect(JSON.stringify(enRouteBody)).not.toMatch(/SecretMetroStation|SecretHostelBlockC/i);

    // 3. Checking in -> calm delay reassurance
    h.advanceMinutes(15);
    await h.handlers.cronOverduePost(cronReq("test-cron-secret"));
    const checkInBody = await (
      await h.handlers.truthLinePost(
        truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
      )
    ).json();
    expect(checkInBody.status).toBe("checking_in");
    expect(checkInBody.spoken_text).toBe("Riya raste mein hai, thodi der mein pahunch jayegi");

    // 4. Escalated (offered to Priya, not yet accepted) -> calm non-alarming line
    h.advanceMinutes(5);
    await h.handlers.cronOverduePost(cronReq("test-cron-secret"));
    const escBody = await (
      await h.handlers.truthLinePost(
        truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
      )
    ).json();
    expect(escBody.status).toBe("family_checking");
    expect(escBody.spoken_text).toBe("Riya ke trusted parivar sadasya se sampark kiya gaya hai, sab theek hai");
    expect(escBody.spoken_text).not.toMatch(/sos|emergency|danger|police|overdue|alert/i);

    // 5. Priya accepts -> calm responder-on-the-way line
    const incidentId = h.state.watches.find((w) => w.id === watchId)!.incidentId!;
    await h.handlers.incidentAcceptPost(
      authReq(`http://localhost/api/core2/incidents/${incidentId}/accept`, "POST", PRIYA_IDS.token, {}),
      incidentId,
    );
    const acceptedBody = await (
      await h.handlers.truthLinePost(
        truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
      )
    ).json();
    expect(acceptedBody.status).toBe("responder_accepted");
    expect(acceptedBody.spoken_text).toBe("Priya Riya ko dekhne ja rahi hai");

    // 6. Privacy preference share_status_with_parent=false blocks status leakage
    const privPut = await h.handlers.preferencesPut(
      authReq(
        "http://localhost/api/core2/reassurance/preferences",
        "PUT",
        "tok-riya",
        { share_status_with_parent: false },
        { idempotencyKey: "g4-pref-false" },
      ),
    );
    expect(privPut.status).toBe(200);
    const privateBody = await (
      await h.handlers.truthLinePost(
        truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
      )
    ).json();
    expect(privateBody.status).toBe("private");
    expect(privateBody.privacy_restricted).toBe(true);
    expect(privateBody.spoken_text).not.toContain("Priya");

    // 7. Re-enable sharing + mark safe -> calm home-safe line
    const privRestore = await h.handlers.preferencesPut(
      authReq(
        "http://localhost/api/core2/reassurance/preferences",
        "PUT",
        "tok-riya",
        { share_status_with_parent: true },
        { idempotencyKey: "g4-pref-true" },
      ),
    );
    expect(privRestore.status).toBe(200);
    await h.handlers.watchSafePost(
      authReq(`http://localhost/api/core2/watches/${watchId}/safe`, "POST", "tok-riya", {}, { idempotencyKey: "g4-safe" }),
      watchId,
    );
    const safeBody = await (
      await h.handlers.truthLinePost(
        truthReq("test-sarvam-token", { family_id: SYNTH_IDS.familyA, parent_id: SYNTH_IDS.personMaa }),
      )
    ).json();
    expect(safeBody.status).toBe("safe");
    expect(safeBody.spoken_text).toBe("Riya ghar pahunch gayi hai");
  });
});
