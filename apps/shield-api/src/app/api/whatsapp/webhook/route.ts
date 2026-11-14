import { getShieldApp } from "@/lib/app";
import { createWhatsappWebhookHandlers } from "@/lib/whatsapp_inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = createWhatsappWebhookHandlers(getShieldApp, () => process.env);
export const GET = handlers.GET;
export const POST = handlers.POST;
