import { handleVoiceFeedMediaGet } from '../../../_lib/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return handleVoiceFeedMediaGet(request, (await context.params).id);
}
