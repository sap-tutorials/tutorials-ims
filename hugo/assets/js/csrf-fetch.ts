/**
 * csrfFetch — a `fetch()` wrapper that transparently handles AppRouter's
 * CSRF token flow for authenticated mutating requests.
 *
 * CANONICAL SOURCE. This is the single shared implementation, consumed by
 * all three frontend bundlers:
 *   - Hugo `js.Build` (esbuild) — `hugo/assets/js/tutorial.ts` imports it
 *     as a `./csrf-fetch` sibling. esbuild has no Hugo module mounts, so it
 *     can only resolve siblings under `hugo/assets/js/` + `node_modules`;
 *     that is WHY the canonical file lives here and not under a `src/` tree.
 *   - hugo-apps (Vite)          — re-exported by `hugo-apps/src/shared/csrf-fetch.ts`.
 *   - analytics-explorer (Vite) — re-exported by `app/analytics-explorer/src/api/csrf-fetch.ts`.
 * Both Vite bundles resolve out-of-root relative imports fine, so they reach
 * across to this file rather than duplicating it. The previous two hand-kept
 * copies (which drifted only in comments) are gone — there is now one source.
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
 *  - Stale-session re-auth (issue #1904): if the token handshake or the
 *    mutating request itself comes back as AppRouter's XSUAA login
 *    interstitial (a followed redirect, or a 200 with an HTML body where
 *    JSON was expected), csrfFetch forces a top-level navigation to
 *    `/login?returnTo=<current path>` and throws `CsrfFetchError`. This turns
 *    the previously-swallowed "logged out while the page still looks logged
 *    in" case into a proper re-authentication redirect.
 *  - `credentials: 'include'` is added when missing. Vue islands hit the
 *    approuter on the same origin so it's usually redundant, but for
 *    hybrid-dev port hopping (approuter on 5000, hugo on 1313) it
 *    matters.
 *
 * Behaviour tests live at `hugo-apps/src/shared/csrf-fetch.test.ts` (which
 * imports through the re-export shim, so they exercise this file).
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

/**
 * Detects AppRouter's XSUAA login interstitial (issue #1904). When the session
 * has expired (or was never established), AppRouter answers API and /auth/user
 * requests with HTTP 200 and an HTML body whose inline <script> navigates the
 * *top-level document* to /oauth/authorize. Consumed through fetch() that
 * script never runs, so the re-auth is silently swallowed and a mutating action
 * (e.g. the tutorial "Done" button) appears to soft-fail. The reliable
 * client-side tells are: the response was redirected, or a *successful* (2xx)
 * response carries an HTML body where the API would return JSON (204/JSON
 * responses are never flagged).
 *
 * The 2xx guard is load-bearing (Petoberfest upload, 2026-08): an HTML body on
 * an ERROR status is NOT the interstitial — it's an edge/CDN block (e.g. Akamai
 * returns `403 Server: AkamaiGHost, Content-Type: text/html` "Access Denied"
 * for POST bodies over its ~16KB cap on developers.sap.com) or an origin 5xx.
 * Treating those as session-expiry wrongly forced a top-level /login navigation
 * that reloaded the page and hid the real error. Error responses must fall
 * through to the caller's error handler instead.
 */
function isSessionExpiredResponse(res: Response): boolean {
  if (res.redirected) return true;
  // Only a successful response can be the login interstitial. A 4xx/5xx HTML
  // body is an edge/CDN or origin error page — surface it, don't re-auth.
  if (!res.ok) return false;
  // Optional chaining: some callers/tests pass minimal Response-like stubs
  // without a `headers` bag. A real fetch Response always has one.
  const ct = (res.headers?.get?.('content-type') ?? '').toLowerCase();
  return ct.includes('text/html');
}

/**
 * Force a real top-level navigation to the login flow so AppRouter's OAuth
 * redirect actually executes and the learner lands back on this page once
 * re-authenticated. Mirrors the /login?returnTo pattern used by header.html's
 * checkAuth/maybeAutoLogin. Guarded for non-browser (test/SSR) contexts where
 * location.replace is unavailable.
 */
function redirectToReauth(): void {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc || typeof loc.replace !== 'function') return;
  const returnTo = (loc.pathname ?? '') + (loc.search ?? '');
  loc.replace('/login?returnTo=' + encodeURIComponent(returnTo));
}

async function fetchToken(fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl('/auth/user', {
    method: 'GET',
    credentials: 'include',
    headers: { 'x-csrf-token': 'fetch' },
  });
  // Expired/absent session: bounce through a real login navigation rather than
  // swallowing the interstitial and reporting a generic token failure (#1904).
  if (isSessionExpiredResponse(res)) {
    redirectToReauth();
    throw new CsrfFetchError(
      `csrfFetch: session expired during token handshake (status=${res.status}) — redirecting to re-authenticate`,
      res,
    );
  }
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

  // A stale session can also surface on the mutating request itself: AppRouter
  // intercepts the POST with the login interstitial (200 text/html) instead of
  // the API's JSON. Redirect to re-authenticate rather than let the caller
  // treat 200-HTML as a soft failure or (worse) success (#1904).
  if (isSessionExpiredResponse(firstResp)) {
    redirectToReauth();
    throw new CsrfFetchError(
      'csrfFetch: session expired on mutating request — redirecting to re-authenticate',
      firstResp,
    );
  }

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

  const retryResp = await fetchImpl(url, retryInit);
  if (isSessionExpiredResponse(retryResp)) {
    redirectToReauth();
    throw new CsrfFetchError(
      'csrfFetch: session expired on mutating retry — redirecting to re-authenticate',
      retryResp,
    );
  }
  return retryResp;
}
