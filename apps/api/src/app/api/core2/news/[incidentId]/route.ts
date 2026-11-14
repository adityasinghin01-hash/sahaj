import { handleGentleNewsGet } from "@/lib/core2-news";

interface RouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { incidentId } = await context.params;
  return handleGentleNewsGet(request, incidentId);
}
