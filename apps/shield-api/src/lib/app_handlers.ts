import { z } from "zod";
import * as C from "@sahaj/shared";
import { maskDigits } from "@sahaj/shield";
import type { ShieldApp } from "./app";
import {
  AppHttpError,
  requireAppMember,
  requireChild,
  type AppMember,
} from "./app_auth";
import type { AppStore } from "./app_store";
import {
  decodeAlertCursor,
  encodeAlertCursor,
  verifyTimeline,
} from "./app_store";

export type AppOperation =
  | "summary"
  | "alerts"
  | "alert"
  | "feedback"
  | "pair"
  | "busy"
  | "timeline"
  | "verify"
  | "evidence"
  | "harness"
  | "drills"
  | "push";
export interface AppDependencies {
  app: Pick<
    ShieldApp,
    "env" | "runtime" | "recordChildFeedback" | "recordBusyReply"
  >;
  store: AppStore;
  harness(): Promise<C.AppHarness>;
  pair?(
    member: AppMember,
    key: string,
    create: () => Promise<C.AppPair>,
  ): Promise<C.AppPair>;
}
function respond(schema: z.ZodType, body: unknown) {
  return Response.json(schema.parse(body));
}
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 8192) throw new Error();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new AppHttpError(400, "invalid_request");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppHttpError(400, "invalid_request");
  return parsed.data;
}
function cors(
  req: Request,
  env: AppDependencies["app"]["env"],
  response: Response,
) {
  const origin = req.headers.get("origin");
  const allowed = (env.APP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim());
  if (origin && allowed.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,X-Family-Id,Idempotency-Key",
    );
    response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}
