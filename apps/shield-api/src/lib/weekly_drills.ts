import type { WeeklyDrillPlanResult } from "@sahaj/shield";
import type { ShieldApp } from "./app";
import { verifyHeaderToken } from "./auth";

type WeeklyDrillRuntime = {
  planWeeklyDrills?: (input?: { now?: Date }) => Promise<WeeklyDrillPlanResult>;
};

export function createWeeklyDrillsCronHandler(
  getApp: () => Pick<ShieldApp, "env" | "runtime">,
  now: () => Date = () => new Date(),
) {
  return async function GET(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyHeaderToken(req, "x-cron-secret", app.env.CRON_SECRET)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const runtime = app.runtime as unknown as WeeklyDrillRuntime;
    if (!runtime.planWeeklyDrills) {
      return Response.json({ error: "weekly_drills_unavailable" }, { status: 501 });
    }

    const result = await runtime.planWeeklyDrills({ now: now() });
    return Response.json({ ok: true, ...result });
  };
}
