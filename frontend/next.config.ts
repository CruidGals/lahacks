import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Expose USE_DEMO_VIDEO from .env.local to the browser bundle (see uploadFixtureVideo).
  env: {
    USE_DEMO_VIDEO: process.env.USE_DEMO_VIDEO ?? "",
  },
  allowedDevOrigins: ['gsznxq6rrjrg.share.zrok.io'],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
