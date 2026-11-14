import type { NextConfig } from "next";
// Both halves export TypeScript workspace source with ESM .js specifiers.
const config: NextConfig = {
  transpilePackages: ["@sahaj/adapters", "@sahaj/atlas", "@sahaj/gate", "@sahaj/shared"],
  // Cedar loads this runtime WASM file relative to its package directory; keep the package intact in server bundles.
  serverExternalPackages: ["@cedar-policy/cedar-wasm"],
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] } },
};
export default config;
