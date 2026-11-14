import { createCore2RouteHandlers } from "./routes";
import { createCore2Service } from "./service";
import { createProductionCore2Deps } from "./supabase";

export * from "./contracts";
export * from "./http";
export * from "./routes";
export * from "./security";
export { createCore2Service } from "./service";
export {
  createProductionCore2Deps,
  createSupabaseCore2Repository,
  createSupabaseDispatchPort,
  createSupabaseTimelinePort,
} from "./supabase";

export function getCore2Service() {
  return createCore2Service(createProductionCore2Deps());
}

export const core2Handlers = createCore2RouteHandlers(getCore2Service);
