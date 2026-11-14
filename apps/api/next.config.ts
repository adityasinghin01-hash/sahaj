import type { NextConfig } from "next";
// Both halves export TypeScript workspace source with ESM .js specifiers.
const config: NextConfig = {
  transpilePackages: ["@sahaj/adapters", "@sahaj/atlas", "@sahaj/gate", "@sahaj/shared"],
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] } },
};
export default config;
