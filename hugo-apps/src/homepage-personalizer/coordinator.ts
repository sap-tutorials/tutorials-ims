import { readSessionCache, writeSessionCache, type Envelope } from './session-cache';

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
    if (isDefaultViewActive()) return;
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
function applyEnvelope(_env: Envelope): void { /* Task 10 */ }
