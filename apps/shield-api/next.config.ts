import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sahaj/shield", "@sahaj/adapters", "@sahaj/shared"],
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    },
  },
};

export default nextConfig;

