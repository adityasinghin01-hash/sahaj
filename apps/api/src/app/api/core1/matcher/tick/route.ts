import {
  createProductionMatcherDeps,
  handleMatcherTick,
} from '@/lib/core1-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleMatcherTick(request, createProductionMatcherDeps());
}
