import type { NextConfig } from "next";

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
