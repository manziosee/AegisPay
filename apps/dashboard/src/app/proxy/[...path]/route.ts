import { NextResponse, type NextRequest } from "next/server";

/**
 * Same-origin proxy from the browser to the Go API.
 *
 * The session token lives only in an httpOnly cookie, so page scripts (and
 * any injected script) never see it. This handler attaches it as a bearer
 * token, removes it from login responses, and checks the request origin on
 * state-changing calls because cookies are sent automatically.
 */

const API_ORIGIN = (process.env.API_PROXY_TARGET ?? "http://localhost:18080").replace(/\/+$/, "");
// Shared with the API's TRUSTED_PROXY_SECRET so it accepts the client
// address reported below for per-IP rate limits.
const PROXY_SECRET = process.env.TRUSTED_PROXY_SECRET ?? "";
// Header set by the edge in front of this server, e.g. x-nf-client-connection-ip
// on Netlify or cf-connecting-ip behind Cloudflare.
const CLIENT_IP_HEADER = process.env.CLIENT_IP_HEADER?.trim().toLowerCase() ?? "";
// Number of proxies in front of this server that append to X-Forwarded-For.
const TRUSTED_PROXY_HOPS = Math.max(0, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "0", 10) || 0);

const SECURE_COOKIE = "__Host-aegis_session";
const LOCAL_COOKIE = "aegis_session";

const SESSION_ISSUING = new Set(["v1/auth/login", "v1/auth/register", "v1/auth/mfa/verify-login"]);
const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key", "x-request-id", "x-organization-id"];
const RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "retry-after",
  "x-request-id",
  "x-settlement-status",
  "x-aegispay-from",
  "x-aegispay-to",
  "x-aegispay-has-more",
  "x-aegispay-next-cursor"
];

function isSecure(request: NextRequest) {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto ? proto === "https" : request.nextUrl.protocol === "https:";
}

function sessionToken(request: NextRequest) {
  return request.cookies.get(SECURE_COOKIE)?.value ?? request.cookies.get(LOCAL_COOKIE)?.value;
}

function clientIp(request: NextRequest): string | undefined {
  if (CLIENT_IP_HEADER) {
    const value = request.headers.get(CLIENT_IP_HEADER)?.split(",")[0]?.trim();
    if (value) return value;
  }
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length === 0) return undefined;
  return hops[Math.max(0, hops.length - 1 - TRUSTED_PROXY_HOPS)];
}

/** Rejects cross-site requests that would otherwise carry the session cookie. */
function sameOrigin(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function errorResponse(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function clearSession(response: NextResponse, request: NextRequest) {
  // Browsers only accept a __Host- cookie update that is Secure with Path=/.
  if (request.cookies.has(SECURE_COOKIE)) {
    response.cookies.set(SECURE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  }
  if (request.cookies.has(LOCAL_COOKIE)) {
    response.cookies.set(LOCAL_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  }
}

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const joined = path.join("/");
  if (path[0] !== "v1" || path.some((segment) => segment === ".." || segment === ".")) {
    return errorResponse(404, "not found");
  }
  const unsafe = request.method !== "GET" && request.method !== "HEAD";
  if (unsafe && !sameOrigin(request)) {
    return errorResponse(403, "cross-site request blocked");
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = sessionToken(request);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (PROXY_SECRET) {
    const ip = clientIp(request);
    headers.set("x-aegispay-proxy-secret", PROXY_SECRET);
    if (ip) headers.set("x-aegispay-client-ip", ip);
  }

  const target = `${API_ORIGIN}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: unsafe ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store"
    });
  } catch {
    return errorResponse(502, "The AegisPay API is unavailable.");
  }

  if (SESSION_ISSUING.has(joined) && upstream.ok) {
    const payload = (await upstream.json().catch(() => null)) as
      | (Record<string, unknown> & { access_token?: string; expires_at?: string })
      | null;
    if (!payload) return errorResponse(502, "Invalid response from the AegisPay API.");
    const { access_token: accessToken, ...rest } = payload;
    const response = NextResponse.json(rest, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" }
    });
    if (accessToken) {
      const secure = isSecure(request);
      const expires = payload.expires_at ? new Date(payload.expires_at) : undefined;
      response.cookies.set(secure ? SECURE_COOKIE : LOCAL_COOKIE, accessToken, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        expires: expires && !Number.isNaN(expires.getTime()) ? expires : undefined
      });
    }
    return response;
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const response = new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
  if (joined === "v1/auth/logout" || (upstream.status === 401 && token)) {
    clearSession(response, request);
  }
  return response;
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
