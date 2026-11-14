import { handleCloseIncidentPost } from "@/lib/core2-news";

interface RouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { incidentId } = await context.params;
  return handleCloseIncidentPost(request, incidentId);
}
