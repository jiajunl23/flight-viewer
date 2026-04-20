import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["shared", "three", "react-globe.gl"],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "unpkg.com" }],
  },
};

export default nextConfig;
