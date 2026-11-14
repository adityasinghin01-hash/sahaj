import { getShieldApp } from "@/lib/app";
import { createExperienceConsentHandler } from "@/lib/experience_routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExperienceConsentHandler(getShieldApp);
