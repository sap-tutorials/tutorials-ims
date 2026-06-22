// Public read endpoints for the Devtoberfest homepage island.
// Mounted at /api/devtoberfest/{status,terms}. NO auth — anonymous
// users see the page and the JOIN button (which is gated separately
// by /api/devtoberfest/join requiring XSUAA).
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';
import { ensureDevtoberfestConfigSingleton } from '../lib/devtoberfest-singleton.js';

const LOG = cds.log('devtoberfest');

async function statusHandler(req, res) {
  try {
    await cds.connect.to('db');
    await ensureDevtoberfestConfigSingleton();
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const event = await SELECT.one.from(Events).where({ ID: config.currentEvent_ID });
    // TODO Task 4: resolve joined + termsRequired per caller.
    return res.status(200).json({
      event: event ? { name: event.name, startDate: event.startDate, endDate: event.endDate } : null,
      joined: false,
      termsVersion: config.termsVersion,
      termsRequired: true,
      contentRulesUrl: config.contentRulesUrl || '',
      faqUrl: config.faqUrl || '',
      gameboardUrl: config.gameboardUrl || '',
      activitiesUrl: config.activitiesUrl || '',
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/status failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  app.get('/api/devtoberfest/status', statusHandler);
  // /api/devtoberfest/terms wired in Task 5.
}

export { statusHandler };
