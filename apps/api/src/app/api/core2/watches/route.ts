import { core2Handlers } from "@/lib/core2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => core2Handlers.watchesPost(request);
export const GET = (request: Request) => core2Handlers.watchesListGet(request);

