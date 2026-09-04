// Public read endpoint for per-event logo lockups (#2133).
// Mounted at GET /api/event-logo?eventLegacyId=N. NO auth — the event-display
// kiosk page and the app-space page (both may be viewed anonymously) render the
// logo via a plain <img src>. Mirrors the anonymous banner handler in
// srv/routes/devtoberfest-public.js.

import cds from '@sap/cds';

const LOG = cds.log('event-logo');

async function logoHandler(req, res) {
  try {
    const legacyId = parseInt(req.query?.eventLegacyId, 10);
    if (!Number.isFinite(legacyId)) return res.status(400).end();

    await cds.connect.to('db');
    const { Events } = cds.entities('com.sap.developers.ims');
    const event = await SELECT.one.from(Events).columns('ID', 'hasLogo').where({ legacyId });
    if (!event?.hasLogo) return res.status(404).end();

    // Imported lazily so this module carries no sharp dependency at boot — the
    // store's fetchLogo path does not touch sharp, but keeping the import local
    // matches the srv-qa boot-safety pattern for content-store-reachable libs.
    const { fetchLogo } = await import('../lib/event-logo-store.js');
    const out = await fetchLogo(event.ID);
    if (!out) return res.status(404).end();

    res.setHeader('ETag', out.etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.headers['if-none-match'] === out.etag) return res.status(304).end();
    res.setHeader('Content-Type', out.mimeType);
    return res.send(out.buffer);
  } catch (err) {
    LOG.error('GET /api/event-logo failed:', err);
    return res.status(500).end();
  }
}

export function register(app) {
  app.get('/api/event-logo', logoHandler);
}

export { logoHandler };
