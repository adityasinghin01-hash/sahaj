import { handleCore1ApiRoute } from '@/lib/core1';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleCore1ApiRoute(request, undefined, 'voice_message');
}
