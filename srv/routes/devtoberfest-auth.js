// Auth-gated endpoints for the Devtoberfest homepage:
//   POST /api/devtoberfest/join — record this year's registration
//   GET  /api/devtoberfest/me   — return caller's registration state
//
// Both require an authenticated user (XSUAA in production; mock-auth
// in tests). resolveUser() from PR #557 handles the deployed-XSUAA +
// multer async-context gap. resolveUserSapId() (PR #535) bridges to
// the Users.sapId column — never compare req.user.id directly.
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';
import express from 'express';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';
import { getNextLegacyId } from '../lib/legacy-id.js';

const LOG = cds.log('devtoberfest');

async function meHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    const sapId = resolveUserSapId(user);
    if (!sapId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    await cds.connect.to('db');
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
    if (!dbUser) {
      return res.status(200).json({ joined: false });
    }

    const reg = await SELECT.one.from(EventRegistrations)
      .columns('joinedAt', 'termsVersion')
      .where({
        user_ID: dbUser.ID,
        event_ID: config.currentEvent_ID,
      });
    if (!reg) return res.status(200).json({ joined: false });

    return res.status(200).json({
      joined: true,
      joinedAt: reg.joinedAt,
      termsVersion: reg.termsVersion,
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/me failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function joinHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    const sapId = resolveUserSapId(user);
    if (!sapId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    const submittedVersion = Number(req.body?.termsVersion);
    if (!Number.isInteger(submittedVersion) || submittedVersion <= 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'termsVersion required' });
    }

    const db = await cds.connect.to('db');
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    if (config.termsVersion !== submittedVersion) {
      return res.status(412).json({ error: 'TERMS_OUTDATED', current: config.termsVersion });
    }

    const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
    if (!dbUser) {
      return res.status(403).json({ error: 'USER_NOT_IN_DB' });
    }

    const now = new Date().toISOString();
    try {
      await INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: dbUser.ID,
        event_ID: config.currentEvent_ID,
        joinedAt: now,
        termsVersion: submittedVersion,
        termsAcceptedAt: now,
        legacyId: await getNextLegacyId('EventRegistrations', db),
      });
    } catch (err) {
      if (err.code === 'UNIQUE_CONSTRAINT_VIOLATION' || /unique|duplicate/i.test(err.message || '')) {
        return res.status(409).json({ error: 'ALREADY_JOINED' });
      }
      throw err;
    }

    // Audit-log: same shape as _executeAnonymization (PR #554).
    try {
      const audit = await cds.connect.to('audit-log');
      await audit.log('SecurityEvent', {
        data: {
          action: 'DevtoberfestJoin',
          sapId,
          eventId: config.currentEvent_ID,
          termsVersion: submittedVersion,
        },
      });
    } catch (auditErr) {
      // Audit failure must not break the join (mirrors PR #554's
      // pattern — the join itself is the canonical record).
      LOG.warn('audit-log failed for POST /api/devtoberfest/join (non-fatal):', auditErr.message);
    }

    return res.status(201).json({ joined: true, termsVersion: submittedVersion });
  } catch (err) {
    LOG.error('POST /api/devtoberfest/join failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  // context+auth middlewares are REQUIRED — without them req.user / cds.context.user
  // never gets populated and resolveUser would always return null (false 401s).
  // Same idiom as srv/server.js:272-277 (analytics export) and devtoberfest-public.js.
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw    = cds.middlewares?.auth?.()    || ((req, _res, next) => next());
  app.get('/api/devtoberfest/me',    _contextMw, _authMw, meHandler);
  app.post('/api/devtoberfest/join', express.json({ limit: '8kb' }), _contextMw, _authMw, joinHandler);
}

export { meHandler, joinHandler };