export function createAppHandler(
  operation: AppOperation,
  getDeps: () => AppDependencies,
) {
  return async (req: Request, id?: string): Promise<Response> => {
    let deps: AppDependencies | undefined;
    try {
      deps = getDeps();
      const { app, store } = deps;
      if (req.method === "OPTIONS")
        return cors(req, app.env, new Response(null, { status: 204 }));
      const member = await requireAppMember(
        req,
        app.env.SUPABASE_JWT_SECRET,
        store.memberships,
      );
      const familyId = member.family_id;
      if (
        ["feedback", "pair", "busy", "evidence", "drills", "push"].includes(
          operation,
        )
      )
        requireChild(member);
      if (
        ["alert", "feedback", "evidence"].includes(operation) &&
        !C.AppIdRequest.safeParse({ id }).success
      )
        throw new AppHttpError(400, "invalid_id");
      let result: Response;
      switch (operation) {
        case "summary": {
          const [devices, parents, counts, harness] = await Promise.all([
            store.devices(familyId),
            store.parents(familyId),
            store.counts(familyId),
            deps.harness(),
          ]);
          const month = new Date().toISOString().slice(0, 7);
          const withSense = await Promise.all(
            parents.map(async (parent) => ({
              ...parent,
              scam_sense: await app.runtime.scamSense({
                familyId,
                parentId: parent.id,
                month,
              }),
            })),
          );
          result = respond(C.AppSummaryResponse, {
            family_id: familyId,
            devices,
            parents: withSense,
            ...counts,
            harness,
          });
          break;
        }
        case "alerts": {
          const query = C.AppAlertsRequest.safeParse(
            Object.fromEntries(new URL(req.url).searchParams),
          );
          if (!query.success) throw new AppHttpError(400, "invalid_request");
          const rows = await store.alerts(
            familyId,
            decodeAlertCursor(query.data.since),
          );
          result = respond(C.AppAlertsResponse, {
            alerts: rows,
            next_cursor: rows[0]
              ? encodeAlertCursor(rows[0])
              : (query.data.since ?? null),
          });
          break;
        }
        case "alert": {
          const alert = await store.alert(familyId, id!);
          if (!alert) throw new AppHttpError(404, "alert_not_found");
          const timeline = await store.timeline(familyId, id!);
          const spoken = timeline.find(
            (row) =>
              row.status === "ok" &&
              typeof (row.entry.data as Record<string, unknown> | undefined)
                ?.line_hi === "string",
          );
          const recordedHi = (
            spoken?.entry.data as Record<string, unknown> | undefined
          )?.line_hi;
          // A persisted verdict is not proof that a warning was heard. Never invent a speech transcript.
          const told_hi =
            typeof recordedHi === "string"
              ? maskDigits(recordedHi)
              : "Maa ko diye gaye sandesh ke exact shabd record mein nahi hain. Neeche delivery ka signed record dekhein.";
          const told_en =
            typeof recordedHi === "string"
              ? "Recorded Hindi warning; see the signed delivery status below."
              : "Exact warning wording was not recorded. See the signed action record for delivery status.";
          result = respond(C.AppAlertDetailResponse, {
            ...alert,
            told_en,
            told_hi,
            timeline,
          });
          break;
        }
        case "feedback": {
          const input = await body(req, C.AppFeedbackRequest);
          const feedback = await app.recordChildFeedback({
            family_id: familyId,
            verdict_id: id!,
            feedback: input.answer,
          });
          if (!feedback.ok)
            throw new AppHttpError(feedback.status, feedback.error);
          result = respond(C.AppFeedbackResponse, feedback);
          break;
        }
        case "pair": {
          await body(req, C.AppEmptyRequest);
          const key = req.headers.get("idempotency-key");
          if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
            throw new AppHttpError(400, "idempotency_key_required");
          const create = async () => {
            const pair = await app.runtime.createPairingCode({
              familyId,
              userId: member.user_id,
            });
            if (!pair.ok) throw new AppHttpError(429, pair.reason);
            return C.AppPairResponse.parse({ ...pair, family_id: familyId });
          };
          result = respond(
            C.AppPairResponse,
            deps.pair ? await deps.pair(member, key, create) : await create(),
          );
          break;
        }
        case "busy": {
          const input = await body(req, C.AppBusyReplyRequest);
          const reply = await app.recordBusyReply({
            ...input,
            family_id: familyId,
          });
          if (!reply.ok) throw new AppHttpError(reply.status, reply.error);
          result = respond(C.AppBusyReplyResponse, reply);
          break;
        }
        case "timeline":
          result = respond(C.AppTimelineResponse, {
            rows: await store.timeline(familyId),
          });
          break;
        case "verify":
          result = respond(
            C.AppVerifyResponse,
            verifyTimeline(await store.chain(), familyId),
          );
          break;
        case "evidence": {
          const alert = await store.alert(familyId, id!);
          if (!alert) throw new AppHttpError(404, "incident_not_found");
          if (alert.level !== "red")
            throw new AppHttpError(400, "red_incident_required");
          const pack = await app.runtime.buildEvidencePack({
            familyId,
            verdictId: id!,
            viewerUserId: member.user_id,
          });
          // Kiro B's optional verifier is capability-detected; current runtime only returns masked evidence.
          const runtime = app.runtime as typeof app.runtime & {
            verifyEvidencePack?: (input: {
              familyId: string;
              packId: string;
            }) => Promise<unknown>;
          };
          let verification: C.AppVerification | null = null;
          const packId = (pack as unknown as { pack_id?: string }).pack_id;
          if (runtime.verifyEvidencePack && packId) {
            const raw = await runtime.verifyEvidencePack({ familyId, packId });
            const parsed = C.AppVerifyResponse.safeParse(raw);
            if (parsed.success) verification = parsed.data;
          }
          result = respond(C.AppEvidenceResponse, { ...pack, verification });
          break;
        }
        case "harness":
          result = respond(C.AppHarnessResponse, await deps.harness());
          break;
        case "drills": {
          const input = await body(req, C.AppDrillsRequest);
          if (
            !(await store.parents(familyId)).some(
              (p) => p.id === input.parent_id,
            )
          )
            throw new AppHttpError(403, "parent_forbidden");
          const runtime = app.runtime as typeof app.runtime & {
            setExperienceDrills?: (input: {
              familyId: string;
              parentId: string;
              enabled: boolean;
              byUserId: string;
            }) => Promise<unknown>;
          };
          if (!runtime.setExperienceDrills)
            throw new AppHttpError(
              501,
              "experience_drills_unavailable",
              "Experience drills are not installed on this server. Maa’s recorded consent is also required.",
            );
          await runtime.setExperienceDrills({
            familyId,
            parentId: input.parent_id,
            enabled: input.enabled,
            byUserId: member.user_id,
          });
          result = respond(C.AppDrillsResponse, { ok: true, ...input });
          break;
        }
        case "push": {
          const input = await body(req, C.AppPushTokenRequest);
          await store.pushToken(member, input.expo_token);
          result = respond(C.AppPushTokenResponse, { ok: true });
          break;
        }
      }
      return cors(req, app.env, result);
    } catch (error) {
      const known = error instanceof AppHttpError;
      const response = Response.json(
        {
          error: known ? error.code : "server_error",
          ...(known && error.message !== error.code
            ? { message: error.message }
            : {}),
        },
        { status: known ? error.status : 500 },
      );
      return cors(req, deps?.app.env ?? {}, response);
    }
  };
}
