// Public read endpoint for the homepage SAP TechEd banner island (#2751).
// Mounted at GET /api/teched/event-status. NO auth — the homepage is viewed
// anonymously and the banner only needs the public event window (name + start
// + end) to drive its client-side countdown. Mirrors the anonymous read
// handlers in srv/routes/devtoberfest-public.js and event-logo-public.js.
//
// Unlike Devtoberfest there is no dedicated multi-row config entity for TechEd:
// the event dates live in a single production `Events` row. Its ID is fixed and
// public; it is read from TECHED_EVENT_ID (defaulting to the known production
// row) so a date change is an admin edit of that Events row, not a code change,
// and the row can be re-pointed per-environment without a redeploy.

import cds from '@sap/cds';

const LOG = cds.log('teched');

// Production TechEd event row (developers.sap.com /admin-ui/#/events). Overridable
// per environment via the TECHED_EVENT_ID env var.
const DEFAULT_TECHED_EVENT_ID = '1ee2a767-6e7f-4d20-af83-6ea8ae5ed15d';

async function eventStatusHandler(_req, res) {
  try {
    await cds.connect.to('db');
    const { Events } = cds.entities('com.sap.developers.ims');

    const eventId = process.env.TECHED_EVENT_ID || DEFAULT_TECHED_EVENT_ID;
    const event = await SELECT.one
      .from(Events)
      .columns('name', 'startDate', 'endDate')
      .where({ ID: eventId });

    if (!event) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    // Public, non-user-specific event window. Safe to edge-cache briefly; a
    // short TTL keeps an admin date edit visible within minutes while sparing
    // the DB a read per homepage hit. The island recomputes the live countdown
    // in the browser, so staleness here is bounded to the window endpoints.
    res.setHeader('Cache-Control', 'public, max-age=300');

    return res.status(200).json({
      event: { name: event.name, startDate: event.startDate, endDate: event.endDate },
    });
  } catch (err) {
    LOG.error('GET /api/teched/event-status failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  app.get('/api/teched/event-status', eventStatusHandler);
}

export { eventStatusHandler };
