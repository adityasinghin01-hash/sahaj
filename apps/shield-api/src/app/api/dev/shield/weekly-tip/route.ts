import { getShieldApp } from "@/lib/app";
import { createWeeklyTipGetHandler, createWeeklyTipPostHandler } from "@/lib/dev_shield_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createWeeklyTipGetHandler(getShieldApp);
export const POST = createWeeklyTipPostHandler(getShieldApp);

