import type {
  Core2CryptoPort,
  Core2DispatchPort,
  Core2GatePort,
  Core2Repository,
  Core2TimelinePort,
  OfferNextContactResult,
} from "@/lib/core2/contracts";
import { scaleDurationMs } from "@/lib/core2/security";

const DEFAULT_OFFER_EXPIRY_MS = 2 * 60_000;

export function formatProofTimeoutEscalationLines(contactName: string | null): {
  hi: string;
  en: string;
} {
  if (contactName && contactName.trim().length > 0) {
    const clean = contactName.trim();
    return {
      hi: `Riya se abhi baat nahi hui, ${clean} unke paas ja rahi hai. Paise bilkul mat bhejiye.`,
      en: `Could not reach Riya right now; ${clean} is going to check on her. Please do not send any money.`,
    };
  }
  return {
    hi: "Riya se abhi baat nahi hui, parivar ke madadgar unke paas ja rahe hain. Paise bilkul mat bhejiye.",
    en: "Could not reach Riya right now; your local trusted circle is being notified. Please do not send any money.",
  };
}

export function formatAnyPhoneMaaLines(
  subjectName: string,
  statusKind: "safe" | "help",
): { hi: string; en: string } {
  const cleanName = subjectName.trim() || "Riya";
  if (statusKind === "safe") {
    return {
      hi: `${cleanName} ne kisi aur ke phone se call kiya — wo theek hai`,
      en: `${cleanName} called from another phone — she is okay`,
    };
  }
  return {
    hi: `${cleanName} ne kisi aur ke phone se call kiya — madad bheji ja rahi hai`,
    en: `${cleanName} called from another phone — help is being sent`,
  };
}

export interface EscalateIncidentInput {
  familyId: string;
  subjectPersonId: string;
  requestKind: "proof_of_life_timeout" | "any_phone_checkin";
  severity: "urgent" | "critical";
  humanLine: string;
  dedupePrefix: string;
  metadata: Record<string, unknown>;
}

export interface EscalateIncidentOutcome {
  requestId: string;
  incidentId: string;
  offer: OfferNextContactResult;
  offeredContactName: string | null;
  dispatched: boolean;
}

/**
 * Reuses Core 2's incident creation, sequential trusted-contact offer, gate authorization,
 * outbox dispatch, and signed timeline chain for I2 timeout and G10 any-phone escalations.
 */
export async function openAndOfferLocalCircleIncident(
  deps: {
    core2Repo: Core2Repository;
    gate: Core2GatePort;
    dispatch: Core2DispatchPort;
    timeline: Core2TimelinePort;
    crypto: Core2CryptoPort;
    now: () => Date;
    uuid: () => string;
    env: Record<string, string | undefined>;
  },
  input: EscalateIncidentInput,
): Promise<EscalateIncidentOutcome> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const offerExpiresAt = new Date(
    now.getTime() + scaleDurationMs(DEFAULT_OFFER_EXPIRY_MS, deps.env),
  ).toISOString();

  const { requestId, incidentId } = await deps.core2Repo.createRequestAndIncident({
    familyId: input.familyId,
    personId: input.subjectPersonId,
    requestKind: input.requestKind,
    severity: input.severity,
    incidentState: "offered",
  });

  const offer = await deps.core2Repo.offerNextTrustedContact({
    familyId: input.familyId,
    incidentId,
    scope: "watch_escalation",
    offerExpiresAt,
    nowIso,
  });

  let offeredContactName: string | null = null;
  let dispatched = false;

  if (offer.contactPersonId && offer.assignmentId) {
    const contactPerson = await deps.core2Repo.getPerson(input.familyId, offer.contactPersonId);
    offeredContactName = contactPerson?.displayName ?? null;

    await deps.timeline.append({
      familyId: input.familyId,
      eventId: deps.uuid(),
      dedupeKey: `${input.dedupePrefix}:offered:${offer.assignmentId}`,
      eventType: "core2.incident.offered",
      entityId: incidentId,
      humanLine: input.humanLine,
      occurredAt: nowIso,
      payload: {
        incident_id: incidentId,
        assignment_id: offer.assignmentId,
        trusted_contact_id: offer.trustedContactId,
        contact_person_id: offer.contactPersonId,
        rank: offer.rank,
        expires_at: offer.expiresAt,
        ...input.metadata,
      },
    });

    const gateInput = await deps.core2Repo.loadGateInput({
      familyId: input.familyId,
      actorPersonId: input.subjectPersonId,
      requestId,
      action: "urgent_responder",
      targetId: offer.contactPersonId,
      now: nowIso,
    });
    const gateDecision = await deps.gate.evaluate(gateInput);

    if (gateDecision.decision === "allow") {
      const payloadCiphertext = deps.crypto.encryptSecretNote(
        `core2:outbox:${input.familyId}:${requestId}`,
        {
          kind: "core2.watch_escalation",
          channel: "call",
          fallback_channel: "push",
          incident_id: incidentId,
          assignment_id: offer.assignmentId,
          contact_person_id: offer.contactPersonId,
          rank: offer.rank,
          offer_expires_at: offer.expiresAt,
          ...input.metadata,
        },
      );
      await deps.dispatch.enqueueAuthorized({
        familyId: input.familyId,
        actionRequestId: requestId,
        kind: "core2.watch_escalation",
        dedupeKey: `${input.dedupePrefix}:offer:${offer.assignmentId}`,
        payloadCiphertext,
        trustedContactId: offer.trustedContactId,
      });
      dispatched = true;
    }
  } else {
    await deps.timeline.append({
      familyId: input.familyId,
      eventId: deps.uuid(),
      dedupeKey: `${input.dedupePrefix}:exhausted:${incidentId}`,
      eventType: "core2.incident.exhausted",
      entityId: incidentId,
      humanLine: input.humanLine,
      occurredAt: nowIso,
      payload: {
        incident_id: incidentId,
        ...input.metadata,
      },
    });
  }

  return {
    requestId,
    incidentId,
    offer,
    offeredContactName,
    dispatched,
  };
}
