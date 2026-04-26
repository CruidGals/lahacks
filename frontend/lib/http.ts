/**
 * Thin typed HTTP client used by lib/api.ts.
 *
 * Auth model: the backend supports `Authorization: Bearer <user uuid>` as a
 * dev/legacy auth path. On first load we POST /api/users to register an
 * anonymous user (the backend generates a Solana keypair for us) and stash
 * the returned id in localStorage. Every subsequent request sends that id
 * as the bearer token.
 */

const BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:8080";

const USER_ID_KEY = "cleanr.user_id.v1";
const USER_CACHE_KEY = "cleanr.user_cache.v1";

export type ApiUser = {
  id: string;
  wallet_address: string;
  verified: boolean | null;
  world_id_hash: string | null;
  created_at: string | null;
};

type RegisterUserResponse = {
  ok: boolean;
  user: ApiUser;
};

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function getStoredUserId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(USER_ID_KEY);
}

function setStoredUserId(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_ID_KEY, id);
}

function getCachedUser(): ApiUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ApiUser;
  } catch {
    return null;
  }
}

export function setCachedUser(user: ApiUser) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
}

export function clearAuth() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(USER_ID_KEY);
  window.localStorage.removeItem(USER_CACHE_KEY);
}

let registrationPromise: Promise<ApiUser> | null = null;

/**
 * Returns the current anonymous user, registering one with the backend on
 * first call. Safe to call from many places — concurrent calls share a
 * single in-flight registration.
 */
export async function ensureUser(): Promise<ApiUser> {
  const cached = getCachedUser();
  const storedId = getStoredUserId();
  if (cached && storedId && cached.id === storedId) {
    return cached;
  }

  if (registrationPromise) return registrationPromise;

  registrationPromise = (async () => {
    const res = await fetch(`${BASE_URL}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      registrationPromise = null;
      const body = await safeJson(res);
      throw new ApiError(
        `Failed to register user (${res.status})`,
        res.status,
        body
      );
    }
    const json = (await res.json()) as RegisterUserResponse;
    setStoredUserId(json.user.id);
    setCachedUser(json.user);
    return json.user;
  })();

  try {
    return await registrationPromise;
  } finally {
    registrationPromise = null;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Set false for endpoints that should not require auth (e.g. /api/users registration). */
  auth?: boolean;
  /** Optional query params object. */
  query?: Record<string, string | number | undefined | null>;
};

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function api<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, auth = true, query } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";

  if (auth) {
    const user = await ensureUser();
    headers["authorization"] = `Bearer ${user.id}`;
  }

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await safeJson(res);
  if (!res.ok) {
    const message =
      (json && typeof json === "object" && "error" in json
        ? typeof (json as { error: unknown }).error === "string"
          ? ((json as { error: string }).error)
          : JSON.stringify((json as { error: unknown }).error)
        : `Request failed (${res.status})`) ?? "Request failed";
    throw new ApiError(message, res.status, json);
  }

  return json as T;
}

export function getApiBaseUrl(): string {
  return BASE_URL;
}
