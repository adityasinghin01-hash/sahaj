import { getShieldApp } from "@/lib/app";
import { createChildFeedbackHandler } from "@/lib/dev_shield_handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createChildFeedbackHandler(getShieldApp);

