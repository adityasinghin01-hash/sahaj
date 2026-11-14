import { describe, expect, it } from "vitest";
import {
  formatHeardBadge,
  handleAfterReportGet,
  handleCircleOfferPost,
  handleCloseIncidentPost,
  handleDeviceHeardPost,
  handleGentleNewsGet,
  handleGentleNewsTickPost,
  handleHeardStatusGet,
  handleMarkHurtPost,
  handleSarvamNewsToolPost,
  handleTwilioHeardGatherPost,
  handleTwilioHeardStatusPost,
} from "@/lib/core2-news";
import {
  buildSignedDeviceRequest,
  buildSignedTwilioFormRequest,
  createCore2NewsTestHarness,
  TEST_IDS,
} from "./harness";

describe("AGY-X2: Core 2 G8 Gentle News, G9 After-Report (Zapier Z3) & Verified Heard Proof", () => {
  it("G8: stages hurt/hospital news through Core 1 circle first and NEVER notifies Maa directly", async () => {
    const h = await createCore2NewsTestHarness();

    const markReq = new Request("https://sahaj.test/api/core2/news", {
      method: "POST",
      headers: {
        authorization: "Bearer tok-riya",
        "idempotency-key": "idem-hurt-001",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        incident_id: TEST_IDS.incident1,
        calm_summary:
          "Riya ko mamooli chot aayi hai (+91 9811122233), doctor dekh rahe hain aur woh bilkul hosh mein hai.",
        voice_post_id: TEST_IDS.voicePost1,
      }),
    });

    const markRes = await handleMarkHurtPost(markReq, h.deps);
    expect(markRes.status).toBe(201);
    const dto = await markRes.json();
    expect(dto.status).toBe("circle_offered");
    expect(dto.circle_person_id).toBe(TEST_IDS.sharma);
    expect(dto.circle_display_name).toBe("Sharma Uncle");
    expect(dto.circle_offer_status).toBe("offered");
    expect(dto.maa_notified_via_push).toBe(false);
    expect(dto.maa_call_queued_at).toBeNull();
    // Phone numbers inside calm_summary are automatically masked
    expect(dto.calm_summary).not.toContain("9811122233");
    expect(dto.calm_summary).toContain("<PHONE>");
    // DEMO_TIMER_SCALE=100 scales 5 min (300,000ms) -> 3,000ms
    expect(dto.remaining_ms).toBe(3000);

    // Outbox has ONLY the circle offer to Sharma Uncle, never a notification or call to Maa
    expect(h.outboxEntries).toHaveLength(1);
    expect(h.outboxEntries[0].kind).toBe("gentle_news.circle_offer");
    expect(h.outboxEntries[0].payload.recipient_person_id).toBe(TEST_IDS.sharma);

    // Maa (parent) is forbidden from reading pending gentle news
    const maaRead = await handleGentleNewsGet(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}`, {
        headers: { authorization: "Bearer tok-maa" },
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(maaRead.status).toBe(403);

    // Sharma Uncle declines -> automatically offers next Core 1 circle member (Rohit)
    const declineRes = await handleCircleOfferPost(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}/circle`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-sharma",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "decline" }),
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(declineRes.status).toBe(200);
    const afterDecline = await declineRes.json();
    expect(afterDecline.circle_person_id).toBe(TEST_IDS.rohit);
    expect(afterDecline.circle_display_name).toBe("Rohit");
    expect(afterDecline.circle_offer_status).toBe("offered");

    // Rohit accepts and then confirms "Maa ke paas hoon" -> queues calm Sarvam call to Maa
    const acceptRes = await handleCircleOfferPost(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}/circle`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-rohit",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(acceptRes.status).toBe(200);

    const withMaaRes = await handleCircleOfferPost(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}/circle`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-rohit",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "with_maa" }),
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(withMaaRes.status).toBe(200);
    const afterWithMaa = await withMaaRes.json();
    expect(afterWithMaa.status).toBe("maa_call_queued");
    expect(afterWithMaa.circle_offer_status).toBe("with_maa");
    expect(afterWithMaa.maa_call_queued_at).toBeTruthy();

    const maaCall = h.outboxEntries.find((o) => o.kind === "sarvam.outbound_call");
    expect(maaCall).toBeDefined();
    expect(maaCall?.payload.recipient_person_id).toBe(TEST_IDS.maa);
    expect(maaCall?.payload.ai_disclosed).toBe(true);
    expect(maaCall?.payload.ai_cloned_voice_used).toBe(false);
    expect(maaCall?.payload.voice_post_id).toBe(TEST_IDS.voicePost1);
    expect(maaCall?.payload.companion_with_maa).toBe(true);
  });

  it("G8: queues calm Maa call on timer expiry (DEMO_TIMER_SCALE) and serves Aasha Didi 1-Sahaj + Maa questions", async () => {
    const h = await createCore2NewsTestHarness();

    // Accepting responder (Sharma Uncle) can also mark hurt/hospital
    const res = await handleMarkHurtPost(
      new Request("https://sahaj.test/api/core2/news", {
        method: "POST",
        headers: {
          authorization: "Bearer tok-sharma",
          "idempotency-key": "idem-hurt-sharma-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          incident_id: TEST_IDS.incident1,
          calm_summary: "Riya hospital mein doctor ke paas hai, sab control mein hai.",
          voice_post_id: TEST_IDS.voicePost1,
        }),
      }),
      h.deps,
    );
    expect(res.status).toBe(201);

    // If Maa calls "1 Sahaj" BEFORE the timer fires, Aasha Didi returns the calm short version
    const aashaRes = await handleSarvamNewsToolPost(
      new Request("https://sahaj.test/api/core2/news/sarvam", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_IDS.sarvamToolToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "aasha_didi_check",
          family_id: TEST_IDS.familyA,
          parent_person_id: TEST_IDS.maa,
        }),
      }),
      h.deps,
    );
    expect(aashaRes.status).toBe(200);
    const aashaJson = await aashaRes.json();
    expect(aashaJson.has_active_news).toBe(true);
    expect(aashaJson.ai_disclosed).toBe(true);
    expect(aashaJson.ai_cloned_voice_used).toBe(false);
    expect(aashaJson.has_family_voice_note).toBe(true);
    expect(aashaJson.voice_post_id).toBe(TEST_IDS.voicePost1);
    expect(String(aashaJson.speak_hi)).toContain("Aasha Didi");

    // Maa asks questions during the call -> redacted and sent calmly to Riya
    const qRes = await handleSarvamNewsToolPost(
      new Request("https://sahaj.test/api/core2/news/sarvam", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_IDS.sarvamToolToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "record_maa_questions",
          family_id: TEST_IDS.familyA,
          incident_id: TEST_IDS.incident1,
          questions: [
            "Riya ne paani piya kya?",
            "Doctor ka number 9876500001 hai kya?",
          ],
        }),
      }),
      h.deps,
    );
    expect(qRes.status).toBe(200);
    const qJson = await qRes.json();
    expect(qJson.recorded_count).toBe(2);
    expect(qJson.maa_questions[1].question).not.toContain("9876500001");
    expect(qJson.maa_questions[1].question).toContain("<PHONE>");

    const calmPush = h.outboxEntries.find((o) => o.kind === "expo.calm_questions");
    expect(calmPush).toBeDefined();
    expect(calmPush?.payload.recipient_person_id).toBe(TEST_IDS.riya);
  });

  it("G8: tick route honors CRON_SECRET and queues due gentle news calls when wait window passes", async () => {
    const h = await createCore2NewsTestHarness();

    await handleMarkHurtPost(
      new Request("https://sahaj.test/api/core2/news", {
        method: "POST",
        headers: {
          authorization: "Bearer tok-riya",
          "idempotency-key": "idem-hurt-tick-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          incident_id: TEST_IDS.incident1,
          calm_summary: "Riya safe hai aur checkup chal raha hai.",
        }),
      }),
      h.deps,
    );

    // Wrong cron secret -> 401
    const badTick = await handleGentleNewsTickPost(
      new Request("https://sahaj.test/api/core2/news/tick", {
        method: "POST",
        headers: { "x-cron-secret": "wrong" },
      }),
      h.deps,
    );
    expect(badTick.status).toBe(401);

    // Advance clock past scaled 3000ms wait window
    h.advanceClockMs(3500);

    const okTick = await handleGentleNewsTickPost(
      new Request("https://sahaj.test/api/core2/news/tick", {
        method: "POST",
        headers: { "x-cron-secret": TEST_IDS.cronSecret },
      }),
      h.deps,
    );
    expect(okTick.status).toBe(200);
    const tickBody = await okTick.json();
    expect(tickBody.processed).toBe(1);
    expect(tickBody.queued_incident_ids).toEqual([TEST_IDS.incident1]);
  });

  it("Heard proof: verifies Maa smartphone playback completion via verifyMaaDeviceRequest and rejects partial/timer playback", async () => {
    const h = await createCore2NewsTestHarness();
    h.setClockIso("2026-11-14T19:42:00.000Z"); // 01:12 IST on 15 Nov!

    // Before proof: status is unconfirmed ("Bheja gaya — sunna confirm nahi")
    const beforeRes = await handleHeardStatusGet(
      new Request(
        `https://sahaj.test/api/core2/heard?delivery_id=${TEST_IDS.reassurance1}&message_kind=core2_reassurance`,
        { headers: { authorization: "Bearer tok-riya" } },
      ),
      h.deps,
    );
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    expect(beforeJson.heard_verified).toBe(false);
    expect(beforeJson.badge_label).toBe("Bheja gaya — sunna confirm nahi");

    // Partial playback (played_duration_s < clip_duration_s) is rejected (400)
    const partialReq = await buildSignedDeviceRequest(
      "https://sahaj.test/api/core2/heard/device",
      {
        message_kind: "core2_reassurance",
        delivery_id: TEST_IDS.reassurance1,
        reassurance_id: TEST_IDS.reassurance1,
        voice_post_id: TEST_IDS.voicePost1,
        clip_duration_s: 14,
        played_duration_s: 9,
        playback_finished: true,
      },
      { tsMs: Date.parse("2026-11-14T19:42:00.000Z") },
    );
    const partialRes = await handleDeviceHeardPost(partialReq, h.deps);
    expect(partialRes.status).toBe(400);

    // Tampered device signature is rejected (401)
    const tamperedReq = await buildSignedDeviceRequest(
      "https://sahaj.test/api/core2/heard/device",
      {
        message_kind: "core2_reassurance",
        delivery_id: TEST_IDS.reassurance1,
        clip_duration_s: 14,
        played_duration_s: 14,
        playback_finished: true,
      },
      { tsMs: Date.parse("2026-11-14T19:42:01.000Z"), tamperSig: true },
    );
    const tamperedRes = await handleDeviceHeardPost(tamperedReq, h.deps);
    expect(tamperedRes.status).toBe(401);

    // Valid full playback completion -> marks HEARD with "Maa ne suna ✓ 01:12"
    const validReq = await buildSignedDeviceRequest(
      "https://sahaj.test/api/core2/heard/device",
      {
        message_kind: "core2_reassurance",
        delivery_id: TEST_IDS.reassurance1,
        reassurance_id: TEST_IDS.reassurance1,
        voice_post_id: TEST_IDS.voicePost1,
        clip_duration_s: 14,
        played_duration_s: 15,
        playback_finished: true,
        finished_at: "2026-11-14T19:42:00.000Z",
      },
      { tsMs: Date.parse("2026-11-14T19:42:02.000Z") },
    );
    const validRes = await handleDeviceHeardPost(validReq, h.deps);
    expect(validRes.status).toBe(200);
    const validJson = await validRes.json();
    expect(validJson.ok).toBe(true);
    expect(validJson.badge_label).toBe("Maa ne suna ✓ 01:12");
    expect(h.reassurances.get(TEST_IDS.reassurance1)?.heard_verified).toBe(true);
    expect(h.voicePosts.get(TEST_IDS.voicePost1)?.state).toBe("heard");

    // Replay of identical signed request is blocked by replayGuard (401)
    const replayReq = await buildSignedDeviceRequest(
      "https://sahaj.test/api/core2/heard/device",
      {
        message_kind: "core2_reassurance",
        delivery_id: TEST_IDS.reassurance1,
        reassurance_id: TEST_IDS.reassurance1,
        voice_post_id: TEST_IDS.voicePost1,
        clip_duration_s: 14,
        played_duration_s: 15,
        playback_finished: true,
        finished_at: "2026-11-14T19:42:00.000Z",
      },
      { tsMs: Date.parse("2026-11-14T19:42:02.000Z") },
    );
    const replayRes = await handleDeviceHeardPost(replayReq, h.deps);
    expect(replayRes.status).toBe(401);
  });

  it("Heard proof: verifies keypad Twilio Gather (playback_completed + key) and Twilio Status (CallDuration >= clip_duration_s)", async () => {
    const h = await createCore2NewsTestHarness();
    h.setClockIso("2026-11-14T19:42:00.000Z");

    const gatherUrl = "https://sahaj.test/api/core2/heard/twilio/gather";
    // 1. Gather without key press or incomplete playback -> NOT marked heard
    const incompleteGather = buildSignedTwilioFormRequest(gatherUrl, {
      CallSid: "CA100001",
      Digits: "1",
      playback_completed: "false",
      family_id: TEST_IDS.familyA,
      message_kind: "core1_voice_post",
      delivery_id: TEST_IDS.voicePost1,
      voice_post_id: TEST_IDS.voicePost1,
      recipient_person_id: TEST_IDS.maa,
      clip_duration_s: "12",
    });
    const incGatherRes = await handleTwilioHeardGatherPost(incompleteGather, h.deps);
    expect(incGatherRes.status).toBe(200);
    expect(incGatherRes.headers.get("x-sahaj-heard")).toBe("false");
    expect(h.voicePosts.get(TEST_IDS.voicePost1)?.state).toBe("delivered");

    // 2. Gather with playback_completed=true AND Digits=1 -> marked HEARD
    const validGather = buildSignedTwilioFormRequest(gatherUrl, {
      CallSid: "CA100001",
      Digits: "1",
      playback_completed: "true",
      family_id: TEST_IDS.familyA,
      message_kind: "core1_voice_post",
      delivery_id: TEST_IDS.voicePost1,
      voice_post_id: TEST_IDS.voicePost1,
      recipient_person_id: TEST_IDS.maa,
      clip_duration_s: "12",
    });
    const okGatherRes = await handleTwilioHeardGatherPost(validGather, h.deps);
    expect(okGatherRes.status).toBe(200);
    expect(okGatherRes.headers.get("x-sahaj-heard")).toBe("true");
    expect(okGatherRes.headers.get("x-sahaj-evidence-type")).toBe(
      "twilio_gather_after_playback",
    );
    expect(decodeURIComponent(okGatherRes.headers.get("x-sahaj-badge-label") ?? "")).toBe(
      "Maa ne suna ✓ 01:12",
    );
    expect(h.voicePosts.get(TEST_IDS.voicePost1)?.state).toBe("heard");

    // 3. Status callback: short call (CallDuration < clip_duration_s) -> NOT marked heard
    const statusUrl = "https://sahaj.test/api/core2/heard/twilio/status";
    const shortStatus = buildSignedTwilioFormRequest(statusUrl, {
      CallSid: "CA200002",
      CallStatus: "completed",
      CallDuration: "6",
      family_id: TEST_IDS.familyA,
      message_kind: "core2_reassurance",
      delivery_id: TEST_IDS.reassurance1,
      reassurance_id: TEST_IDS.reassurance1,
      recipient_person_id: TEST_IDS.maa,
      clip_duration_s: "14",
    });
    const shortRes = await handleTwilioHeardStatusPost(shortStatus, h.deps);
    expect(shortRes.status).toBe(200);
    const shortJson = await shortRes.json();
    expect(shortJson.heard).toBe(false);
    expect(shortJson.badge_label).toBe("Bheja gaya — sunna confirm nahi");

    // 4. Status callback: completed call with CallDuration >= clip_duration_s -> marked HEARD
    const fullStatus = buildSignedTwilioFormRequest(statusUrl, {
      CallSid: "CA200002",
      CallStatus: "completed",
      CallDuration: "16",
      family_id: TEST_IDS.familyA,
      message_kind: "core2_reassurance",
      delivery_id: TEST_IDS.reassurance1,
      reassurance_id: TEST_IDS.reassurance1,
      recipient_person_id: TEST_IDS.maa,
      clip_duration_s: "14",
    });
    const fullRes = await handleTwilioHeardStatusPost(fullStatus, h.deps);
    expect(fullRes.status).toBe(200);
    const fullJson = await fullRes.json();
    expect(fullJson.heard).toBe(true);
    expect(fullJson.evidence_type).toBe("twilio_status_duration_gte_clip");
    expect(fullJson.badge_label).toBe("Maa ne suna ✓ 01:12");
  });

  it("G9 + Zapier Z3: builds redacted after-report from signed timeline and fires Z3 without blocking on failure", async () => {
    const h = await createCore2NewsTestHarness({
      env: { ZAPIER_HOOK_Z3: "https://hooks.zapier.com/hooks/catch/test/z3" },
      zapierResult: { ok: true, status: 200 },
    });
    h.setClockIso("2026-11-14T19:42:00.000Z");

    // Mark hurt + record heard receipt first
    await handleMarkHurtPost(
      new Request("https://sahaj.test/api/core2/news", {
        method: "POST",
        headers: {
          authorization: "Bearer tok-riya",
          "idempotency-key": "idem-g9-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          incident_id: TEST_IDS.incident1,
          calm_summary: "Riya hospital mein doctor ke saath hai.",
          voice_post_id: TEST_IDS.voicePost1,
        }),
      }),
      h.deps,
    );

    const devReq = await buildSignedDeviceRequest(
      "https://sahaj.test/api/core2/heard/device",
      {
        message_kind: "core2_reassurance",
        delivery_id: TEST_IDS.reassurance1,
        reassurance_id: TEST_IDS.reassurance1,
        voice_post_id: TEST_IDS.voicePost1,
        clip_duration_s: 12,
        played_duration_s: 12,
        playback_finished: true,
        finished_at: "2026-11-14T19:42:00.000Z",
      },
      { tsMs: Date.parse("2026-11-14T19:42:00.000Z") },
    );
    await handleDeviceHeardPost(devReq, h.deps);

    h.advanceClockMs(60_000); // close 1 min later

    const closeRes = await handleCloseIncidentPost(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}/close`, {
        method: "POST",
        headers: { authorization: "Bearer tok-riya" },
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(closeRes.status).toBe(200);
    const report = await closeRes.json();

    expect(report.schema_version).toBe("sahaj.after_report.v1");
    expect(report.redaction).toEqual({
      phone_numbers_stripped: true,
      location_trail_stripped: true,
      ai_cloned_voice_used: false,
    });
    expect(report.what_happened.timeline_chain_verified).toBe(true);
    expect(report.what_happened.timeline_entries.length).toBeGreaterThanOrEqual(2);
    expect(report.who_accepted.owner_name).toBe("Sharma Uncle");
    expect(report.deliveries).toHaveLength(1);
    expect(report.deliveries[0].heard).toBe(true);
    expect(report.deliveries[0].heard_evidence).toBe("device_signed_playback_end");
    expect(report.deliveries[0].badge_label).toBe("Maa ne suna ✓ 01:12");
    // Ensure phone number in reassurance label was redacted
    expect(JSON.stringify(report)).not.toContain("9876543210");
    expect(report.zapier_z3.status).toBe("sent");
    expect(h.zapierCalls).toHaveLength(1);
    expect(h.zapierCalls[0].payload.schema).toBe("sahaj.zapier.z3.v1");
    expect(h.zapierCalls[0].payload.heard_count).toBe(1);
    // K-ZAP: exact Z3 field list (documented in docs/zapier/WIRING.md); names/report stay in Sahaj.
    expect(Object.keys(h.zapierCalls[0].payload).sort()).toEqual([
      "accepted_at", "accepted_by_name", "closed_at", "deliveries_count", "event", "family_id",
      "heard_count", "incident_id", "report", "resolution_duration_s", "schema", "summary_line",
    ]);
    expect(h.zapierCalls[0].payload.accepted_by_name).toBeNull();
    expect(h.zapierCalls[0].payload.report).toBeNull();
    expect(JSON.stringify(h.zapierCalls[0].payload)).not.toMatch(/Sharma|"(lat|lng|location|phone)"|9876543210|\+91/i);

    // Cross-family child cannot read this after-report
    const crossRead = await handleAfterReportGet(
      new Request(`https://sahaj.test/api/core2/after-report/${TEST_IDS.incident1}`, {
        headers: { authorization: "Bearer tok-other" },
      }),
      TEST_IDS.incident1,
      h.deps,
    );
    expect(crossRead.status).toBe(404);

    // Non-blocking Zapier failure test on a second harness
    const hFail = await createCore2NewsTestHarness({
      env: { ZAPIER_HOOK_Z3: "https://hooks.zapier.com/hooks/catch/test/z3-fail" },
      zapierResult: "throw",
    });
    const failCloseRes = await handleCloseIncidentPost(
      new Request(`https://sahaj.test/api/core2/news/${TEST_IDS.incident1}/close`, {
        method: "POST",
        headers: { authorization: "Bearer tok-riya" },
      }),
      TEST_IDS.incident1,
      hFail.deps,
    );
    expect(failCloseRes.status).toBe(200);
    const failReport = await failCloseRes.json();
    expect(failReport.zapier_z3.status).toBe("failed");
  });

  it("formatHeardBadge formats IST HH:MM accurately and falls back when unverified", () => {
    expect(formatHeardBadge(null)).toBe("Bheja gaya — sunna confirm nahi");
    expect(formatHeardBadge("2026-11-14T19:42:00.000Z", "Asia/Kolkata")).toBe(
      "Maa ne suna ✓ 01:12",
    );
  });
});
