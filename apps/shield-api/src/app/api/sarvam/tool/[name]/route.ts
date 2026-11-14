import { getShieldApp } from "@/lib/app";
import { createSarvamToolHandler } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createSarvamToolHandler(getShieldApp);

