import { getShieldApp } from "@/lib/app";
import { createExperienceStartHandler } from "@/lib/experience_routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExperienceStartHandler(getShieldApp);
