import { errorJsonResponse, handleMaaUrgentCreate } from '../_lib/service';
import { createSupabaseMaaRepo } from '../_lib/supabase-repo';

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleMaaUrgentCreate(request, { repo: createSupabaseMaaRepo() });
  } catch (err) {
    return errorJsonResponse(err);
  }
}
