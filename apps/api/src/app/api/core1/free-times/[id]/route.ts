import {
  createProductionMatcherDeps,
  handleFreeTimesDelete,
} from '@/lib/core1-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleFreeTimesDelete(request, createProductionMatcherDeps(), id);
}
