// srv/lib/recommend.js
import { getCentroid } from './tutorial-centroid.js';

export const RANKING_WEIGHTS = { sim: 0.6, co: 0.4 };
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1024;

const cache = new Map(); // key -> { value, at }
export function __resetForTest() { cache.clear(); }

function cosineNorm(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return (dot / denom + 1) / 2;
}

export async function recommend({ currentSlug, user, limit = 3 }, deps) {
  if (!currentSlug) throw new Error('currentSlug required');
  const cap = Math.max(1, Math.min(6, limit | 0));
  const key = `${currentSlug}:${user?.id || 'anon'}:${cap}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const all = await deps.loadAllTutorials();
  const current = all.find(t => t.slug === currentSlug);
  if (!current) {
    const out = { currentSlug, personalized: false, recommendations: [], reason: 'unknown_slug' };
    storeCache(key, out, now);
    return out;
  }

  const curCentroid = await deps.loadCentroid(current.ID);
  if (!curCentroid) {
    const out = { currentSlug, personalized: false, recommendations: [], reason: 'no_embedding' };
    storeCache(key, out, now);
    return out;
  }

  const coAll = await safeCo(deps);
  const coForCurrent = coAll[currentSlug] || [];
  const coBySlug = new Map(coForCurrent.map(x => [x.slug, x.score]));
  const coMax = coForCurrent.reduce((m, x) => Math.max(m, x.score), 0) || 1;

  const completedSlugs = new Set((await deps.loadUserProgress(user))?.completedSlugs || []);

  const scored = [];
  for (const c of all) {
    if (c.slug === currentSlug) continue;
    if (c.published === false) continue;
    const cCentroid = await deps.loadCentroid(c.ID);
    const sim = cosineNorm(curCentroid, cCentroid);
    const co = (coBySlug.get(c.slug) || 0) / coMax;
    const score = RANKING_WEIGHTS.sim * sim + RANKING_WEIGHTS.co * co;
    scored.push({ slug: c.slug, title: c.title, primaryTag: c.primaryTag, time: c.time, score, _completed: completedSlugs.has(c.slug) });
  }

  const filtered = user ? scored.filter(s => !s._completed) : scored;
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aSame = a.primaryTag === current.primaryTag ? 1 : 0;
    const bSame = b.primaryTag === current.primaryTag ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    return a.title.localeCompare(b.title);
  });

  const filteredDropped = user && filtered.length < scored.length;
  const recommendations = filtered.slice(0, cap).map(({ _completed, ...rest }) => rest);

  const out = { currentSlug, personalized: !!filteredDropped, recommendations };
  storeCache(key, out, now);
  return out;
}

async function safeCo(deps) {
  try { return await deps.loadCoCompletions(); }
  catch { return {}; }
}

function storeCache(key, value, at) {
  cache.set(key, { value, at });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Internal: re-export cosine helper for srv/lib/branch/ranker.js (issue #172).
// Underscore prefix marks it as a stable internal contract, not a public API.
export { cosineNorm as __cosineNorm };
