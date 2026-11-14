import { createMediaHandler } from "@/lib/media/handler";
import { defaultMediaDeps } from "@/lib/media/supabase";

export const dynamic = "force-dynamic";
const handle = createMediaHandler("voicePost", defaultMediaDeps);

export async function GET(request: Request, context: { params: Promise<{ postId: string }> }) {
  return handle(request, (await context.params).postId);
}
