import { getShieldApp } from "@/lib/app";
import { createSarvamWebhookHandler } from "@/lib/sarvam_phase2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createSarvamWebhookHandler(getShieldApp);
