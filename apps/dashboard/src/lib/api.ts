export type ApiError = Error & { status?: number; requestId?: string };

let unauthorizedHandler: (() => void) | null = null;

/** Registers the callback used when a request carrying a bearer token returns 401. */
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

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`/proxy/v1${path}`, {
    ...init,
    headers,
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
    if (response.status === 401 && token) unauthorizedHandler?.();
    throw error;
  }
  return payload as T;
}

export function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, token, init);
}

/** CSV and other binary downloads. Keeps the same origin and bearer auth. */
export async function apiBlob(path: string, token: string, init: RequestInit = {}): Promise<Blob> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/proxy/v1${path}`, {
    ...init,
    headers,
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
