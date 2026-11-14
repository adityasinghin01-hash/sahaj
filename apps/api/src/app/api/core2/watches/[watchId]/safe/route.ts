import { core2Handlers } from "@/lib/core2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ watchId: string }> },
) {
  const { watchId } = await context.params;
  return core2Handlers.watchSafePost(request, watchId);
}

