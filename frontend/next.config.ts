import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
