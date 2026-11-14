import { handleVoiceCommandRoute } from '@/lib/core1/voice-command';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleVoiceCommandRoute(request);
}
