import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['gsznxq6rrjrg.share.zrok.io'],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
