import { errorJsonResponse, handleMaaUrgentStatus } from '../../_lib/service';
import { createSupabaseMaaRepo } from '../../_lib/supabase-repo';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await handleMaaUrgentStatus(request, id, { repo: createSupabaseMaaRepo() });
  } catch (err) {
    return errorJsonResponse(err);
  }
}
