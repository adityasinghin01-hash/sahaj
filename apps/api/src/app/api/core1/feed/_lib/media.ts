import { createDefaultAuthPort } from '@/lib/core1';
import type { MediaDeps } from '@/lib/media/contracts';
import { createMediaHandler } from '@/lib/media/handler';
import { defaultMediaDeps } from '@/lib/media/supabase';

function makeFeedMediaDeps(): MediaDeps {
  const base = defaultMediaDeps();
  const core1Auth = createDefaultAuthPort();
  return {
    ...base,
    auth: {
      async verifyBearer(token: string) {
        try {
          const user = await core1Auth.getUser(token);
          return user?.id ? { userId: user.id } : null;
        } catch {
          return null;
        }
      },
    },
  };
}

export async function handleVoiceFeedMediaGet(
  request: Request,
  id: string,
  depsOverride?: MediaDeps
): Promise<Response> {
  const handler = createMediaHandler(
    'voicePost',
    depsOverride ? () => depsOverride : makeFeedMediaDeps
  );
  return handler(request, id);
}
