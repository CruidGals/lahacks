import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["kk08f6j4g1hp.share.zrok.io"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
