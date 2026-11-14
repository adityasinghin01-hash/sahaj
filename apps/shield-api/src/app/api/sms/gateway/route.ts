import { getShieldApp } from "@/lib/app";
import { createSmsGatewayHandler } from "@/lib/phase3_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createSmsGatewayHandler(getShieldApp);

