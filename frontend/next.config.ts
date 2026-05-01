import type { NextConfig } from "next";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

// Single source of truth for env: monorepo root `.env`. We don't keep a
// `frontend/.env` — calling Next's own loader on the parent directory
// populates `process.env` with all NEXT_PUBLIC_* values BEFORE Next's
// build pipeline scans for them, so the build inlines them into the
// client bundle exactly as if they had been local. Runs once when this
// config is evaluated (`next dev` / `next build`).
loadEnvConfig(path.resolve(__dirname, ".."));

const nextConfig: NextConfig = {
  transpilePackages: ['@reown/appkit', '@reown/appkit-adapter-wagmi', 'wagmi', '@wagmi/core', '@wagmi/connectors'],
  experimental: {
    externalDir: true,
  },
  turbopack: {
    resolveAlias: {
      'accounts': './src/accounts.ts',
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'accounts': require.resolve('./src/accounts.ts'),
    };
    return config;
  },
};

export default nextConfig;
