import { createAppHandler } from "@/lib/app_handlers";
import { getAppDependencies } from "@/lib/app_context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createAppHandler("push", getAppDependencies);
export const POST = (req: Request) => handle(req);
export const OPTIONS = (req: Request) => handle(req);
