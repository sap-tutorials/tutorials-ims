// srv/lib/build-topics.js
import cds from '@sap/cds';
import { buildTopicsTreePayload, buildTopicDetailPayload } from './topics-query.js';

const log = cds.log('build-topics');

export async function buildTopicsTreeHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const payload = await buildTopicsTreePayload(db);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    log.error('failed to build /build/topics-tree payload', err);
    res.status(500).json({ error: 'Build topics query failed' });
  }
}

export async function buildTopicDetailHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const slug = String(req.params.slug || '').toLowerCase();
    const payload = await buildTopicDetailPayload(db, slug);
    res.set('Cache-Control', 'public, max-age=60');
    res.status(payload.notFound ? 404 : 200).json(payload);
  } catch (err) {
    log.error('failed to build /build/topics/:slug payload', err);
    res.status(500).json({ error: 'Build topic detail query failed' });
  }
}
