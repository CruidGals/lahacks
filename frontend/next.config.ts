import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["53y24guzjbxx.share.zrok.io"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
