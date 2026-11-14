import { z } from "zod";
import { isShieldToolName, type ToolCtx } from "@sahaj/shield";
import { getPortsStatus } from "@/ports";
import type { ShieldApp } from "./app";
import { isAllowedSarvamIp, verifyBearerToken, verifyHeaderToken } from "./auth";

const PairCodeBody = z
  .object({
    family_id: z.string().uuid().optional(),
    familyId: z.string().uuid().optional(),
    user_id: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
  })
  .transform((data) => ({
    familyId: data.family_id ?? data.familyId,
    userId: data.user_id ?? data.userId,
  }))
  .refine((data): data is { familyId: string; userId: string } => Boolean(data.familyId && data.userId));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCtxPair(obj: unknown): { familyId?: string; parentId?: string } {
  if (!isPlainObject(obj)) return {};
  const familyId = typeof obj.family_id === "string" ? obj.family_id : typeof obj.familyId === "string" ? obj.familyId : undefined;
  const parentId = typeof obj.parent_id === "string" ? obj.parent_id : typeof obj.parentId === "string" ? obj.parentId : undefined;
  return { familyId: familyId?.trim() || undefined, parentId: parentId?.trim() || undefined };
}

function extractSarvamCtxAndInput(body: Record<string, unknown>): { ctx: ToolCtx | null; toolInput: Record<string, unknown> } {
  const sources = [body.variables, body.agent_variables, body.context, body];
  let familyId: string | undefined;
  let parentId: string | undefined;
  for (const src of sources) {
    const pair = readCtxPair(src);
    if (!familyId && pair.familyId) familyId = pair.familyId;
    if (!parentId && pair.parentId) parentId = pair.parentId;
  }
  const ctx = familyId && parentId ? { familyId, parentId } : null;

  if (isPlainObject(body.input)) return { ctx, toolInput: body.input };
  if (isPlainObject(body.arguments)) return { ctx, toolInput: body.arguments };

  const rest = { ...body };
  delete rest.family_id;
  delete rest.familyId;
  delete rest.parent_id;
  delete rest.parentId;
  delete rest.variables;
  delete rest.agent_variables;
  delete rest.context;
  return { ctx, toolInput: rest };
}

export function createPairCodeHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyHeaderToken(req, "x-dev-admin-token", app.env.DEV_ADMIN_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const parsed = PairCodeBody.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = await app.runtime.createPairingCode(parsed.data);
    return Response.json(result, { status: result.ok ? 200 : 429 });
  };
}

export function createPairHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    return getApp().runtime.handleShieldPair(req);
  };
}

export function createEventHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    return getApp().runtime.handleShieldEvent(req);
  };
}

export function createSarvamToolHandler(getApp: () => ShieldApp) {
  return async function POST(
    req: Request,
    route: { params: Promise<{ name: string }> },
  ): Promise<Response> {
    const app = getApp();
    if (!verifyBearerToken(req, app.env.SARVAM_TOOL_TOKEN) || !isAllowedSarvamIp(req, app.env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const { name } = await route.params;
    if (!isShieldToolName(name)) {
      return Response.json({ error: "unknown_tool" }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!isPlainObject(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const { ctx, toolInput } = extractSarvamCtxAndInput(body);
    if (!ctx) {
      return Response.json({ error: "missing_context" }, { status: 400 });
    }
    try {
      const output = await app.runtime.shieldTools.run(name, ctx, toolInput);
      return Response.json(output);
    } catch (err) {
      if (err instanceof Error && err.message === "Shield tool parent not found") {
        return Response.json({ error: "parent_not_found" }, { status: 404 });
      }
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createCronJobsHandler(getApp: () => ShieldApp) {
  return async function GET(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyHeaderToken(req, "x-cron-secret", app.env.CRON_SECRET)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const summary = await app.runDueJobs();
    return Response.json({ ok: true, ...summary });
  };
}

export function createHealthHandler(getApp: () => ShieldApp) {
  return async function GET(): Promise<Response> {
    try {
      const app = getApp();
      const dbOk = await app.checkDb();
      return Response.json(
        { ok: dbOk, db: dbOk ? "ok" : "error", ports: app.portsStatus },
        { status: dbOk ? 200 : 503 },
      );
    } catch {
      return Response.json(
        { ok: false, db: "error", ports: getPortsStatus(process.env) },
        { status: 503 },
      );
    }
  };
}

export function createOutboxHandler(getApp: () => ShieldApp) {
  return async function GET(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyHeaderToken(req, "x-dev-admin-token", app.env.DEV_ADMIN_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const rows = await app.listOutbox(50);
    return Response.json({ ok: true, rows });
  };
}
