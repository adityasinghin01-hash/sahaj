import { errorJsonResponse, handleMaaVoiceList } from '../_lib/service';
import { createSupabaseMaaRepo } from '../_lib/supabase-repo';

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleMaaVoiceList(request, { repo: createSupabaseMaaRepo() });
  } catch (err) {
    return errorJsonResponse(err);
  }
}
