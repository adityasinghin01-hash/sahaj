import { createCore2ProofRouteHandlers } from "./routes";
import { getCore2ProofService } from "./supabase";

export * from "./contracts";
export * from "./saaras-stt";
export * from "./code-word";
export * from "./escalation";
export * from "./service";
export * from "./routes";
export * from "./supabase";

export const core2ProofHandlers = createCore2ProofRouteHandlers(getCore2ProofService);
