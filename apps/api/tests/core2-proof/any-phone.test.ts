import { describe, expect, it } from "vitest";
import { verifyTimelineChain } from "../../src/lib/timeline";
import {
  buildSignedMaaRequest,
  createCore2ProofTestHarness,
  SYNTH_IDS,
  TEST_INITIAL_CODE_WORD,
} from "./harness";

const PRIYA_IDS = {
  userId: "a8000000-0000-4000-8000-000000000021",
  personId: "c8000000-0000-4000-8000-000000000021",
  token: "tok-priya-anyphone",
} as const;

function anyPhoneVerifyReq(token: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/core2/any-phone/verify", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function setupPriyaEscalation(h: Awaited<ReturnType<typeof createCore2ProofTestHarness>>) {
  h.core2.addTrustedActor({ ...PRIYA_IDS, displayName: "Priya", role: "circle" });
  h.core2.addPermission({
    id: "93000000-0000-4000-8000-000000000011",
    familyId: SYNTH_IDS.familyA,
    actorId: SYNTH_IDS.personRiya,
    action: "urgent_responder",
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    maxAmountMinor: 0,
    vendorIds: [],
    itemIds: [],
    targetIds: [PRIYA_IDS.personId],
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2099-01-01T00:00:00.000Z",
    maxUses: 100,
    usedCount: 0,
    approvalMode: "setup",
  });
  const inv = await h.core2.service.inviteTrustedContact(
    { bearerToken: "tok-riya", familyIdHeader: null, idempotencyKeyHeader: "idem-any-inv" },
    { contact_person_id: PRIYA_IDS.personId, rank: 1, scopes: ["watch_escalation", "sos"] },
  );
  const contactId = (inv.body as { contact: { id: string } }).contact.id;
  await h.core2.service.approveTrustedContact(
    { bearerToken: PRIYA_IDS.token, familyIdHeader: null, idempotencyKeyHeader: "idem-any-app" },
    contactId,
    { accept: true },
  );
}

