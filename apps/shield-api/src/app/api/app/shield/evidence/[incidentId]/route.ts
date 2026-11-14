import { createAppHandler } from "@/lib/app_handlers";
import { getAppDependencies } from "@/lib/app_context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createAppHandler("evidence", getAppDependencies);
export async function GET(
  req: Request,
  ctx: { params: Promise<{ incidentId: string }> },
) {
  return handle(req, (await ctx.params).incidentId);
}
export const OPTIONS = (req: Request) => handle(req);
