import { randomInt, randomUUID } from "node:crypto";
import { MaaRouteError } from "@/app/api/core1/maa/_lib/types";
import {
  Core2Error,
  type Core2Actor,
  type Core2Person,
} from "@/lib/core2/contracts";
import {
  assertPlainObject,
  assertSafeString,
  assertValidUuid,
  assertSarvamToolToken,
  authenticateCore2Actor,
  scaleDurationMs,
} from "@/lib/core2/security";
import { notifyVoicePost } from "@/lib/core1/voice-notify";
import { verifyShieldCodeWord, rotateShieldCodeWordAfterUse, sha256Hex } from "./code-word";
import {
  ANY_PHONE_DENIED_POWERS,
  ANY_PHONE_GRANTED_POWERS,
  ANY_PHONE_LOCK_MS,
  ANY_PHONE_MAX_ATTEMPTS,
  Core2ProofError,
  MAX_STT_AUDIO_SECONDS,
  PROOF_DEFAULT_TTL_MS,
  PROOF_WORD_BANK,
  type Core2ProofDeps,
  type ProofChallengeRow,
  type PublicAnyPhoneSessionDto,
  type PublicProofChallengeDto,
} from "./contracts";
import {
  formatAnyPhoneMaaLines,
  formatProofTimeoutEscalationLines,
  openAndOfferLocalCircleIncident,
} from "./escalation";
import { matchSpokenWord } from "./saaras-stt";

export function formatFreshnessStamp(
  verifiedAtIso: string | null,
  now: Date,
): { seconds: number | null; hi: string | null; en: string | null } {
  if (!verifiedAtIso) return { seconds: null, hi: null, en: null };
  const verifiedMs = Date.parse(verifiedAtIso);
  if (!Number.isFinite(verifiedMs)) return { seconds: null, hi: null, en: null };
  const diffSeconds = Math.max(0, Math.round((now.getTime() - verifiedMs) / 1000));
  if (diffSeconds < 60) {
    return {
      seconds: diffSeconds,
      hi: `Riya ne ${diffSeconds} second pehle ye kaha.`,
      en: `Riya said this ${diffSeconds} seconds ago.`,
    };
  }
  const mins = Math.max(1, Math.round(diffSeconds / 60));
  return {
    seconds: diffSeconds,
    hi: `Riya ne ${mins} minute pehle ye kaha.`,
    en: `Riya said this ${mins} minutes ago.`,
  };
}

