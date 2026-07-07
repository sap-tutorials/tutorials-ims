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
    subscribeBroadcast(payload.hash, (next) => applyEnvelope(next));
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
