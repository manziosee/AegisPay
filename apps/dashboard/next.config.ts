import type { NextConfig } from "next";

// The Content-Security-Policy is set per request in src/proxy.ts because it
// carries a nonce. These headers are the same for every response.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Browsers ignore HSTS on plain-HTTP responses, so local development is unaffected.
  { key: "Strict-Transport-Security", value: "max-age=63072000" }
];

const nextConfig: NextConfig = {
  // Docker keeps the standalone server; Netlify's Next runtime uses the default output.
  ...(process.env.NETLIFY ? {} : { output: "standalone" as const }),
  // Allow the Playwright dev server and 127.0.0.1 checks against a localhost-bound server.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
