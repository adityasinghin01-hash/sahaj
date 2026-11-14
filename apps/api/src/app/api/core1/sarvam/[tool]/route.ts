import { createSarvamHandler } from '@/lib/core1/sarvam-tools/handler';
import { createProductionSarvamPorts } from '@/lib/core1/sarvam-tools/production';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, route: { params: Promise<{ tool: string }> }): Promise<Response> {
  const { tool } = await route.params;
  return createSarvamHandler(createProductionSarvamPorts)(request, tool);
}
