import type { ShieldBrainDeps } from "../brain/types.js";

/** The slice of brain deps the key-free link checks use. */
export type LinkIntelDeps = Pick<ShieldBrainDeps, "cache" | "env" | "now" | "linkIntelFetch">;
