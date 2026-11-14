import type { NextConfig } from "next";

// Cedar's WASM loader reads its .wasm file relative to its own directory at runtime, so it must not be bundled.
// Added in Phase 3 (first route graph that imports @sahaj/gate); report to the integrator.
const config: NextConfig = {
  serverExternalPackages: ["@cedar-policy/cedar-wasm"],
};
export default config;
