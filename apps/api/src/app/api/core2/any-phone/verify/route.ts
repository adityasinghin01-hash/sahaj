import { core2ProofHandlers } from "@/lib/core2-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => core2ProofHandlers.anyPhoneVerifyPost(request);
