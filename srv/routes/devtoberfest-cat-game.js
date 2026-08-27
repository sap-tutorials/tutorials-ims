// Auth-gated endpoint for the "Hit the Cat" mini-game (issue #2042):
//   POST /api/devtoberfest/cat-game/award — grant today's cat-game points.
//
// Rules (see srv/lib/cat-game-award.js): 5 points/day, once per day, capped at
// 100 total per event, and ONLY while the active Devtoberfest event is running
// (now within [startDate, endDate]). Outside that window the endpoint responds
// 200 { awarded:false, reason:'inactive' } so the game degrades to a harmless
// meow-only Easter egg rather than erroring.
//
// Same prefix/approuter route block + auth idiom as devtoberfest-auth.js
// (/api/devtoberfest/join). Anonymous → 401.

import cds from '@sap/cds';
import express from 'express';
import { resolveUser } from '../lib/resolve-user.js';
import { provisionDbUser } from '../lib/resolve-db-user.js';
import { awardCatGamePoints, eventIsLive, MAX_POINTS } from '../lib/cat-game-award.js';

const LOG = cds.log('devtoberfest');

async function awardHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    const db = await cds.connect.to('db');
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
    if (!config?.currentEvent_ID) {
      return res.status(200).json({ awarded: false, reason: 'inactive' });
    }
    const event = await SELECT.one.from(Events).where({ ID: config.currentEvent_ID });
    if (!eventIsLive(event)) {
      return res.status(200).json({ awarded: false, reason: 'inactive' });
    }

    // Get-or-create the caller's Users row from their own JWT claims.
    const dbUser = await provisionDbUser(user, ['ID']);
    if (!dbUser?.ID) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    // Never shared-cache: response carries per-user award state.
    res.setHeader('Cache-Control', 'no-store');

    const result = await awardCatGamePoints(db, { userId: dbUser.ID, event });
    return res.status(200).json(result);
  } catch (err) {
    LOG.error('POST /api/devtoberfest/cat-game/award failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  // context+auth middlewares REQUIRED so resolveUser sees the JWT (same idiom as
  // devtoberfest-auth.js). Body is optional/ignored; keep a tiny json limit.
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw    = cds.middlewares?.auth?.()    || ((req, _res, next) => next());
  app.post('/api/devtoberfest/cat-game/award',
    express.json({ limit: '4kb' }), _contextMw, _authMw, awardHandler);
}

export { awardHandler, eventIsLive, MAX_POINTS };
