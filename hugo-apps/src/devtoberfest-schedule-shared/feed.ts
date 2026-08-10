import type { Feed, MyCompletions } from './types';

const opts: RequestInit = { headers: { Accept: 'application/json' }, credentials: 'include' };

export async function fetchFeed(editionId?: string): Promise<Feed> {
  const q = editionId ? `?edition=${encodeURIComponent(editionId)}` : '';
  const r = await fetch(`/api/devtoberfest/schedule${q}`, opts);
  if (!r.ok) throw new Error(`schedule ${r.status}`);
  return r.json();
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
