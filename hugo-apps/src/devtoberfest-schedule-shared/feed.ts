import type { Feed, MyCompletions, MyFavorites } from './types';

const opts: RequestInit = { headers: { Accept: 'application/json' }, credentials: 'include' };

/** Normalize a name to lowercase, trimmed, whitespace-collapsed form for matching.
 * NOTE: This mirrors normalizeName in srv/lib/teched/author-match.js (which is CJS and
 * cannot be imported by browser bundles). Keep both in sync if the logic changes. */
function normalizeName(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Build a lookup map from normalized displayName → login from an author index.
 * Ambiguous entries (same normalized name, multiple logins) are excluded.
 */
function buildNameToLoginMap(authorIndex: Record<string, { login: string; displayName: string }>): Map<string, string> {
  const nameToLogins = new Map<string, string[]>();
  for (const entry of Object.values(authorIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeName(entry.displayName);
    if (!key) continue;
    if (!nameToLogins.has(key)) nameToLogins.set(key, []);
    nameToLogins.get(key)!.push(entry.login);
  }
  const result = new Map<string, string>();
  for (const [key, logins] of nameToLogins) {
    if (logins.length === 1) result.set(key, logins[0]);
    // >1 logins → ambiguous, excluded
  }
  return result;
}

/**
 * Enrich a feed's session speakers with `authorLogin` (string | null) by
 * matching their name against the provided author index.
 * Mutates speaker objects in place; fail-open (skips quietly on bad index).
 */
export function enrichFeedWithAuthorLogins(
  feed: Feed,
  authorIndex: Record<string, { login: string; displayName: string }>,
): void {
  if (!authorIndex || typeof authorIndex !== 'object') return;
  const map = buildNameToLoginMap(authorIndex);
  for (const session of feed.sessions || []) {
    for (const sp of session.speakers || []) {
      const key = normalizeName(sp.name);
      sp.authorLogin = map.get(key) ?? null;
    }
  }
}

export async function fetchFeed(editionId?: string): Promise<Feed> {
  const q = editionId ? `?edition=${encodeURIComponent(editionId)}` : '';
  const r = await fetch(`/api/devtoberfest/schedule${q}`, opts);
  if (!r.ok) throw new Error(`schedule ${r.status}`);
  const feed: Feed = await r.json();

  // Enrich session speakers with authorLogin by matching displayName against
  // hugo/static/author_index.json (served as /author_index.json). Fail-open:
  // missing file, bad JSON, or network error → speakers keep authorLogin absent.
  try {
    const ar = await fetch('/author_index.json', { headers: { Accept: 'application/json' } });
    if (ar.ok) {
      const authorIndex = await ar.json();
      enrichFeedWithAuthorLogins(feed, authorIndex);
    }
  } catch {
    // Fail-open: enrichment is best-effort
  }

  return feed;
}

export async function fetchMyCompletions(editionId?: string): Promise<MyCompletions> {
  try {
    const q = editionId ? `?edition=${encodeURIComponent(editionId)}` : '';
    const r = await fetch(`/api/devtoberfest/my-completions${q}`, opts);
    if (!r.ok) return { authenticated: false };
    // Defense-in-depth: if the approuter gate ever returns a 200 login-redirect
    // HTML page (rather than the backend's JSON), don't parse it as JSON —
    // treat the caller as anonymous. Only bail when the content-type is
    // positively non-JSON; awaiting r.json() keeps any parse rejection inside
    // this try/catch.
    const ct = r.headers?.get?.('content-type');
    if (ct && !ct.includes('application/json')) return { authenticated: false };
    return await r.json();
  } catch { return { authenticated: false }; }
}

// #2393 — the JWT user's favorited sessions (both event families). Mirrors
// fetchMyCompletions' degrade-to-anonymous guards: 401/non-2xx/non-JSON/throw
// all collapse to an empty, unauthenticated overlay so public pages still render.
export async function fetchMyFavorites(): Promise<MyFavorites> {
  try {
    const r = await fetch('/api/getMyFavorites()', opts);
    if (!r.ok) return { authenticated: false, favorites: [] };
    const ct = r.headers?.get?.('content-type');
    if (ct && !ct.includes('application/json')) return { authenticated: false, favorites: [] };
    const body = await r.json();
    const rows = body?.value ?? body ?? [];
    return { authenticated: true, favorites: Array.isArray(rows) ? rows : [] };
  } catch { return { authenticated: false, favorites: [] }; }
}
