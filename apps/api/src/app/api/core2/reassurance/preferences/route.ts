import { core2Handlers } from "@/lib/core2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => core2Handlers.preferencesGet(request);
export const PUT = (request: Request) => core2Handlers.preferencesPut(request);

