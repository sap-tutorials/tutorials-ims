import cds from '@sap/cds';
import { createHash } from 'node:crypto';

const FEATURED_LIMIT = 6;
const CACHE_MS = 60_000;
let _cache = { at: 0, payload: null };

export function resolveFeatured(f, { missionByLegacyId, groupByLegacyId, tutorialByLegacyId }) {
  if (f.taskType === 'MISSION') {
    const m = missionByLegacyId.get(f.taskLegacyId);
    if (!m) return null;
    return { type: 'mission', slug: m.slug || String(m.legacyId), title: m.title || '', description: m.description || '' };
  }
  if (f.taskType === 'GROUP') {
    const g = groupByLegacyId.get(f.taskLegacyId);
    if (!g || !g.slug) return null;
    return { type: 'group', slug: g.slug, title: g.title || '', description: g.description || '' };
  }
  if (f.taskType === 'TUTORIAL') {
    const t = tutorialByLegacyId.get(f.taskLegacyId);
    if (!t || !t.slug) return null;
    return { type: 'tutorial', slug: t.slug, title: t.title || '', description: t.description || '' };
  }
  return null;
}

export async function fetchFeatured(db) {
  const { Missions, Groups, Tutorials, FeaturedTasks } = cds.entities('com.sap.developers.ims');
  const rows = await db.run(SELECT.from(FeaturedTasks).orderBy('featuredOrder').limit(FEATURED_LIMIT));
  if (!rows.length) return [];
  const missions  = await db.run(SELECT.from(Missions).columns('legacyId', 'slug', 'title', 'description').where({ published: true }));
  const groups    = await db.run(SELECT.from(Groups).columns('legacyId', 'slug', 'title', 'description'));
  const tutorials = await db.run(SELECT.from(Tutorials).columns('legacyId', 'slug', 'title', 'description').where(`status = 'ACTIVE' or status is null`));
  const maps = {
    missionByLegacyId:  new Map(missions.map(m => [m.legacyId, m])),
    groupByLegacyId:    new Map(groups.map(g => [g.legacyId, g])),
    tutorialByLegacyId: new Map(tutorials.map(t => [t.legacyId, t])),
  };
  return rows.map(r => resolveFeatured(r, maps)).filter(Boolean);
}

export function computeFeaturedEtag(list) {
  const sig = JSON.stringify(list.map(f => `${f.type}:${f.slug}`));
  return `"${createHash('sha256').update(sig).digest('hex').slice(0, 16)}"`;
}

export async function getFeaturedPayload(db) {
  const now = Date.now();
  if (_cache.payload && (now - _cache.at) < CACHE_MS) return _cache.payload;
  const featured = await fetchFeatured(db);
  const payload = { featured, etag: computeFeaturedEtag(featured), computedAt: new Date().toISOString() };
  _cache = { at: now, payload };
  return payload;
}

export function resetFeaturedCache() {
  _cache = { at: 0, payload: null };
}
