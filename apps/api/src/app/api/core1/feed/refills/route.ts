import { getRefillsFeed, handleCore1FeedRoute } from '../_lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleCore1FeedRoute(request, (ports, req) => getRefillsFeed(req, ports));
}
