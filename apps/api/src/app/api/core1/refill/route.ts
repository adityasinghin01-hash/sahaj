import { createProductionRefillDeps, executeRefillCommand } from '@/lib/core1/refill-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return executeRefillCommand(request, createProductionRefillDeps());
}
