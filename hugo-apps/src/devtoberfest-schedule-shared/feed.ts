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
    return r.json();
  } catch { return { authenticated: false }; }
}
