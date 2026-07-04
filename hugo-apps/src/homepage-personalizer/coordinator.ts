import { readSessionCache, writeSessionCache, type Envelope } from './session-cache';
import { applyVerbOrder } from './verb-order';
import { renderBadge } from './personalized-badge';
import { applyTeaserRerank, type FetchedCard } from './teaser-rerank';

const DEFAULT_FLAG_KEY = 'sap-devs-homepage-default';
const ENDPOINT = '/homepage/personalized';

export function isDefaultViewActive(): boolean {
  try {
    if (new URLSearchParams(location.search).get('default') === '1') return true;
    return sessionStorage.getItem(DEFAULT_FLAG_KEY) === '1';
  } catch { return false; }
}

function looksSignedIn(): boolean {
  return typeof document !== 'undefined'
    && /(?:^|;\s*)JSESSIONID=/.test(document.cookie || '');
}

async function isSignedIn(): Promise<boolean> {
  if (looksSignedIn()) return true;
  try {
    const r = await fetch('/me', { credentials: 'include' });
    return r.ok;
  } catch { return false; }
}

// (#763 Task 12) Fetch card HTML for slugs missing from the Row-5 DOM.
async function fetchMissingCards(slugs: string[]): Promise<FetchedCard[]> {
  try {
    const url = `/homepage/tutorialCards?slugs=${encodeURIComponent(JSON.stringify(slugs))}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return [];
    const body = await r.json();
    // CAP wraps array responses in OData envelope { value: [...] } — unwrap.
    return (Array.isArray(body) ? body : (body?.value ?? [])) as FetchedCard[];
  } catch { return []; }
}

export async function boot(): Promise<void> {
  try {
    if (isDefaultViewActive()) {
      renderBadge(document.querySelector('.personalized-badge-slot'), null, 'default');
      return;
    }
    if (!(await isSignedIn())) return;

    const cached = readSessionCache();
    const headers: Record<string, string> = {};
    if (cached?.hash) headers['If-None-Match'] = `"${cached.hash}"`;

    const resp = await fetch(ENDPOINT, { credentials: 'include', headers });
    if (resp.status === 204 || resp.status === 401) return;
    if (resp.status === 304) { applyEnvelope(cached!.payload); return; }
    if (!resp.ok) return;

    const payload = (await resp.json()) as Envelope;
    writeSessionCache(payload);
    applyEnvelope(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.debug('[homepage-personalizer] boot failed', e);
  }
}

// Replaced by Task 10 with the surface dispatcher.
function applyEnvelope(env: Envelope): void {
  applyVerbOrder(
    document.querySelector<HTMLElement>('[data-personalize="verb-order"]'),
    env.verbOrder ?? []
  );
  renderBadge(
    document.querySelector('.personalized-badge-slot'),
    env.profile ?? null,
    'personalized'
  );
  // (#763 Task 12) Reorder Row-5 tutorial teaser cards by the server-supplied order.
  void applyTeaserRerank(
    document.querySelector<HTMLElement>('[data-personalize="teaser-rerank"]'),
    env.teaserOrder ?? [],
    fetchMissingCards
  );
}
