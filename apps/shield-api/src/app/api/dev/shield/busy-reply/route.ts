import { getShieldApp } from "@/lib/app";
import { createBusyReplyHandler } from "@/lib/dev_shield_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createBusyReplyHandler(getShieldApp);

