import type { NextConfig } from "next";

const apiOrigin = (process.env.API_PROXY_TARGET ?? "http://localhost:18080").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Docker keeps the standalone server; Netlify's Next runtime uses the default output.
  ...(process.env.NETLIFY ? {} : { output: "standalone" as const }),
  // Allow the Playwright dev server and 127.0.0.1 checks against a localhost-bound server.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async rewrites() {
    return [{ source: "/proxy/:path*", destination: `${apiOrigin}/:path*` }];
  }
};

export default nextConfig;
