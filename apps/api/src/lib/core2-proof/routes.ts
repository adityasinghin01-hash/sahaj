import {
  extractAuthContext,
  extractBearer,
  jsonResponse,
  readBoundedJson,
  readOptionalJson,
} from "@/lib/core2/http";
import { verifyMaaDeviceRequest, type ReplayGuard } from "@/app/api/core1/maa/_lib/device-auth";
import type { MaaRepo } from "@/app/api/core1/maa/_lib/repo";
import { createSupabaseMaaRepo } from "@/app/api/core1/maa/_lib/supabase-repo";
import { assertPlainObject, assertValidUuid } from "@/lib/core2/security";
import { Core2ProofError } from "./contracts";
import { proofErrorResponse, type Core2ProofService } from "./service";

async function wrapJson(fn: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  try {
    const result = await fn();
    return jsonResponse(result.body, result.status);
  } catch (err) {
    return proofErrorResponse(err);
  }
}

export interface MaaProofRouteOpts {
  getMaaRepo?: () => MaaRepo;
  pairingSecret?: string;
  replayGuard?: ReplayGuard;
  now?: () => Date;
}

export function createCore2ProofRouteHandlers(
  getService: () => Core2ProofService,
  maaOpts: MaaProofRouteOpts = {},
) {
  const resolveMaaRepo = () => (maaOpts.getMaaRepo ? maaOpts.getMaaRepo() : createSupabaseMaaRepo());

  return {
    async proofGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const subjectPersonId = new URL(request.url).searchParams.get("subject_person_id");
        return svc.getLatestProofChallengeFromBearer(extractAuthContext(request), subjectPersonId);
      });
    },

    async proofPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readOptionalJson(request);
        return svc.createProofChallengeFromBearer(extractAuthContext(request), body);
      });
    },

    async proofDetailGet(request: Request, challengeId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        return svc.getProofChallengeById(extractAuthContext(request), challengeId);
      });
    },

    async proofAnswerPost(request: Request, challengeId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.answerProofChallenge(extractAuthContext(request), challengeId, body);
      });
    },

    async anyPhoneVerifyPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.verifyAnyPhoneTool(extractBearer(request), body);
      });
    },

    async anyPhoneRecordingPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const rawBodyText = await request.text();
          return svc.ingestAnyPhoneRecording({
            provider: "twilio",
            request,
            rawBodyText,
          });
        }
        const jsonBody = await readBoundedJson(request, 8 * 1024 * 1024);
        return svc.ingestAnyPhoneRecording({
          provider: "sarvam",
          bearerToken: extractBearer(request),
          jsonBody,
        });
      });
    },

    async maaProofGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const device = await verifyMaaDeviceRequest(request, new Uint8Array(0), {
          repo: resolveMaaRepo(),
          pairingSecret: maaOpts.pairingSecret,
          replayGuard: maaOpts.replayGuard,
          now: maaOpts.now,
        });
        const svc = getService();
        return svc.getMaaProofStatus({
          familyId: device.familyId,
          parentPersonId: device.personId,
        });
      });
    },

    async maaProofPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const rawText = await request.text();
        const rawBytes = new TextEncoder().encode(rawText);
        const device = await verifyMaaDeviceRequest(request, rawBytes, {
          repo: resolveMaaRepo(),
          pairingSecret: maaOpts.pairingSecret,
          replayGuard: maaOpts.replayGuard,
          now: maaOpts.now,
        });
        let subjectPersonId: string | undefined;
        if (rawText.trim().length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawText);
          } catch {
            throw new Core2ProofError("invalid_request", 400, "Malformed JSON body.");
          }
          const obj = assertPlainObject(parsed, ["subject_person_id"]);
          if (obj.subject_person_id !== undefined) {
            subjectPersonId = assertValidUuid(obj.subject_person_id, "subject_person_id");
          }
        }
        const svc = getService();
        return svc.createProofChallengeForMaaDevice({
          familyId: device.familyId,
          parentPersonId: device.personId,
          subjectPersonId,
        });
      });
    },
  };
}
