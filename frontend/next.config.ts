import type { NextConfig } from "next";

// Env strategy: the root `.env` is the single source of truth. The
// `_sync-env` npm script copies it to `frontend/.env.local` BEFORE
// `next dev` / `next build` runs, so Next's native env loader (which
// turbopack's workers respect by design) picks the values up the same
// way it would a hand-written `frontend/.env`. We tried calling
// `@next/env`'s `loadEnvConfig` from inside this config in turbopack
// builds; the workers spawned for prerender don't see env mutations made
// here, so values came back undefined at SSR-evaluation time. Copying
// the file beats the timing problem at the package-manager layer.
//
// `.env.local` is gitignored (`.env.*` line in repo .gitignore), so the
// copy is transient build state, not committed config.

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
