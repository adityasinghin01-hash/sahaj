import { createProductionRefillDeps, executeRefillProposalCommand } from '@/lib/core1/refill-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return executeRefillProposalCommand(request, createProductionRefillDeps());
}
