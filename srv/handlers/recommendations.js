// srv/handlers/recommendations.js
import cds from '@sap/cds';
import { recommend } from '../lib/recommend.js';
import { computeCoCompletions } from '../lib/co-completion.js';
import { getUserProgress } from '../lib/user-progress.js';
import { getCentroid } from '../lib/tutorial-centroid.js';
import { loadStepVectors } from '../lib/step-vectors.js';

const LOG = cds.log('recommend');

async function loadAllTutorials() {
  const { Tutorials, ContentManifest } = cds.entities('com.sap.developers.ims');
  const tutorials = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'title', 'primaryTag', 'averageTimeToComplete as time')
    .where(`status = 'ACTIVE' or status is null`);
  // Published = has an ACTIVE manifest entry for the slug.
  let publishedSlugs = new Set();
  try {
    const rows = await SELECT.from(ContentManifest)
      .columns('slug')
      .where({ status: 'ACTIVE' });
    publishedSlugs = new Set(rows.map(r => r.slug));
  } catch (err) {
    LOG.warn('publishedSlugs lookup failed; treating all tutorials as published', err.message);
  }
  return tutorials
    .filter(t => !!t.slug)
    .map(t => ({ ...t, published: publishedSlugs.size === 0 ? true : publishedSlugs.has(t.slug) }));
}

const DEPS = {
  loadAllTutorials,
  loadCentroid: (id) => getCentroid(id, loadStepVectors),
  loadCoCompletions: () => computeCoCompletions().catch(err => { LOG.warn('co-completion failed', err.message); return {}; }),
  loadUserProgress: (user) => user ? getUserProgress(user) : Promise.resolve({ completedSlugs: [] })
};

export async function recommendationsHandler(req, res) {
  const start = Date.now();
  try {
    const slug = req.query?.slug;
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'slug query parameter is required' });
    }
    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(6, limitRaw)) : 3;

    const user = (req.user && req.user.id && req.user.id !== 'anonymous') ? req.user : null;

    const result = await recommend({ currentSlug: slug, user, limit }, DEPS);
    if (result.reason === 'unknown_slug') {
      return res.status(404).json({ error: 'unknown slug', currentSlug: slug });
    }
    LOG.info(`slug=${slug} user=${user ? 'auth' : 'anon'} personalized=${result.personalized} count=${result.recommendations.length} durationMs=${Date.now() - start}`);
    res.json(result);
  } catch (err) {
    LOG.error('recommendations handler failed', err.message);
    res.status(500).json({ error: 'recommendations failed' });
  }
}
