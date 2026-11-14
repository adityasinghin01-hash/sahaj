import { Core2Error } from '../core2/contracts';
import { errorResponse, extractAuthContext, jsonResponse, readBoundedJson } from '../core2/http';
import { safeTokenEquals } from '../secrets';
import type { createDeviceService } from './service';

export function deviceRoutes(getService: () => ReturnType<typeof createDeviceService>) {
  return {
    async GET(request: Request) {
      try {
        if (new URL(request.url).search) throw new Core2Error('invalid_request', 400, 'Query fields are not supported.');
        return jsonResponse(await getService().get(extractAuthContext(request)), 200);
      } catch (error) { return errorResponse(error); }
    },
    async POST(request: Request) {
      try {
        return jsonResponse(await getService().post(extractAuthContext(request), await readBoundedJson(request, 2048)), 200);
      } catch (error) { return errorResponse(error); }
    },
    async tick(request: Request) {
      try {
        if (!process.env.CRON_SECRET) return jsonResponse({ error: 'not_configured' }, 503);
        if (!safeTokenEquals(request.headers.get('x-cron-secret'), process.env.CRON_SECRET))
          return jsonResponse({ error: 'unauthenticated' }, 401);
        if (process.env.MAINTENANCE_KILL === 'true') return jsonResponse({ paused: true }, 503);
        return jsonResponse(await getService().tick(), 200);
      } catch (error) { return errorResponse(error); }
    },
  };
}
