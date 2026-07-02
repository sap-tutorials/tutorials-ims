/**
 * csrfFetch — a `fetch()` wrapper for AppRouter's CSRF token flow.
 *
 * This file is a sibling copy of `hugo-apps/src/shared/csrf-fetch.ts` — both
 * must stay in behavioural sync. They live in separate Vite bundles
 * (hugo-apps and analytics-explorer) that cannot share source via symlink
 * on Windows. If you change one, change the other; tests for the shared
 * behaviour live under both.
 *
 * See docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md
 * for the rationale.
 */

export class CsrfFetchError extends Error {
  constructor(message: string, public readonly response?: Response) {
    super(message);
    this.name = 'CsrfFetchError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let cachedToken: string | null = null;

export function _resetCsrfTokenCacheForTests(): void {
  cachedToken = null;
}

export function _seedCsrfTokenForTests(token: string): void {
  cachedToken = token;
}

export function _getCsrfTokenForTests(): string | null {
  return cachedToken;
}

function isSafeMethod(init?: RequestInit): boolean {
  const m = (init?.method ?? 'GET').toUpperCase();
  return SAFE_METHODS.has(m);
}

async function fetchToken(fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl('/auth/user', {
    method: 'GET',
    credentials: 'include',
    headers: { 'x-csrf-token': 'fetch' },
  });
  const token = res.headers.get('x-csrf-token');
  if (!res.ok || !token) {
    throw new CsrfFetchError(
      `csrfFetch: unable to acquire token (status=${res.status}, header=${token ?? 'absent'})`,
      res,
    );
  }
  return token;
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): HeadersInit {
  const h = new Headers(base ?? undefined);
  for (const [k, v] of Object.entries(extra)) {
    h.set(k, v);
  }
  return h;
}

function withCredentials(init: RequestInit): RequestInit {
  if (init.credentials) return init;
  return { ...init, credentials: 'include' };
}

export async function csrfFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const fetchImpl = (globalThis.fetch ?? fetch).bind(globalThis);

  if (isSafeMethod(init)) {
    return fetchImpl(url, withCredentials(init));
  }

  if (cachedToken === null) {
    cachedToken = await fetchToken(fetchImpl);
  }

  const firstInit: RequestInit = withCredentials({
    ...init,
    headers: mergeHeaders(init.headers, { 'x-csrf-token': cachedToken }),
  });

  const firstResp = await fetchImpl(url, firstInit);

  if (firstResp.status !== 403) return firstResp;

  const required = (firstResp.headers.get('x-csrf-token') ?? '').toLowerCase();
  if (required !== 'required') return firstResp;

  cachedToken = null;
  cachedToken = await fetchToken(fetchImpl);

  const retryInit: RequestInit = withCredentials({
    ...init,
    headers: mergeHeaders(init.headers, { 'x-csrf-token': cachedToken }),
  });

  return fetchImpl(url, retryInit);
}
