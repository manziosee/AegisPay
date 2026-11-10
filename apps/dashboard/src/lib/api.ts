export type ApiError = Error & { status?: number; requestId?: string };

let unauthorizedHandler: (() => void) | null = null;
let organizationId: string | null = null;

/** Selects the workspace sent as X-Organization-ID on every request. */
export function setOrganizationId(id: string | null) {
  organizationId = id;
}

/** Registers the callback used when an authenticated request returns 401. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type ApiInit = RequestInit & {
  /** Do not treat a 401 as an expired session (used for session probes and sign-in). */
  anonymous?: boolean;
};

// The session token is an httpOnly cookie managed by the same-origin proxy
// (src/app/proxy/[...path]/route.ts); browser code never handles it.
const NETWORK_MESSAGE =
  "Your network connection changed or dropped before the request finished. Check your connection and try again.";

/**
 * Browsers abort requests when the device's network changes (Wi-Fi, VPN,
 * mobile handover), reporting a bare TypeError. Requests that are safe to
 * repeat (reads, and writes the API de-duplicates by Idempotency-Key) are
 * retried once; others report a clear message instead of "Failed to fetch".
 */
async function fetchWithNetworkRetry(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const repeatable = method === "GET" || method === "HEAD" || new Headers(init.headers).has("Idempotency-Key");
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    if (repeatable) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        return await fetch(url, init);
      } catch (retryError) {
        if (!(retryError instanceof TypeError)) throw retryError;
      }
    }
    const networkError = new Error(NETWORK_MESSAGE) as ApiError;
    networkError.status = 0;
    throw networkError;
  }
}

async function request<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { anonymous, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  headers.set("Accept", "application/json");
  if (
    fetchInit.body &&
    !(typeof FormData !== "undefined" && fetchInit.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  if (organizationId && !headers.has("X-Organization-ID")) {
    headers.set("X-Organization-ID", organizationId);
  }

  const response = await fetchWithNetworkRetry(`/proxy/v1${path}`, {
    ...fetchInit,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  const payload = await parsePayload(response);

  if (!response.ok) {
    const body = payload as { error?: string; message?: string; request_id?: string } | undefined;
    const error = new Error(
      body?.error || body?.message || `Request failed (${response.status})`
    ) as ApiError;
    error.status = response.status;
    error.requestId = body?.request_id ?? response.headers.get("X-Request-ID") ?? undefined;
    if (response.status === 401 && !anonymous) unauthorizedHandler?.();
    throw error;
  }
  return payload as T;
}

export function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return request<T>(path, init);
}

/** CSV and other binary downloads through the same-origin proxy. */
export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const headers = new Headers(init.headers);
  if (organizationId && !headers.has("X-Organization-ID")) {
    headers.set("X-Organization-ID", organizationId);
  }
  const response = await fetchWithNetworkRetry(`/proxy/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await parsePayload(response);
    const body = payload as { error?: string } | undefined;
    if (response.status === 401) unauthorizedHandler?.();
    const error = new Error(body?.error || `Export failed (${response.status})`) as ApiError;
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

export function idempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `dash_${random}`;
}

// One key per user intent (endpoint + payload), kept until the server
// confirms success. A retry after a timeout or dropped connection reuses the
// key, so the API replays the original result instead of acting twice.
// Module scope keeps the key if the user navigates away and back.
const pendingIdempotencyKeys = new Map<string, string>();

/** POSTs body with an Idempotency-Key that is stable across retries of the same request. */
export async function apiIdempotent<T>(path: string, body: unknown = {}, init: ApiInit = {}): Promise<T> {
  const payload = JSON.stringify(body);
  const intent = `${path}\n${payload}`;
  let key = pendingIdempotencyKeys.get(intent);
  if (!key) {
    key = idempotencyKey();
    pendingIdempotencyKeys.set(intent, key);
  }
  const headers = new Headers(init.headers);
  headers.set("Idempotency-Key", key);
  const result = await request<T>(path, { ...init, method: init.method ?? "POST", headers, body: payload });
  pendingIdempotencyKeys.delete(intent);
  return result;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The request could not be completed.";
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
