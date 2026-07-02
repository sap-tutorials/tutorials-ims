/**
 * csrfFetch — a `fetch()` wrapper that transparently handles AppRouter's
 * CSRF token flow for authenticated mutating requests.
 *
 * Contract:
 *  - For GET/HEAD/OPTIONS (or when `init.method` is omitted), it's a
 *    plain pass-through to `fetch()`. AppRouter never enforces CSRF on
 *    safe methods.
 *  - For any non-safe method:
 *      1. If no token is cached, fetch one via `GET /auth/user` with the
 *         `x-csrf-token: fetch` header. AppRouter emits the token in the
 *         `x-csrf-token` response header on any authenticated request.
 *      2. Attach the cached token to the original request as
 *         `x-csrf-token: <value>` and send it.
 *      3. If the response is 403 and the `x-csrf-token` response header
 *         equals `required` (approuter's spelling — it uses "Required"
 *         with a capital R in some versions, so we normalise case), the
 *         cached token was stale. Clear cache, refetch once, retry the
 *         original request exactly once, and return that response.
 *  - `credentials: 'include'` is added when missing. Vue islands hit the
 *    approuter on the same origin so it's usually redundant, but for
 *    hybrid-dev port hopping (approuter on 5000, hugo on 1313) it
 *    matters.
 *
 * Companion of `app/analytics-explorer/src/api/csrf-fetch.ts`. Both
 * files MUST stay in behavioural sync — they compile through different
 * Vite bundles and cannot share source (Windows-hostile symlinks). If
 * you touch one, touch the other. Behaviour tests live at
 * `hugo-apps/src/shared/__tests__/csrf-fetch.test.ts` and the
 * analytics-explorer copy re-exports them.
 *
 * Design context: docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md
 */

export class CsrfFetchError extends Error {
  constructor(message: string, public readonly response?: Response) {
    super(message);
    this.name = 'CsrfFetchError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let cachedToken: string | null = null;

/** Test-only: reset the module-scoped token cache. */
export function _resetCsrfTokenCacheForTests(): void {
  cachedToken = null;
}

/** Test-only: pre-seed the token cache to skip the /auth/user handshake in tests. */
export function _seedCsrfTokenForTests(token: string): void {
  cachedToken = token;
}

/** Test-only: read the current cached token. */
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
  // Headers can be provided as Headers instance, plain object, or array of pairs.
  // Normalise to Headers, then apply the additions.
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

/**
 * Fetch a URL, transparently handling CSRF for non-safe methods.
 * Retries exactly once on a 403 with `x-csrf-token: required`.
 */
export async function csrfFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const fetchImpl = (globalThis.fetch ?? fetch).bind(globalThis);

  if (isSafeMethod(init)) {
    return fetchImpl(url, withCredentials(init));
  }

  // Acquire a token if we don't have one yet.
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

  // Token was stale. Refetch and retry once.
  cachedToken = null;
  cachedToken = await fetchToken(fetchImpl);

  const retryInit: RequestInit = withCredentials({
    ...init,
    headers: mergeHeaders(init.headers, { 'x-csrf-token': cachedToken }),
  });

  return fetchImpl(url, retryInit);
}
