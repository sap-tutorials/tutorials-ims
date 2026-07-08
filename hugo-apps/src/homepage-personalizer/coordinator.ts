import { readSessionCache, writeSessionCache, type Envelope } from './session-cache';
import { applyVerbOrder } from './verb-order';
import { renderBadge } from './personalized-badge';
import { mountForYou } from './mount-for-you';
import { applyShelfRerank } from './shelf-rerank';
import { subscribeBroadcast } from './prefs-broadcast';
import { beaconApplied } from './beacon';

const DEFAULT_FLAG_KEY = 'sap-devs-homepage-default';
const ENDPOINT = '/homepage/personalized';

export function isDefaultViewActive(): boolean {
  try {
    if (new URLSearchParams(location.search).get('default') === '1') return true;
    return sessionStorage.getItem(DEFAULT_FLAG_KEY) === '1';
  } catch { return false; }
}

// (#1093) The previous `looksSignedIn` (JSESSIONID cookie sniff) + `/me` probe
// were dead code on this deployment. Approuter session cookies are HttpOnly, so
// `document.cookie` is always empty; and `/me` falls through xs-app.json to
// Hugo's static "My Completions" page which returns 200 HTML for everyone.
// `/auth/user` is the XSUAA-gated JSON identity endpoint (see xs-app.json).
async function isSignedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    if (!r.ok) return false;
    if (!(r.headers.get('content-type') || '').includes('json')) return false;
    const body = await r.json();
    return !!body?.authenticated;
  } catch { return false; }
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
    // (#1093) Approuter returns 200 + HTML login page for stale sessions; do
    // not let `resp.json()` throw and get swallowed by the outer catch.
    if (!(resp.headers.get('content-type') || '').includes('json')) {
      // eslint-disable-next-line no-console
      console.warn('[homepage-personalizer] non-JSON response from', ENDPOINT, '— assuming auth expired');
      return;
    }

    const payload = (await resp.json()) as Envelope;
    writeSessionCache(payload);
    applyEnvelope(payload);
    subscribeBroadcast(payload.hash, (next) => applyEnvelope(next));
  } catch (e) {
    // (#1093) Bumped from console.debug — this branch was silently hiding auth
    // failures for months. Warn is the minimum bar for post-mortem visibility.
    // eslint-disable-next-line no-console
    console.warn('[homepage-personalizer] boot failed', e);
  }
}

// Replaced by Task 10 with the surface dispatcher.
function applyEnvelope(env: Envelope): void {
  applyVerbOrder(
    document.querySelector<HTMLElement>('[data-personalize="verb-order"]'),
    env.verbOrder ?? []
  );
  beaconApplied('verb-order');
  renderBadge(
    document.querySelector('.personalized-badge-slot'),
    env.profile ?? null,
    'personalized'
  );
  // (#763 Task 13) For-you row (Row 2b).
  mountForYou(
    document.querySelector<HTMLElement>('[data-personalize="for-you"]'),
    env.forYou ?? []
  );
  if ((env.forYou ?? []).length > 0) beaconApplied('for-you');
  // (#763 Task 14) Shelf rerank for verb sub-pages.
  applyShelfRerank(env.shelfOverrides);
  if (env.shelfOverrides) beaconApplied('shelf');
}
