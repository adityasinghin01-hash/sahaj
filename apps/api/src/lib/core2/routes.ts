import {
  errorResponse,
  extractAuthContext,
  extractBearer,
  jsonResponse,
  readBoundedJson,
  readOptionalJson,
} from "./http";
import type { createCore2Service } from "./service";

export type Core2Service = ReturnType<typeof createCore2Service>;

async function wrapJson(fn: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  try {
    const result = await fn();
    return jsonResponse(result.body, result.status);
  } catch (err) {
    return errorResponse(err);
  }
}

export function createCore2RouteHandlers(getService: () => Core2Service) {
  return {
    async sosPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.triggerSos(extractAuthContext(request), body);
      });
    },
    async sosListGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const limit = new URL(request.url).searchParams.get("limit");
        return { status: 200, body: await svc.listSos(extractAuthContext(request), limit) };
      });
    },
    async sosDetailGet(request: Request, sosId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        return { status: 200, body: await svc.getSos(extractAuthContext(request), sosId) };
      });
    },
    async sosCancelPost(request: Request, sosId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.cancelSos(extractAuthContext(request), sosId, body);
      });
    },
    async watchesPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.startWatch(extractAuthContext(request), body);
      });
    },
    async watchesListGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const limit = new URL(request.url).searchParams.get("limit");
        return { status: 200, body: await svc.listWatches(extractAuthContext(request), limit) };
      });
    },
    async watchDetailGet(request: Request, watchId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        return { status: 200, body: await svc.getWatch(extractAuthContext(request), watchId) };
      });
    },
    async watchExtendPost(request: Request, watchId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.extendWatch(extractAuthContext(request), watchId, body);
      });
    },
    async watchCancelPost(request: Request, watchId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.cancelWatch(extractAuthContext(request), watchId, body);
      });
    },
    async watchSafePost(request: Request, watchId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.resolveWatchSafe(extractAuthContext(request), watchId, body);
      });
    },
    async trustedContactsPost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.inviteTrustedContact(extractAuthContext(request), body);
      });
    },
    async trustedContactsGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const params = new URL(request.url).searchParams;
        const includeRevoked = params.get("include_revoked") === "true";
        const limit = params.get("limit");
        return {
          status: 200,
          body: await svc.listTrustedContacts(extractAuthContext(request), includeRevoked, limit),
        };
      });
    },
    async trustedContactPatch(request: Request, contactId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.updateTrustedContact(extractAuthContext(request), contactId, body);
      });
    },
    async trustedContactApprovePost(request: Request, contactId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.approveTrustedContact(extractAuthContext(request), contactId, body);
      });
    },
    async trustedContactRevokePost(request: Request, contactId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.revokeTrustedContact(extractAuthContext(request), contactId, body);
      });
    },
    async reassurancePost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.sendReassurance(extractAuthContext(request), body);
      });
    },
    async reassuranceGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const limit = new URL(request.url).searchParams.get("limit");
        return { status: 200, body: await svc.listReassurance(extractAuthContext(request), limit) };
      });
    },
    async preferencesGet(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        return { status: 200, body: await svc.getSharingPreferences(extractAuthContext(request)) };
      });
    },
    async preferencesPut(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.updateSharingPreferences(extractAuthContext(request), body);
      });
    },
    async cronOverduePost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const rawBody = await readOptionalJson(request);
        const queryLimit = new URL(request.url).searchParams.get("limit");
        const bodyObj =
          typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
            ? (rawBody as Record<string, unknown>)
            : {};
        const limitArg =
          bodyObj.limit !== undefined
            ? bodyObj.limit
            : queryLimit !== null && queryLimit !== "" && /^\d+$/.test(queryLimit)
              ? Number(queryLimit)
              : queryLimit !== null && queryLimit !== ""
                ? queryLimit
                : undefined;
        return svc.runOverdueCron(request.headers.get("x-cron-secret"), limitArg);
      });
    },
    async incidentAcceptPost(request: Request, incidentId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readOptionalJson(request);
        return svc.acceptIncident(extractAuthContext(request), incidentId, body);
      });
    },
    async incidentDeclinePost(request: Request, incidentId: string): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readOptionalJson(request);
        return svc.declineIncident(extractAuthContext(request), incidentId, body);
      });
    },
    async truthLinePost(request: Request): Promise<Response> {
      return wrapJson(async () => {
        const svc = getService();
        const body = await readBoundedJson(request);
        return svc.querySarvamTruthLine(extractBearer(request), body);
      });
    },
  };
}

