import { getShieldApp } from "@/lib/app";
import { createOutboxHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createOutboxHandler(getShieldApp);

