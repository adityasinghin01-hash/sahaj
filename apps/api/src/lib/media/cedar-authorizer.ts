import { evaluateMediaRead } from "@sahaj/gate";
import type { MediaAuthorizer } from "./contracts";

/**
 * Cedar-backed media decision using the fixed MEDIA_READ_POLICY. The service has already proven membership,
 * party status, live consent history and object expiry from database rows; Cedar then re-evaluates those facts
 * as the policy authority. `allow` is the only success. Missing facts, errors or any other outcome deny.
 *
 * Revocation after a URL is signed: the service re-runs this decision right before signing, but a URL already
 * issued stays valid for at most `signedUrlSeconds` (<= 60). That is the documented bounded revocation window.
 */
export const cedarMediaAuthorizer: MediaAuthorizer = async (context) => {
  try {
    const c = context.consent;
    return evaluateMediaRead({
      action: context.action, familyId: context.familyId,
      reader: { personId: context.actor.personId, role: context.actor.role, active: true },
      subject: { id: context.subject.id, senderId: context.subject.senderId, recipientId: context.subject.recipientId, personId: context.subject.personId },
      consent: { personId: c.personId, purpose: c.purpose, callId: c.callId, grantedAt: c.grantedAt },
      objectExpiresAt: context.object.expiresAt, now: context.now,
    });
  } catch { return "deny"; }
};
