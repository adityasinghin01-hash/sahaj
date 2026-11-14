import { getShieldApp } from "@/lib/app";
import { createSarvamStartHandler } from "@/lib/sarvam_start";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createSarvamStartHandler(getShieldApp);
