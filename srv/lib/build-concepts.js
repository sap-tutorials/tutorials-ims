// Express middleware backing GET /build/concepts.
// Pattern matches srv/lib/build-catalog.js. Unauthenticated by design;
// consumed by scripts/fetch-concepts.ts at Hugo build time.

import cds from '@sap/cds';
import { buildConceptsPayload } from './published-concepts-query.js';

const log = cds.log('build-concepts');

export async function buildConceptsHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const payload = await buildConceptsPayload(db);
    res.json(payload);
  } catch (err) {
    log.error('failed to build /build/concepts payload', err);
    res.status(500).json({ error: 'Build concepts query failed' });
  }
}
