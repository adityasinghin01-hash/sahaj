import { getShieldApp } from "@/lib/app";
import { createEventHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createEventHandler(getShieldApp);

