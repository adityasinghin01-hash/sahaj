import { z } from "zod";
import { verifyBearerToken, verifyHeaderToken } from "./auth";
import type { ShieldApp } from "./app";

/**
 * Step 3.5 host routes for opt-in experience drills.
 * - Consent: Maa's recorded "haan" is stored by the voice side (Sarvam / check-in caller), which then
 *   posts the recording's storage reference here with the Sarvam tool token. No consent → no drill, ever.
 * - Start (admin, server-only): triggers one drill now (demo + ops). It still refuses without consent,
 *   without Riya's switch, within 7 days of the last one, or in quiet hours.
 */
const Body = z.object({ family_id: z.string().uuid(), parent_id: z.string().uuid() });
const ConsentBody = Body.extend({ clip_ref: z.string().trim().min(1).max(300) });

type DrillRuntime = {
  recordDrillConsent?: (input: { familyId: string; parentId: string; clipRef: string }) => Promise<unknown>;
  startExperienceDrill?: (input: { familyId: string; parentId: string }) => Promise<unknown>;
};

async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T | null> {
  try { const parsed = schema.safeParse(await req.json()); return parsed.success ? parsed.data : null; }
  catch { return null; }
}

export function createExperienceConsentHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyBearerToken(req, app.env.SARVAM_TOOL_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const input = await readBody(req, ConsentBody);
    if (!input) return Response.json({ error: "invalid_request" }, { status: 400 });
    const runtime = app.runtime as unknown as DrillRuntime;
    if (!runtime.recordDrillConsent) return Response.json({ error: "experience_drills_unavailable" }, { status: 501 });
    try {
      return Response.json(await runtime.recordDrillConsent({ familyId: input.family_id, parentId: input.parent_id, clipRef: input.clip_ref }));
    } catch {
      return Response.json({ error: "parent_not_found" }, { status: 404 });
    }
  };
}

export function createExperienceStartHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyHeaderToken(req, "x-dev-admin-token", app.env.DEV_ADMIN_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const input = await readBody(req, Body);
    if (!input) return Response.json({ error: "invalid_request" }, { status: 400 });
    const runtime = app.runtime as unknown as DrillRuntime;
    if (!runtime.startExperienceDrill) return Response.json({ error: "experience_drills_unavailable" }, { status: 501 });
    return Response.json(await runtime.startExperienceDrill({ familyId: input.family_id, parentId: input.parent_id }));
  };
}
