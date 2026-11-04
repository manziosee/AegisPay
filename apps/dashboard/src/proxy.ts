import { NextResponse, type NextRequest } from "next/server";

/**
 * Sets a per-request nonce Content-Security-Policy. Only scripts that Next.js
 * renders with this nonce (and the scripts they load) can run, so injected
 * markup cannot execute script even if it reaches the page.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const https = proto ? proto === "https" : request.nextUrl.protocol === "https:";
  const directives = [
    "default-src 'self'",
    // Same-origin scripts (Next.js chunks, and Netlify's team toolbar at
    // /.netlify/scripts) are allowed; inline and third-party scripts need the
    // per-request nonce.
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // Radix UI and Motion position elements with inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : [])
  ];
  const csp = directives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // API proxy responses and static assets do not need a document policy.
      source: "/((?!proxy/|_next/static|_next/image|images/|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" }
      ]
    }
  ]
};
