import {
  createProductionMatcherDeps,
  handleFreeTimesDelete,
  handleFreeTimesGet,
  handleFreeTimesPost,
} from '@/lib/core1-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleFreeTimesGet(request, createProductionMatcherDeps());
}

export async function POST(request: Request) {
  return handleFreeTimesPost(request, createProductionMatcherDeps());
}

export async function DELETE(request: Request) {
  return handleFreeTimesDelete(request, createProductionMatcherDeps());
}
