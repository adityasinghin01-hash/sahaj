import { getShieldApp } from "@/lib/app";
import { createPairHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createPairHandler(getShieldApp);

