import { getShieldApp } from "@/lib/app";
import { createPairCodeHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createPairCodeHandler(getShieldApp);

