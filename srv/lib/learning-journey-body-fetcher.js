// srv/lib/learning-journey-body-fetcher.js
//
// Phase 4.1 (#447): tiered scraper for learning.sap.com/learning-journeys/<slug>.
//
// Tier 1: known SAP class selector. Returns body if non-empty.
// Tier 2: readability extraction (3 longest paragraphs, >200 chars total).
// Tier 3: empty body, source='metadata' (the cron job falls back to title-only
//         prompts for these journeys).
//
// Per-tier failure isolation: 3-attempt retry per HTTP call. After 3 failed
// attempts, return {body: '', source: 'metadata'} so the cron job can continue.
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.1-learning-journeys.md §2.4 + Q7

const STRUCTURED_SELECTOR_RE = /<div\s+[^>]*class=["'][^"']*\blj-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const RETRY_DELAYS_MS = [200, 1000, 5000];
const MIN_READABILITY_LEN = 200;
const TIMEOUT_MS = 5000;

let mockFetcher = null;

async function fetchHtml(url) {
  if (mockFetcher) return mockFetcher(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // When a mock fetcher is installed (unit-test path), skip the backoff
      // so retry tests don't add seconds of real wait. Production paths
      // always exercise the real delays.
      if (!mockFetcher) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }
    }
    try {
      return await fetchHtml(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function stripTags(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTier1(html) {
  const match = html.match(STRUCTURED_SELECTOR_RE);
  if (!match) return null;
  const inner = stripTags(match[1]);
  return inner.length > 0 ? inner : null;
}

function extractTier2(html) {
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripTags(m[1]))
    .filter(t => t.length >= 50)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (paragraphs.length === 0) return null;
  const combined = paragraphs.join('\n\n');
  return combined.length >= MIN_READABILITY_LEN ? combined : null;
}

/**
 * @param {string} url
 * @returns {Promise<{body: string, source: 'structured'|'readability'|'metadata'}>}
 */
export async function fetchJourneyBody(url) {
  let html;
  try {
    html = await fetchWithRetry(url);
  } catch {
    return { body: '', source: 'metadata' };
  }

  const tier1 = extractTier1(html);
  if (tier1) return { body: tier1, source: 'structured' };

  const tier2 = extractTier2(html);
  if (tier2) return { body: tier2, source: 'readability' };

  return { body: '', source: 'metadata' };
}

// Test hook
export function _setMockFetcher(fn) {
  mockFetcher = fn;
}
