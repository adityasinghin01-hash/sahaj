import { getShieldApp } from "@/lib/app";
import { createWeeklyDrillsCronHandler } from "@/lib/weekly_drills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createWeeklyDrillsCronHandler(getShieldApp);
