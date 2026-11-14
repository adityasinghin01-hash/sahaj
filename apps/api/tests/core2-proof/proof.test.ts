import { describe, expect, it } from "vitest";
import { verifyTimelineChain } from "../../src/lib/timeline";
import { createSaarasSttAdapter, matchSpokenWord } from "../../src/lib/core2-proof/saaras-stt";
import {
  buildSignedMaaRequest,
  createCore2ProofTestHarness,
  SYNTH_IDS,
  TEST_MAA_DEVICE_ID,
} from "./harness";

const PRIYA_IDS = {
  userId: "a8000000-0000-4000-8000-000000000011",
  personId: "c8000000-0000-4000-8000-000000000011",
  token: "tok-priya-proof",
} as const;

function bearerReq(
  url: string,
  method: "GET" | "POST",
  token: string,
  body?: unknown,
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function setupPriyaTrustedContact(h: Awaited<ReturnType<typeof createCore2ProofTestHarness>>) {
  h.core2.addTrustedActor({ ...PRIYA_IDS, displayName: "Priya", role: "circle" });
  h.core2.addPermission({
    id: "92000000-0000-4000-8000-000000000011",
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
}

describe("AGY-X1 I2: Fresh proof of life (word challenge, Saaras STT, freshness stamp, 60s timeout escalation)", () => {
  it("creates a fresh word challenge from Maa's signed device, verifies Riya's clip via Saaras STT, and returns the 40s freshness stamp", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T10:00:00.000Z",
    });

    // 1. Maa taps "Riya theek hai?" on her paired phone
    const createReq = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "POST",
      timestampMs: Date.parse("2026-11-15T10:00:00.000Z"),
    });
    const createRes = await h.handlers.maaProofPost(createReq);
    expect(createRes.status).toBe(201);
    const createdJson = (await createRes.json()) as {
      ok: true;
      challenge: {
        id: string;
        word_token: string;
        prompt_hi: string;
        status: string;
        ttl_seconds: number;
      };
    };
    expect(createdJson.challenge.word_token).toBe("gulab");
    expect(createdJson.challenge.prompt_hi).toBe("Bolo: gulab");
    expect(createdJson.challenge.status).toBe("pending");
    expect(createdJson.challenge.ttl_seconds).toBe(60);
    expect(h.pushMessages.length).toBe(1);
    expect(h.pushMessages[0]?.body).toContain("Bolo: gulab");

    // 2. Riya opens her app and fetches the active challenge
    const getReq = bearerReq("http://localhost/api/core2/proof", "GET", "tok-riya");
    const getRes = await h.handlers.proofGet(getReq);
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { challenge: { id: string; word_token: string } };
    expect(getJson.challenge.id).toBe(createdJson.challenge.id);

    // 3. Riya records "Maa, main theek hoon — गुलाब" (15s after challenge created)
    h.core2.advanceMs(15_000);
    h.setSttTranscript("माँ मैं ठीक हूँ — गुलाब");
    const clip = h.seedUploadedVoiceClip({ durationS: 4 });

    const ansReq = bearerReq(
      `http://localhost/api/core2/proof/${createdJson.challenge.id}/answer`,
      "POST",
      "tok-riya",
      {
        voice_media_id: clip.voiceMediaId,
        media_object_path: clip.objectPath,
        duration_s: 4,
      },
    );
    const ansRes = await h.handlers.proofAnswerPost(ansReq, createdJson.challenge.id);
    expect(ansRes.status).toBe(200);
    const ansJson = (await ansRes.json()) as {
      ok: true;
      verified: boolean;
      challenge: { status: string; stt_matched: boolean; voice_post_id: string };
    };
    expect(ansJson.verified).toBe(true);
    expect(ansJson.challenge.status).toBe("verified");
    expect(ansJson.challenge.stt_matched).toBe(true);
    expect(ansJson.challenge.voice_post_id).toBeTruthy();
    expect(h.voiceNotifications.length).toBe(1);

    // 4. 40 seconds after Riya verified, Maa hears the clip with "Riya ne 40 second pehle ye kaha."
    h.core2.advanceMs(40_000);
    const maaGetReq = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "GET",
      timestampMs: h.core2.getNow().getTime(),
    });
    const maaGetRes = await h.handlers.maaProofGet(maaGetReq);
    expect(maaGetRes.status).toBe(200);
    const maaJson = (await maaGetRes.json()) as {
      proof: {
        status: string;
        freshness_seconds: number;
        freshness_stamp_hi: string;
        media_url: string;
      };
    };
    expect(maaJson.proof.status).toBe("verified");
    expect(maaJson.proof.freshness_seconds).toBe(40);
    expect(maaJson.proof.freshness_stamp_hi).toBe("Riya ne 40 second pehle ye kaha.");
    expect(maaJson.proof.media_url).toContain("https://storage.sahaj.example/");

    // 5. Signed timeline chain is intact
    const chain = h.core2.verifyTimeline();
    expect(chain.valid).toBe(true);
  });

  it("rejects wrong spoken word with word_mismatch and allows retry before 60s expires", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T10:00:00.000Z",
    });

    const createRes = await h.handlers.proofPost(
      bearerReq("http://localhost/api/core2/proof", "POST", "tok-maa", {}),
    );
    const { challenge } = (await createRes.json()) as { challenge: { id: string; word_token: string } };
    expect(challenge.word_token).toBe("gulab");

    // 1st attempt: wrong word in clip
    h.setSttTranscript("Maa main abhi meeting mein hoon");
    const clip1 = h.seedUploadedVoiceClip({ durationS: 3 });
    const res1 = await h.handlers.proofAnswerPost(
      bearerReq(`http://localhost/api/core2/proof/${challenge.id}/answer`, "POST", "tok-riya", {
        voice_media_id: clip1.voiceMediaId,
      }),
      challenge.id,
    );
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as {
      verified: boolean;
      retry_allowed: boolean;
      challenge: { status: string; attempts: number };
    };
    expect(json1.verified).toBe(false);
    expect(json1.retry_allowed).toBe(true);
    expect(json1.challenge.status).toBe("word_mismatch");
    expect(json1.challenge.attempts).toBe(1);

    // 2nd attempt (still within 60s): says "gulab" -> verified!
    h.core2.advanceMs(10_000);
    h.setSttTranscript("Maa main theek hoon gulab");
    const clip2 = h.seedUploadedVoiceClip({ durationS: 4 });
    const res2 = await h.handlers.proofAnswerPost(
      bearerReq(`http://localhost/api/core2/proof/${challenge.id}/answer`, "POST", "tok-riya", {
        voice_media_id: clip2.voiceMediaId,
      }),
      challenge.id,
    );
    const json2 = (await res2.json()) as {
      verified: boolean;
      challenge: { status: string; attempts: number };
    };
    expect(json2.verified).toBe(true);
    expect(json2.challenge.status).toBe("verified");
    expect(json2.challenge.attempts).toBe(2);
  });

  it("escalates to the named local person after 60s (scaled by DEMO_TIMER_SCALE) and tells Maa not to send money", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T10:00:00.000Z",
      env: {
        DEMO_TIMER_SCALE: "6", // 60s / 6 = 10s scaled TTL
        CRON_SECRET: "test-cron-secret",
        SARVAM_TOOL_TOKEN: "test-sarvam-tool-token",
      },
    });
    setupPriyaTrustedContact(h);

    // Invite + approve Priya as rank #1 watch_escalation contact
    const inv = await h.core2.service.inviteTrustedContact(
      { bearerToken: "tok-riya", familyIdHeader: null, idempotencyKeyHeader: "idem-priya-inv" },
      { contact_person_id: PRIYA_IDS.personId, rank: 1, scopes: ["watch_escalation", "sos"] },
    );
    const contactId = (inv.body as { contact: { id: string } }).contact.id;
    await h.core2.service.approveTrustedContact(
      { bearerToken: PRIYA_IDS.token, familyIdHeader: null, idempotencyKeyHeader: "idem-priya-app" },
      contactId,
      { accept: true },
    );

    // Speed dial 2 / Sarvam tool creates proof challenge
    const createRes = await h.handlers.proofPost(
      bearerReq("http://localhost/api/core2/proof", "POST", "test-sarvam-tool-token", {
        family_id: SYNTH_IDS.familyA,
        parent_id: SYNTH_IDS.personMaa,
      }),
    );
    expect(createRes.status).toBe(201);
    const { challenge } = (await createRes.json()) as {
      challenge: { id: string; ttl_seconds: number };
    };
    expect(challenge.ttl_seconds).toBe(10); // 60s scaled by DEMO_TIMER_SCALE=6

    // Advance 11 seconds past scaled TTL with no answer from Riya
    h.core2.advanceMs(11_000);

    const maaGetReq = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "GET",
      timestampMs: h.core2.getNow().getTime(),
    });
    const maaGetRes = await h.handlers.maaProofGet(maaGetReq);
    expect(maaGetRes.status).toBe(200);
    const maaJson = (await maaGetRes.json()) as {
      proof: {
        status: string;
        incident_id: string;
        offered_contact_name: string;
        escalation_message_hi: string;
      };
    };
    expect(maaJson.proof.status).toBe("escalated");
    expect(maaJson.proof.incident_id).toBeTruthy();
    expect(maaJson.proof.offered_contact_name).toBe("Priya");
    expect(maaJson.proof.escalation_message_hi).toBe(
      "Riya se abhi baat nahi hui, Priya unke paas ja rahi hai. Paise bilkul mat bhejiye.",
    );
    expect(h.core2.outboxRows.length).toBe(1);
  });

  it("enforces <= 30s audio limit, Saaras STT adapter contract, and Maa device replay guard", async () => {
    const h = await createCore2ProofTestHarness({
      initialNowIso: "2026-11-15T10:00:00.000Z",
    });

    const createRes = await h.handlers.proofPost(
      bearerReq("http://localhost/api/core2/proof", "POST", "tok-maa", {}),
    );
    const { challenge } = (await createRes.json()) as { challenge: { id: string } };
    const clip = h.seedUploadedVoiceClip({ durationS: 45 });

    // Audio > 30s rejected
    const tooLongRes = await h.handlers.proofAnswerPost(
      bearerReq(`http://localhost/api/core2/proof/${challenge.id}/answer`, "POST", "tok-riya", {
        voice_media_id: clip.voiceMediaId,
        duration_s: 45,
      }),
      challenge.id,
    );
    expect(tooLongRes.status).toBe(400);
    const errJson = (await tooLongRes.json()) as { error: string };
    expect(errJson.error).toBe("audio_too_long");

    // Saaras STT adapter unit check with fake fetchImpl
    let capturedHeader: string | null = null;
    const adapter = createSaarasSttAdapter({
      apiKey: "synth-sarvam-key",
      async fetchImpl(_input, init) {
        const headers = new Headers(init?.headers);
        capturedHeader = headers.get("api-subscription-key");
        return new Response(
          JSON.stringify({ transcript: "Maa, main theek hoon — gulab", language_code: "hi-IN" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const sttOut = await adapter.transcribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      contentType: "audio/mp4",
      durationS: 5,
    });
    expect(capturedHeader).toBe("synth-sarvam-key");
    expect(matchSpokenWord(sttOut.transcript, "gulab", ["गुलाब"])).toBe(true);

    // Maa device replay detection
    const tsMs = h.core2.getNow().getTime();
    const req1 = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "GET",
      deviceId: TEST_MAA_DEVICE_ID,
      timestampMs: tsMs,
    });
    const req2 = await buildSignedMaaRequest({
      url: "http://localhost/api/core2/maa-proof",
      method: "GET",
      deviceId: TEST_MAA_DEVICE_ID,
      timestampMs: tsMs,
    });
    expect((await h.handlers.maaProofGet(req1)).status).toBe(200);
    expect((await h.handlers.maaProofGet(req2)).status).toBe(401);
  });
});
