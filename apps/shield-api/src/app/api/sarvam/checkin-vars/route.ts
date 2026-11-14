import { getShieldApp } from "@/lib/app";
import { createCheckinVarsHandler } from "@/lib/sarvam_phase2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCheckinVarsHandler(getShieldApp);
