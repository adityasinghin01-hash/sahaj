import { getShieldApp } from "@/lib/app";
import { createCronJobsHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCronJobsHandler(getShieldApp);

