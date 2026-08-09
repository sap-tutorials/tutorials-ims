// Express middleware backing GET /build/concepts.
// Pattern matches srv/lib/build-catalog.js. Unauthenticated by design.
// Shares buildConceptsPayload with the CAP concept-render pipeline
// (concept-list-page.js + publish-concepts.js, #1327).

import cds from '@sap/cds';
import { buildConceptsPayload } from './published-concepts-query.js';

const log = cds.log('build-concepts');

export async function buildConceptsHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const payload = await buildConceptsPayload(db);
    // Shared, non-personalized feed — 60s edge cache like the other /build/* feeds.
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    log.error('failed to build /build/concepts payload', err);
    res.status(500).json({ error: 'Build concepts query failed' });
  }
}
