import type { ShieldApp } from "./app";
import { verifyHeaderToken } from "./auth";
import { GatewayParentBodySchema } from "./gateway_admin";

export function createSmsGatewayHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    return getApp().runtime.handleSmsGateway(req);
  };
}

export function createGatewayParentHandler(getApp: () => ShieldApp) {
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
    const parsed = GatewayParentBodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const res = await app.registerGatewayParent(parsed.data);
      if (!res.ok) {
        return Response.json(res, { status: res.status });
      }
      return Response.json(res, { status: 200 });
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  };
}

export function createHeartbeatHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request): Promise<Response> {
    return getApp().recordDeviceHeartbeat(req);
  };
}