export function createCore2ProofService(deps: Core2ProofDeps) {
  const env = deps.env ?? process.env;
  const getNow = () => (deps.now ? deps.now() : new Date());
  const nextUuid = () => (deps.uuid ? deps.uuid() : randomUUID());
  const pickIndex = (max: number) => (deps.randomIndex ? deps.randomIndex(max) : randomInt(max));

  async function requireActor(auth: {
    bearerToken: string | null;
    familyIdHeader?: string | null;
  }): Promise<Core2Actor> {
    return authenticateCore2Actor(deps.auth, deps.core2Repo, auth.bearerToken, auth.familyIdHeader);
  }

  async function resolveSubjectChild(
    familyId: string,
    requestedSubjectId?: string,
  ): Promise<Core2Person> {
    if (requestedSubjectId) {
      const person = await deps.core2Repo.getPerson(familyId, requestedSubjectId);
      if (!person) {
        throw new Core2ProofError("not_found", 404, "Subject person not found in family.");
      }
      return person;
    }
    const children = await deps.core2Repo.listPeopleByRole(familyId, "child");
    if (children.length === 0) {
      throw new Core2ProofError("not_found", 404, "No child member found in family.");
    }
    return children[0]!;
  }

  async function resolveParentInFamily(familyId: string): Promise<Core2Person | null> {
    const parents = await deps.core2Repo.listPeopleByRole(familyId, "parent");
    return parents[0] ?? null;
  }

  async function escalateChallengeOnTimeout(challenge: ProofChallengeRow): Promise<ProofChallengeRow> {
    if (challenge.status === "verified" || challenge.status === "escalated") {
      return challenge;
    }
    const now = getNow();
    const nowIso = now.toISOString();

    const escalation = await openAndOfferLocalCircleIncident(
      {
        core2Repo: deps.core2Repo,
        gate: deps.gate,
        dispatch: deps.dispatch,
        timeline: deps.timeline,
        crypto: deps.crypto,
        now: getNow,
        uuid: nextUuid,
        env,
      },
      {
        familyId: challenge.familyId,
        subjectPersonId: challenge.subjectPersonId,
        requestKind: "proof_of_life_timeout",
        severity: "urgent",
        humanLine: "Fresh proof of life timed out; local trusted contact notified.",
        dedupePrefix: `core2:proof:timeout:${challenge.id}`,
        metadata: {
          challenge_id: challenge.id,
          word_token: challenge.wordToken,
        },
      },
    );

    const updated = await deps.proofRepo.markProofChallengeEscalated({
      familyId: challenge.familyId,
      challengeId: challenge.id,
      escalatedAt: nowIso,
      incidentId: escalation.incidentId,
      requestId: escalation.requestId,
      offeredContactPersonId: escalation.offer.contactPersonId,
      offeredContactName: escalation.offeredContactName,
    });

    const lines = formatProofTimeoutEscalationLines(escalation.offeredContactName);
    await deps.timeline.append({
      familyId: challenge.familyId,
      eventId: nextUuid(),
      dedupeKey: `core2:proof:escalated:${challenge.id}`,
      eventType: "core2.proof.escalated",
      entityId: challenge.id,
      humanLine: lines.en,
      occurredAt: nowIso,
      payload: {
        challenge_id: challenge.id,
        incident_id: escalation.incidentId,
        offered_contact_person_id: escalation.offer.contactPersonId,
        offered_contact_name: escalation.offeredContactName,
      },
    });

    return updated;
  }

  async function refreshChallengeState(challenge: ProofChallengeRow): Promise<ProofChallengeRow> {
    if (
      (challenge.status === "pending" || challenge.status === "word_mismatch") &&
      getNow().getTime() >= Date.parse(challenge.expiresAt)
    ) {
      return escalateChallengeOnTimeout(challenge);
    }
    return challenge;
  }

  async function toPublicChallenge(
    challenge: ProofChallengeRow,
    viewer?: { userId: string; personId: string; role: "parent" | "child" | "circle" },
  ): Promise<PublicProofChallengeDto> {
    const now = getNow();
    const freshness =
      challenge.status === "verified"
        ? formatFreshnessStamp(challenge.verifiedAt, now)
        : { seconds: null, hi: null, en: null };
    const escLines =
      challenge.status === "escalated" || challenge.status === "expired"
        ? formatProofTimeoutEscalationLines(challenge.offeredContactName)
        : null;

    let mediaUrl: string | null = null;
    let mediaExpiresIn: number | null = null;
    if (
      viewer &&
      challenge.status === "verified" &&
      challenge.voiceObjectPath
    ) {
      const signed = await deps.storage.createSignedVoiceUrl({
        familyId: challenge.familyId,
        actorUserId: viewer.userId,
        actorPersonId: viewer.personId,
        actorRole: viewer.role,
        voicePostId: challenge.voicePostId,
        objectPath: challenge.voiceObjectPath,
        expiresInSeconds: 60,
      });
      if (signed) {
        mediaUrl = signed.url;
        mediaExpiresIn = signed.expiresInSeconds;
      }
    }

    return {
      id: challenge.id,
      family_id: challenge.familyId,
      requester_person_id: challenge.requesterPersonId,
      subject_person_id: challenge.subjectPersonId,
      word_token: challenge.wordToken,
      prompt_hi: `Bolo: ${challenge.wordToken}`,
      prompt_en: `Say: ${challenge.wordToken}`,
      status: challenge.status,
      ttl_seconds: challenge.ttlSeconds,
      expires_at: challenge.expiresAt,
      answered_at: challenge.answeredAt,
      verified_at: challenge.verifiedAt,
      escalated_at: challenge.escalatedAt,
      voice_media_id: challenge.voiceMediaId,
      voice_post_id: challenge.voicePostId,
      stt_matched: challenge.sttMatched,
      incident_id: challenge.incidentId,
      offered_contact_name: challenge.offeredContactName,
      freshness_seconds: freshness.seconds,
      freshness_stamp_hi: freshness.hi,
      freshness_stamp_en: freshness.en,
      escalation_message_hi: escLines?.hi ?? null,
      escalation_message_en: escLines?.en ?? null,
      media_url: mediaUrl,
      media_expires_in: mediaExpiresIn,
      attempts: challenge.attempts,
      created_at: challenge.createdAt,
    };
  }

  async function createProofChallengeInternal(input: {
    familyId: string;
    requesterPersonId: string;
    subjectPersonId?: string;
    viewer?: { userId: string; personId: string; role: "parent" | "child" | "circle" };
  }): Promise<{ status: 201; body: { ok: true; challenge: PublicProofChallengeDto } }> {
    const subject = await resolveSubjectChild(input.familyId, input.subjectPersonId);
    const wordEntry = PROOF_WORD_BANK[pickIndex(PROOF_WORD_BANK.length)] ?? PROOF_WORD_BANK[0]!;
    const now = getNow();
    const ttlMs = scaleDurationMs(PROOF_DEFAULT_TTL_MS, env);
    const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const created = await deps.proofRepo.createProofChallenge({
      familyId: input.familyId,
      requesterPersonId: input.requesterPersonId,
      subjectPersonId: subject.id,
      wordToken: wordEntry.word,
      wordAliases: wordEntry.aliases,
      ttlSeconds,
      expiresAt,
    });

    await deps.timeline.append({
      familyId: input.familyId,
      eventId: nextUuid(),
      dedupeKey: `core2:proof:requested:${created.id}`,
      eventType: "core2.proof.requested",
      entityId: created.id,
      humanLine: "Requested fresh proof-of-life voice check.",
      occurredAt: now.toISOString(),
      payload: {
        challenge_id: created.id,
        requester_person_id: input.requesterPersonId,
        subject_person_id: subject.id,
        ttl_seconds: ttlSeconds,
      },
    });

    if (deps.sendPush) {
      const tokens = await deps.proofRepo.listPushTokensForPerson(input.familyId, subject.id);
      if (tokens.length > 0) {
        await deps.sendPush(
          tokens.map((to) => ({
            to,
            title: "Sahaj",
            body: `Maa pooch rahi hain — Bolo: ${wordEntry.word}`,
            sound: "default",
            data: { route: "/proof", challenge_id: created.id },
          })),
        );
      }
    }

    return {
      status: 201,
      body: {
        ok: true,
        challenge: await toPublicChallenge(created, input.viewer),
      },
    };
  }

  return {
    // ------------------------------------------------------------------
    // I2: Fresh proof of life
    // ------------------------------------------------------------------
    async createProofChallengeFromBearer(
      auth: { bearerToken: string | null; familyIdHeader?: string | null },
      rawBody: unknown,
    ) {
      const body = assertPlainObject(rawBody ?? {}, ["family_id", "parent_id", "subject_person_id"]);

      // Also permit Sarvam keypad speed-dial 2 tool calls with SARVAM_TOOL_TOKEN
      if (typeof body.family_id === "string" && typeof body.parent_id === "string") {
        assertSarvamToolToken(auth.bearerToken, env);
        const familyId = assertValidUuid(body.family_id, "family_id");
        const parentId = assertValidUuid(body.parent_id, "parent_id");
        const subjectPersonId =
          body.subject_person_id !== undefined
            ? assertValidUuid(body.subject_person_id, "subject_person_id")
            : undefined;
        const parent = await deps.core2Repo.getPerson(familyId, parentId);
        if (!parent || parent.role !== "parent") {
          throw new Core2ProofError("forbidden", 403, "Only a parent in the family may request proof of life.");
        }
        return createProofChallengeInternal({
          familyId,
          requesterPersonId: parentId,
          subjectPersonId,
        });
      }

      const actor = await requireActor(auth);
      if (actor.role !== "parent" && actor.role !== "child") {
        throw new Core2ProofError("forbidden", 403, "Only parent or child may create proof challenge.");
      }
      const subjectPersonId =
        body.subject_person_id !== undefined
          ? assertValidUuid(body.subject_person_id, "subject_person_id")
          : undefined;
      return createProofChallengeInternal({
        familyId: actor.familyId,
        requesterPersonId: actor.personId,
        subjectPersonId,
        viewer: { userId: actor.userId, personId: actor.personId, role: actor.role },
      });
    },

    async createProofChallengeForMaaDevice(input: {
      familyId: string;
      parentPersonId: string;
      subjectPersonId?: string;
    }) {
      return createProofChallengeInternal({
        familyId: input.familyId,
        requesterPersonId: input.parentPersonId,
        subjectPersonId: input.subjectPersonId,
        viewer: {
          userId: input.parentPersonId,
          personId: input.parentPersonId,
          role: "parent",
        },
      });
    },

    async getLatestProofChallengeFromBearer(
      auth: { bearerToken: string | null; familyIdHeader?: string | null },
      subjectPersonIdParam?: string | null,
    ) {
      const actor = await requireActor(auth);
      const subjectPersonId = subjectPersonIdParam
        ? assertValidUuid(subjectPersonIdParam, "subject_person_id")
        : actor.role === "child"
          ? actor.personId
          : undefined;
      const latest = await deps.proofRepo.getLatestProofChallenge(actor.familyId, subjectPersonId);
      if (!latest) {
        return { status: 200 as const, body: { ok: true as const, challenge: null } };
      }
      const refreshed = await refreshChallengeState(latest);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          challenge: await toPublicChallenge(refreshed, {
            userId: actor.userId,
            personId: actor.personId,
            role: actor.role,
          }),
        },
      };
    },

    async getProofChallengeById(
      auth: { bearerToken: string | null; familyIdHeader?: string | null },
      challengeIdRaw: string,
    ) {
      const actor = await requireActor(auth);
      const challengeId = assertValidUuid(challengeIdRaw, "id");
      const found = await deps.proofRepo.getProofChallenge(actor.familyId, challengeId);
      if (!found) {
        throw new Core2ProofError("not_found", 404, "Proof challenge not found.");
      }
      const refreshed = await refreshChallengeState(found);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          challenge: await toPublicChallenge(refreshed, {
            userId: actor.userId,
            personId: actor.personId,
            role: actor.role,
          }),
        },
      };
    },

    async answerProofChallenge(
      auth: { bearerToken: string | null; familyIdHeader?: string | null },
      challengeIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const challengeId = assertValidUuid(challengeIdRaw, "id");
      const body = assertPlainObject(rawBody, [
        "voice_media_id",
        "voice_post_id",
        "media_object_path",
        "duration_s",
      ]);

      const found = await deps.proofRepo.getProofChallenge(actor.familyId, challengeId);
      if (!found) {
        throw new Core2ProofError("not_found", 404, "Proof challenge not found.");
      }
      if (actor.role !== "child" || actor.personId !== found.subjectPersonId) {
        throw new Core2ProofError("forbidden", 403, "Only the challenged child may answer this proof check.");
      }

      if (found.status === "verified") {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            verified: true,
            retry_allowed: false,
            challenge: await toPublicChallenge(found, {
              userId: actor.userId,
              personId: actor.personId,
              role: actor.role,
            }),
          },
        };
      }

      const refreshed = await refreshChallengeState(found);
      if (refreshed.status === "escalated" || refreshed.status === "expired") {
        throw new Core2ProofError("challenge_expired", 409, "Proof challenge expired and escalated.");
      }

      const voiceMediaId =
        body.voice_media_id !== undefined
          ? assertValidUuid(body.voice_media_id, "voice_media_id")
          : null;
      const voicePostId =
        body.voice_post_id !== undefined
          ? assertValidUuid(body.voice_post_id, "voice_post_id")
          : null;
      const mediaObjectPath =
        body.media_object_path !== undefined
          ? assertSafeString(body.media_object_path, "media_object_path", 4, 300)
          : null;

      if (!voiceMediaId && !voicePostId && !mediaObjectPath) {
        throw new Core2ProofError(
          "invalid_request",
          400,
          "Provide voice_media_id, voice_post_id, or media_object_path.",
        );
      }

      const durationOverride =
        body.duration_s !== undefined ? Number(body.duration_s) : null;
      if (
        durationOverride !== null &&
        (!Number.isFinite(durationOverride) || durationOverride <= 0 || durationOverride > MAX_STT_AUDIO_SECONDS)
      ) {
        throw new Core2ProofError(
          "audio_too_long",
          400,
          `Proof voice clip must be ${MAX_STT_AUDIO_SECONDS} seconds or shorter.`,
        );
      }

      const media = await deps.storage.readVoiceMediaForAnswer({
        familyId: actor.familyId,
        subjectPersonId: actor.personId,
        voiceMediaId,
        voicePostId,
        mediaObjectPath,
      });
      if (!media) {
        throw new Core2ProofError("not_found", 404, "Recorded proof voice media not found.");
      }
      if (media.senderId !== actor.personId) {
        throw new Core2ProofError("forbidden", 403, "Voice media does not belong to the challenged child.");
      }

      const effectiveDuration = durationOverride ?? media.durationS;
      if (
        effectiveDuration !== null &&
        (!Number.isFinite(effectiveDuration) || effectiveDuration > MAX_STT_AUDIO_SECONDS)
      ) {
        throw new Core2ProofError(
          "audio_too_long",
          400,
          `Proof voice clip must be ${MAX_STT_AUDIO_SECONDS} seconds or shorter.`,
        );
      }

      const sttResult = await deps.stt.transcribe({
        audio: media.bytes,
        contentType: media.contentType,
        durationS: effectiveDuration,
        languageCode: "hi-IN",
      });

      const matched = matchSpokenWord(sttResult.transcript, refreshed.wordToken, refreshed.wordAliases);
      const nowIso = getNow().toISOString();

      let linkedVoicePostId = media.voicePostId ?? voicePostId;
      if (matched && !linkedVoicePostId) {
        const consent = await deps.proofRepo.recordVoiceShareConsent({
          familyId: actor.familyId,
          personId: actor.personId,
          recipientId: refreshed.requesterPersonId,
          version: "core2-proof-v1",
        });
        const createdPost = await deps.proofRepo.createVoicePostWithMedia({
          familyId: actor.familyId,
          senderId: actor.personId,
          recipientId: refreshed.requesterPersonId,
          objectPath: media.objectPath,
          consentId: consent.consentId,
        });
        linkedVoicePostId = createdPost.voicePostId;
      }

      const updated = await deps.proofRepo.updateProofChallengeAnswer({
        familyId: actor.familyId,
        challengeId: refreshed.id,
        status: matched ? "verified" : "word_mismatch",
        answeredAt: nowIso,
        verifiedAt: matched ? nowIso : null,
        voiceMediaId: media.voiceMediaId ?? voiceMediaId,
        voicePostId: linkedVoicePostId,
        voiceObjectPath: media.objectPath,
        sttTranscript: sttResult.transcript,
        sttMatched: matched,
        attempts: refreshed.attempts + 1,
      });

      await deps.timeline.append({
        familyId: actor.familyId,
        eventId: nextUuid(),
        dedupeKey: matched
          ? `core2:proof:verified:${updated.id}`
          : `core2:proof:mismatch:${updated.id}:${updated.attempts}`,
        eventType: matched ? "core2.proof.verified" : "core2.proof.word_mismatch",
        entityId: updated.id,
        humanLine: matched
          ? "Fresh proof-of-life word verified by speech check."
          : "Spoken proof word did not match; retry allowed.",
        occurredAt: nowIso,
        payload: {
          challenge_id: updated.id,
          matched,
          attempts: updated.attempts,
          voice_post_id: linkedVoicePostId,
        },
      });

      if (matched && linkedVoicePostId && deps.voiceNotifyDeps) {
        const notifier = deps.notifyOnVoicePost ?? notifyVoicePost;
        await notifier(deps.voiceNotifyDeps, {
          familyId: actor.familyId,
          voicePostId: linkedVoicePostId,
          senderId: actor.personId,
          recipientId: refreshed.requesterPersonId,
        });
      }

      return {
        status: 200 as const,
        body: {
          ok: true as const,
          verified: matched,
          retry_allowed: !matched && Date.parse(updated.expiresAt) > getNow().getTime(),
          challenge: await toPublicChallenge(updated, {
            userId: actor.userId,
            personId: actor.personId,
            role: actor.role,
          }),
        },
      };
    },

    async sweepDueProofChallenges(limit = 25): Promise<{ swept: number; escalated: number }> {
      const nowIso = getNow().toISOString();
      const due = await deps.proofRepo.claimDueProofChallenges(nowIso, limit);
      let escalated = 0;
      for (const challenge of due) {
        await escalateChallengeOnTimeout(challenge);
        escalated += 1;
      }
      return { swept: due.length, escalated };
    },

    // ------------------------------------------------------------------
    // Maa paired device dashboard (proof + latest any-phone live alert)
    // ------------------------------------------------------------------
    async getMaaProofStatus(input: {
      familyId: string;
      parentPersonId: string;
    }) {
      const [latestProof, latestAnyPhone] = await Promise.all([
        deps.proofRepo.getLatestProofChallenge(input.familyId),
        deps.proofRepo.getLatestAnyPhoneSession(input.familyId),
      ]);

      const refreshedProof = latestProof ? await refreshChallengeState(latestProof) : null;
      const viewer = {
        userId: input.parentPersonId,
        personId: input.parentPersonId,
        role: "parent" as const,
      };

      let anyPhoneDto: PublicAnyPhoneSessionDto | null = null;
      if (latestAnyPhone) {
        let mediaUrl: string | null = null;
        let mediaExpiresIn: number | null = null;
        if (latestAnyPhone.voiceObjectPath) {
          const signed = await deps.storage.createSignedVoiceUrl({
            familyId: latestAnyPhone.familyId,
            actorUserId: viewer.userId,
            actorPersonId: viewer.personId,
            actorRole: viewer.role,
            voicePostId: latestAnyPhone.voicePostId,
            objectPath: latestAnyPhone.voiceObjectPath,
            expiresInSeconds: 60,
          });
          if (signed) {
            mediaUrl = signed.url;
            mediaExpiresIn = signed.expiresInSeconds;
          }
        }
        anyPhoneDto = {
          id: latestAnyPhone.id,
          family_id: latestAnyPhone.familyId,
          subject_person_id: latestAnyPhone.subjectPersonId,
          incident_id: latestAnyPhone.incidentId,
          offered_contact_name: null,
          granted_powers: latestAnyPhone.grantedPowers,
          denied_powers: latestAnyPhone.deniedPowers,
          code_word_rotated: latestAnyPhone.codeWordRotated,
          voice_post_id: latestAnyPhone.voicePostId,
          media_url: mediaUrl,
          media_expires_in: mediaExpiresIn,
          status_message_hi: latestAnyPhone.statusMessageHi,
          status_message_en: latestAnyPhone.statusMessageEn,
          created_at: latestAnyPhone.createdAt,
        };
      }

      return {
        status: 200 as const,
        body: {
          ok: true as const,
          family_id: input.familyId,
          parent_person_id: input.parentPersonId,
          proof: refreshedProof ? await toPublicChallenge(refreshedProof, viewer) : null,
          any_phone: anyPhoneDto,
        },
      };
    },

    // ------------------------------------------------------------------
    // G10 / I3: Any-phone line (code word = identity, limited powers)
    // ------------------------------------------------------------------
    async verifyAnyPhoneTool(bearerToken: string | null, rawBody: unknown) {
      assertSarvamToolToken(bearerToken, env);
      const body = assertPlainObject(rawBody, [
        "family_id",
        "said_name",
        "said_code_word",
        "call_ref",
        "status_kind",
        "caller_phone",
        "user_phone_number",
      ]);
      // Caller phone number is NEVER stored, logged, returned, or spoken.
      const familyId = assertValidUuid(body.family_id, "family_id");
      const saidName = assertSafeString(body.said_name, "said_name", 1, 100);
      const saidCodeWord = assertSafeString(body.said_code_word, "said_code_word", 1, 200);
      const callRefRaw =
        body.call_ref !== undefined
          ? assertSafeString(body.call_ref, "call_ref", 1, 128)
          : null;
      const statusKind: "safe" | "help" =
        body.status_kind === "safe" ? "safe" : "help";

      const now = getNow();
      const nowIso = now.toISOString();
      const lockSeconds = Math.max(
        1,
        Math.round(scaleDurationMs(ANY_PHONE_LOCK_MS, env) / 1000),
      );

      const parent = await resolveParentInFamily(familyId);
      const parentId = parent?.id ?? familyId;

      const candidate = await deps.proofRepo.findPersonByNameOrAlias(familyId, saidName, "child");
      const shieldCheck = candidate
        ? await verifyShieldCodeWord({
            familyId,
            parentId,
            saidCodeWord,
            proofRepo: deps.proofRepo,
            timeline: deps.timeline,
            uuid: nextUuid,
            now: getNow,
          })
        : { ok: false };

      const passed = Boolean(candidate && shieldCheck.ok);

      const guard = await deps.proofRepo.recordAnyPhoneAttempt({
        familyId,
        ok: passed,
        maxAttempts: ANY_PHONE_MAX_ATTEMPTS,
        lockSeconds,
        nowIso,
      });

      if (guard.locked) {
        await deps.timeline.append({
          familyId,
          eventId: nextUuid(),
          dedupeKey: `core2:any_phone:locked:${familyId}:${nowIso}`,
          eventType: "core2.any_phone.locked",
          entityId: candidate?.id ?? null,
          humanLine: "Any-phone verification locked for 15 minutes after 3 wrong code words.",
          occurredAt: nowIso,
          payload: {
            failed_attempts: guard.failedAttempts,
            locked_until: guard.lockedUntil,
          },
        });
        return {
          status: 200 as const,
          body: {
            ok: false as const,
            verified: false,
            locked: true,
            locked_until: guard.lockedUntil,
            failed_attempts: guard.failedAttempts,
            remaining_attempts: 0,
            spoken_text:
              "Code word teen baar galat bataya gaya hai. Suraksha ke liye 15 minute baad koshish karein.",
            spoken_text_en:
              "Code word failed 3 times. Locked for 15 minutes for family safety.",
          },
        };
      }

      if (!passed || !candidate) {
        await deps.timeline.append({
          familyId,
          eventId: nextUuid(),
          dedupeKey: `core2:any_phone:failed:${familyId}:${guard.failedAttempts}:${nowIso}`,
          eventType: "core2.any_phone.verify_failed",
          entityId: candidate?.id ?? null,
          humanLine: "Any-phone caller verification failed (wrong name or code word).",
          occurredAt: nowIso,
          payload: {
            failed_attempts: guard.failedAttempts,
            remaining_attempts: guard.remainingAttempts,
          },
        });
        return {
          status: 200 as const,
          body: {
            ok: false as const,
            verified: false,
            locked: false,
            locked_until: null,
            failed_attempts: guard.failedAttempts,
            remaining_attempts: guard.remainingAttempts,
            spoken_text: `Naam ya family code word galat hai. ${guard.remainingAttempts} mauke bache hain.`,
            spoken_text_en: `Name or family code word did not match. ${guard.remainingAttempts} tries left.`,
          },
        };
      }

      // 1. Rotate family code word immediately after single successful use.
      await rotateShieldCodeWordAfterUse({
        familyId,
        usedWord: saidCodeWord,
        proofRepo: deps.proofRepo,
        randomIndex: deps.randomIndex,
      });

      // 2. Open Core 2 incident ("Riya called from another phone") & offer local circle.
      const maaLines = formatAnyPhoneMaaLines(candidate.displayName, statusKind);
      const escalation = await openAndOfferLocalCircleIncident(
        {
          core2Repo: deps.core2Repo,
          gate: deps.gate,
          dispatch: deps.dispatch,
          timeline: deps.timeline,
          crypto: deps.crypto,
          now: getNow,
          uuid: nextUuid,
          env,
        },
        {
          familyId,
          subjectPersonId: candidate.id,
          requestKind: "any_phone_checkin",
          severity: "urgent",
          humanLine: `${candidate.displayName} called from another phone`,
          dedupePrefix: `core2:any_phone:${candidate.id}:${nowIso}`,
          metadata: {
            caller_channel: "any_phone",
            status_kind: statusKind,
          },
        },
      );

      const callRefHash = callRefRaw ? await sha256Hex(callRefRaw) : null;
      const session = await deps.proofRepo.createAnyPhoneSession({
        familyId,
        subjectPersonId: candidate.id,
        incidentId: escalation.incidentId,
        requestId: escalation.requestId,
        callRefHash,
        grantedPowers: ANY_PHONE_GRANTED_POWERS,
        deniedPowers: ANY_PHONE_DENIED_POWERS,
        codeWordRotated: true,
        statusMessageHi: maaLines.hi,
        statusMessageEn: maaLines.en,
      });

      await deps.timeline.append({
        familyId,
        eventId: nextUuid(),
        dedupeKey: `core2:any_phone:verified:${session.id}`,
        eventType: "core2.any_phone.verified",
        entityId: session.id,
        humanLine: `${candidate.displayName} verified on any-phone line; code word rotated and limited powers granted.`,
        occurredAt: nowIso,
        payload: {
          session_id: session.id,
          incident_id: escalation.incidentId,
          subject_person_id: candidate.id,
          offered_contact_person_id: escalation.offer.contactPersonId,
          offered_contact_name: escalation.offeredContactName,
          code_word_rotated: true,
          granted_powers: ANY_PHONE_GRANTED_POWERS,
          denied_powers: ANY_PHONE_DENIED_POWERS,
        },
      });

      return {
        status: 200 as const,
        body: {
          ok: true as const,
          verified: true,
          locked: false,
          session_id: session.id,
          family_id: familyId,
          subject_person_id: candidate.id,
          subject_display_name: candidate.displayName,
          incident_id: escalation.incidentId,
          offered_contact_person_id: escalation.offer.contactPersonId,
          offered_contact_name: escalation.offeredContactName,
          code_word_rotated: true,
          granted_powers: [...ANY_PHONE_GRANTED_POWERS],
          denied_powers: [...ANY_PHONE_DENIED_POWERS],
          status_message_hi: maaLines.hi,
          status_message_en: maaLines.en,
          spoken_text: escalation.offeredContactName
            ? `Pehchan ho gayi, ${candidate.displayName}. ${escalation.offeredContactName} ko bheja ja raha hai aur Maa ko aapki awaz bheji jayegi. Suraksha ke liye family code word badal diya gaya hai.`
            : `Pehchan ho gayi, ${candidate.displayName}. Maa aur parivar ko khabar bheji ja rahi hai. Suraksha ke liye family code word badal diya gaya hai.`,
          spoken_text_en:
            "Verified with limited emergency powers. Your local circle and Maa are being notified, and the family code word has been rotated.",
        },
      };
    },

    /**
     * Post-call live voice recording relay for G10 any-phone calls:
     * Fetches the real Twilio or Sarvam recording, stores privately in `sahaj-voice`,
     * creates a consented `voice_posts` row, and notifies Maa via Core 1 `notifyVoicePost`.
     */
    async ingestAnyPhoneRecording(input: {
      provider: "twilio" | "sarvam";
      bearerToken?: string | null;
      request?: Request;
      rawBodyText?: string;
      jsonBody?: unknown;
    }) {
      let familyId: string;
      let sessionId: string;
      let audioBytes: Uint8Array;
      let contentType: "audio/wav" = "audio/wav";
      let dedupeRef: string;

      if (input.provider === "twilio") {
        if (!input.request || input.rawBodyText === undefined || !deps.verifyTwilioSignature) {
          throw new Core2ProofError("unavailable", 503, "Twilio webhook verification not configured.");
        }
        if (!deps.verifyTwilioSignature(input.request, input.rawBodyText)) {
          throw new Core2ProofError("unauthenticated", 401, "Invalid Twilio signature.");
        }
        const url = new URL(input.request.url);
        const params = new URLSearchParams(input.rawBodyText);
        familyId = assertValidUuid(url.searchParams.get("familyId"), "familyId");
        sessionId = assertValidUuid(url.searchParams.get("sessionId"), "sessionId");
        const recordingStatus = params.get("RecordingStatus");
        if (recordingStatus && recordingStatus !== "completed") {
          return { status: 200 as const, body: { ok: true as const, ignored: recordingStatus } };
        }
        const recordingSid = assertSafeString(params.get("RecordingSid"), "RecordingSid", 10, 64);
        if (!deps.fetchTwilioRecordingAudio) {
          throw new Core2ProofError("unavailable", 503, "Twilio recording fetch not configured.");
        }
        const rec = await deps.fetchTwilioRecordingAudio({ recordingSid });
        audioBytes = rec.audio;
        contentType = rec.contentType;
        dedupeRef = recordingSid;
      } else {
        assertSarvamToolToken(input.bearerToken ?? null, env);
        const body = assertPlainObject(input.jsonBody, [
          "family_id",
          "session_id",
          "app_id",
          "interaction_id",
          "audio_base64",
        ]);
        familyId = assertValidUuid(body.family_id, "family_id");
        sessionId = assertValidUuid(body.session_id, "session_id");
        if (typeof body.audio_base64 === "string" && body.audio_base64.length > 0) {
          audioBytes = new Uint8Array(Buffer.from(body.audio_base64, "base64"));
          dedupeRef = `inline:${sessionId}`;
        } else {
          const appId = assertSafeString(body.app_id, "app_id", 1, 128);
          const interactionId = assertSafeString(body.interaction_id, "interaction_id", 4, 160);
          if (!deps.fetchSarvamRecordingAudio) {
            throw new Core2ProofError("unavailable", 503, "Sarvam recording fetch not configured.");
          }
          const rec = await deps.fetchSarvamRecordingAudio({ appId, interactionId });
          audioBytes = rec.audio;
          contentType = rec.contentType;
          dedupeRef = interactionId;
        }
      }

      const session = await deps.proofRepo.getAnyPhoneSession(familyId, sessionId);
      if (!session) {
        throw new Core2ProofError("not_found", 404, "Any-phone session not found.");
      }

      const parent = await resolveParentInFamily(familyId);
      if (!parent) {
        throw new Core2ProofError("not_found", 404, "Parent recipient not found in family.");
      }

      const consent = await deps.proofRepo.recordVoiceShareConsent({
        familyId,
        personId: session.subjectPersonId,
        recipientId: parent.id,
        version: "any-phone-live-v1",
      });

      const objectPath = `${familyId}/voice/${nextUuid()}.wav`;
      await deps.storage.uploadVoiceBytes(objectPath, audioBytes, contentType);

      const createdPost = await deps.proofRepo.createVoicePostWithMedia({
        familyId,
        senderId: session.subjectPersonId,
        recipientId: parent.id,
        objectPath,
        consentId: consent.consentId,
      });

      const updatedSession = await deps.proofRepo.attachVoiceToAnyPhoneSession({
        familyId,
        sessionId,
        voicePostId: createdPost.voicePostId,
        voiceObjectPath: objectPath,
      });

      const nowIso = getNow().toISOString();
      await deps.timeline.append({
        familyId,
        eventId: nextUuid(),
        dedupeKey: `core2:any_phone:voice:${sessionId}:${dedupeRef}`,
        eventType: "core2.any_phone.voice_relayed",
        entityId: createdPost.voicePostId,
        humanLine: updatedSession.statusMessageEn,
        occurredAt: nowIso,
        payload: {
          session_id: sessionId,
          voice_post_id: createdPost.voicePostId,
          incident_id: updatedSession.incidentId,
        },
      });

      if (deps.voiceNotifyDeps) {
        const notifier = deps.notifyOnVoicePost ?? notifyVoicePost;
        await notifier(deps.voiceNotifyDeps, {
          familyId,
          voicePostId: createdPost.voicePostId,
          senderId: session.subjectPersonId,
          recipientId: parent.id,
        });
      }

      return {
        status: 200 as const,
        body: {
          ok: true as const,
          session_id: updatedSession.id,
          voice_post_id: createdPost.voicePostId,
          incident_id: updatedSession.incidentId,
          status_message_hi: updatedSession.statusMessageHi,
          status_message_en: updatedSession.statusMessageEn,
        },
      };
    },
  };
}

export type Core2ProofService = ReturnType<typeof createCore2ProofService>;

export function proofErrorResponse(err: unknown): Response {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (err instanceof Core2ProofError || err instanceof Core2Error || err instanceof MaaRouteError) {
    const authHeaders =
      err.status === 401 ? { ...headers, "www-authenticate": "Bearer" } : headers;
    return new Response(
      JSON.stringify({ error: err.code, message: err.message }),
      { status: err.status, headers: authHeaders },
    );
  }
  return new Response(
    JSON.stringify({ error: "unavailable", message: "Core 2 proof service unavailable." }),
    { status: 503, headers },
  );
}
