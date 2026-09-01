// srv/lib/build-topics.js
import cds from '@sap/cds';
import { buildTopicsTreePayload, buildTopicDetailPayload } from './topics-query.js';

export async function buildTopicsTreeHandler(req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicsTreePayload(db);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(payload);
}

export async function buildTopicDetailHandler(req, res) {
  const db = await cds.connect.to('db');
  const slug = String(req.params.slug || '').toLowerCase();
  const payload = await buildTopicDetailPayload(db, slug);
  res.set('Cache-Control', 'public, max-age=60');
  res.status(payload.notFound ? 404 : 200).json(payload);
}
