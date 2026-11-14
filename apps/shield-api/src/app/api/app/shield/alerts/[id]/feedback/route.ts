import { createAppHandler } from "@/lib/app_handlers";
import { getAppDependencies } from "@/lib/app_context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createAppHandler("feedback", getAppDependencies);
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return handle(req, (await ctx.params).id);
}
export const OPTIONS = (req: Request) => handle(req);
