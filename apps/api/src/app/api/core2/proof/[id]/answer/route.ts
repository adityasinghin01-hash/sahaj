import { core2ProofHandlers } from "@/lib/core2-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return core2ProofHandlers.proofAnswerPost(request, id);
}
