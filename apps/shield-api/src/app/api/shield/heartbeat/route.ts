import { getShieldApp } from "@/lib/app";
import { createHeartbeatHandler } from "@/lib/phase3_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createHeartbeatHandler(getShieldApp);

