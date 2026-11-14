import { getShieldApp } from "@/lib/app";
import { createHealthHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createHealthHandler(getShieldApp);

