import type { z } from "zod";
import type { ShieldApp } from "./app";
import { verifyHeaderToken } from "./auth";
import {
  BusyReplyInputSchema,
  CallStatusInputSchema,
  ChildFeedbackInputSchema,
  WeeklyTipInputSchema,
} from "./phase2";

function requireDevAdmin(req: Request, app: ShieldApp): Response | null {
  if (!verifyHeaderToken(req, "x-dev-admin-token", app.env.DEV_ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function parseJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: Response.json({ error: "invalid_request" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: Response.json({ error: "invalid_request" }, { status: 400 }) };
  }
  return { data: parsed.data };
}

function toJsonResponse<T extends { ok: true } | { ok: false; status: 403 | 404 | 409 }>(res: T): Response {
  if (!res.ok) {
    return Response.json(res, { status: res.status });
  }
  return Response.json(res, { status: 200 });
}

export function createCallStatusHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    const denied = requireDevAdmin(req, app);
    if (denied) return denied;

    const parsed = await parseJsonBody(req, CallStatusInputSchema);
    if ("error" in parsed) return parsed.error;

    try {
      const res = await app.recordBusyCallStatus(parsed.data);
      return toJsonResponse(res);
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createBusyReplyHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    const denied = requireDevAdmin(req, app);
    if (denied) return denied;

    const parsed = await parseJsonBody(req, BusyReplyInputSchema);
    if ("error" in parsed) return parsed.error;

    try {
      const res = await app.recordBusyReply(parsed.data);
      return toJsonResponse(res);
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createChildFeedbackHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    const denied = requireDevAdmin(req, app);
    if (denied) return denied;

    const parsed = await parseJsonBody(req, ChildFeedbackInputSchema);
    if ("error" in parsed) return parsed.error;

    try {
      const res = await app.recordChildFeedback(parsed.data);
      return toJsonResponse(res);
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createWeeklyTipGetHandler(getApp: () => ShieldApp) {
  return async function GET(req: Request): Promise<Response> {
    const app = getApp();
    const denied = requireDevAdmin(req, app);
    if (denied) return denied;

    const url = new URL(req.url);
    const parsed = WeeklyTipInputSchema.safeParse({
      family_id: url.searchParams.get("family_id") ?? undefined,
      now: url.searchParams.get("now") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const res = await app.getWeeklyTip(parsed.data);
      return toJsonResponse(res);
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createWeeklyTipPostHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    const denied = requireDevAdmin(req, app);
    if (denied) return denied;

    const parsed = await parseJsonBody(req, WeeklyTipInputSchema);
    if ("error" in parsed) return parsed.error;

    try {
      const res = await app.getWeeklyTip(parsed.data);
      return toJsonResponse(res);
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

