import { core2Handlers } from "@/lib/core2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await context.params;
  return core2Handlers.trustedContactPatch(request, contactId);
}

