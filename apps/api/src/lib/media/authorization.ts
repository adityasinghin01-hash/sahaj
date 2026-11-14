import type { MediaAuthorizer } from "./contracts";

/**
 * Production default until a real Cedar-backed adapter is configured by the orchestrator.
 * It always denies, so media stays unreadable rather than silently permitted.
 */
export const denyAllAuthorizer: MediaAuthorizer = async () => "deny";