describe("AGY-X1 G10 / I3: Any-phone line (Shield code word = identity, 3-strike 15m lock, rotation, limited powers, live voice relay)", () => {
  it("verifies Riya via Shield check_code_word, rotates the code word, grants limited powers, offers local circle, and never leaks caller number", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T11:00:00.000Z",
      initialCodeWord: TEST_INITIAL_CODE_WORD,
    });
    await setupPriyaEscalation(h);

    const initialHash = h.codeWordHashes.get(SYNTH_IDS.familyA);
    expect(initialHash).toBeTruthy();

    // Missing/wrong SARVAM_TOOL_TOKEN fails closed with 401
    const unauthRes = await h.handlers.anyPhoneVerifyPost(
      anyPhoneVerifyReq("wrong-token", {
        family_id: SYNTH_IDS.familyA,
        said_name: "Riya",
        said_code_word: TEST_INITIAL_CODE_WORD,
      }),
    );
    expect(unauthRes.status).toBe(401);

    // Valid call from borrowed phone (+919876500001 passed by provider is stripped & never stored/spoken)
    const verifyRes = await h.handlers.anyPhoneVerifyPost(
      anyPhoneVerifyReq("test-sarvam-tool-token", {
        family_id: SYNTH_IDS.familyA,
        said_name: "Riya",
        said_code_word: "  KESAR ",
        call_ref: "call-sid-synthetic-001",
        status_kind: "help",
        caller_phone: "+919876500001",
      }),
    );
    expect(verifyRes.status).toBe(200);
    const verifyRawText = await verifyRes.text();
    expect(verifyRawText).not.toContain("9876500001");

    const verifyJson = JSON.parse(verifyRawText) as {
      ok: true;
      verified: boolean;
      session_id: string;
      incident_id: string;
      offered_contact_name: string;
      code_word_rotated: boolean;
      granted_powers: string[];
      denied_powers: string[];
      status_message_hi: string;
    };
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.verified).toBe(true);
    expect(verifyJson.offered_contact_name).toBe("Priya");
    expect(verifyJson.code_word_rotated).toBe(true);
    expect(verifyJson.granted_powers).toEqual([
      "reassure_parent",
      "request_local_circle_help",
    ]);
    expect(verifyJson.denied_powers).toEqual([
      "change_settings",
      "view_location",
      "approve_money",
    ]);
    expect(verifyJson.status_message_hi).toBe(
      "Riya ne kisi aur ke phone se call kiya — madad bheji ja rahi hai",
    );

    // Code word rotated in Shield store -> replaying old code word "kesar" now FAILS!
    const rotatedHash = h.codeWordHashes.get(SYNTH_IDS.familyA);
    expect(rotatedHash).not.toBe(initialHash);

    const replayOldWordRes = await h.handlers.anyPhoneVerifyPost(
      anyPhoneVerifyReq("test-sarvam-tool-token", {
        family_id: SYNTH_IDS.familyA,
        said_name: "Riya",
        said_code_word: TEST_INITIAL_CODE_WORD,
      }),
    );
    const replayOldWordJson = (await replayOldWordRes.json()) as { verified: boolean };
    expect(replayOldWordJson.verified).toBe(false);

    // Post-call recording via Twilio webhook relays Riya's live voice to Maa
    const recForm = new URLSearchParams({
      RecordingSid: "RE0123456789abcdef0123456789abcdef",
      RecordingStatus: "completed",
    }).toString();
    const recReq = new Request(
      `http://localhost/api/core2/any-phone/recording?familyId=${SYNTH_IDS.familyA}&sessionId=${verifyJson.session_id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "valid-twilio-sig",
        },
        body: recForm,
      },
    );
    const recRes = await h.handlers.anyPhoneRecordingPost(recReq);
    expect(recRes.status).toBe(200);
    const recJson = (await recRes.json()) as { ok: true; voice_post_id: string };
    expect(recJson.voice_post_id).toBeTruthy();
    expect(h.voiceNotifications.length).toBe(1);

    // Maa sees the any-phone alert + live voice URL on her dashboard
    const maaGetReq = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "GET",
      timestampMs: h.core2.getNow().getTime(),
    });
    const maaGetRes = await h.handlers.maaProofGet(maaGetReq);
    const maaJson = (await maaGetRes.json()) as {
      any_phone: {
        id: string;
        status_message_hi: string;
        media_url: string;
        denied_powers: string[];
      };
    };
    expect(maaJson.any_phone.id).toBe(verifyJson.session_id);
    expect(maaJson.any_phone.status_message_hi).toBe(
      "Riya ne kisi aur ke phone se call kiya — madad bheji ja rahi hai",
    );
    expect(maaJson.any_phone.media_url).toContain("https://storage.sahaj.example/");
    expect(maaJson.any_phone.denied_powers).toContain("approve_money");

    const chain = h.core2.verifyTimeline();
    expect(chain.valid).toBe(true);
  });

  it("locks any-phone verification for 15 minutes after 3 wrong tries and unlocks after 15 minutes", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T12:00:00.000Z",
      initialCodeWord: "amrud",
    });

    // Wrong try #1 (2 remaining)
    const r1 = await (
      await h.handlers.anyPhoneVerifyPost(
        anyPhoneVerifyReq("test-sarvam-tool-token", {
          family_id: SYNTH_IDS.familyA,
          said_name: "Riya",
          said_code_word: "galat-1",
        }),
      )
    ).json();
    expect(r1.verified).toBe(false);
    expect(r1.locked).toBe(false);
    expect(r1.remaining_attempts).toBe(2);

    // Wrong try #2 (1 remaining)
    const r2 = await (
      await h.handlers.anyPhoneVerifyPost(
        anyPhoneVerifyReq("test-sarvam-tool-token", {
          family_id: SYNTH_IDS.familyA,
          said_name: "Riya",
          said_code_word: "galat-2",
        }),
      )
    ).json();
    expect(r2.verified).toBe(false);
    expect(r2.locked).toBe(false);
    expect(r2.remaining_attempts).toBe(1);

    // Wrong try #3 -> LOCKED for 15 minutes!
    const r3 = await (
      await h.handlers.anyPhoneVerifyPost(
        anyPhoneVerifyReq("test-sarvam-tool-token", {
          family_id: SYNTH_IDS.familyA,
          said_name: "Riya",
          said_code_word: "galat-3",
        }),
      )
    ).json();
    expect(r3.verified).toBe(false);
    expect(r3.locked).toBe(true);
    expect(r3.remaining_attempts).toBe(0);
    expect(r3.locked_until).toBe("2026-11-15T12:15:00.000Z");

    // 4th try 5 minutes later with the RIGHT code word "amrud" is still rejected while locked!
    h.core2.advanceMs(5 * 60_000);
    const r4 = await (
      await h.handlers.anyPhoneVerifyPost(
        anyPhoneVerifyReq("test-sarvam-tool-token", {
          family_id: SYNTH_IDS.familyA,
          said_name: "Riya",
          said_code_word: "amrud",
        }),
      )
    ).json();
    expect(r4.verified).toBe(false);
    expect(r4.locked).toBe(true);

    // Advance past 15-minute lock window -> right code word "amrud" now succeeds!
    h.core2.advanceMs(11 * 60_000);
    const r5 = await (
      await h.handlers.anyPhoneVerifyPost(
        anyPhoneVerifyReq("test-sarvam-tool-token", {
          family_id: SYNTH_IDS.familyA,
          said_name: "Riya",
          said_code_word: "amrud",
          status_kind: "safe",
        }),
      )
    ).json();
    expect(r5.verified).toBe(true);
    expect(r5.locked).toBe(false);
    expect(r5.status_message_hi).toBe(
      "Riya ne kisi aur ke phone se call kiya — wo theek hai",
    );
  });
});
