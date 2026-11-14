import { getShieldApp } from "@/lib/app";
import { createGatewayParentHandler } from "@/lib/phase3_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createGatewayParentHandler(getShieldApp);

