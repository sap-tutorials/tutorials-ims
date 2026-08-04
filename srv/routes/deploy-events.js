// srv/routes/deploy-events.js
//
// POST /ops/deploy-event — operational endpoint pinged by scripts/deploy-mta.cjs
// at each deploy lifecycle boundary (start/end/fail). Bearer-guarded upstream by
// contentAuthMiddleware (CONTENT_API_KEY). Fail-open: always 202 on a well-formed
// request; alerting.raise is fire-and-forget and never blocks the response.
// Spec: docs/superpowers/specs/2026-08-04-deploy-lifecycle-alerts-design.md
import cds from '@sap/cds';
import express from 'express';
import * as alerting from '../lib/alerting.js';

const LOG = cds.log('deploy-events');

const PHASE_MAP = {
  start: { eventType: 'DeployStarted',  severity: 'NOTICE', verb: 'started'  },
  end:   { eventType: 'DeployFinished', severity: 'NOTICE', verb: 'finished' },
  fail:  { eventType: 'DeployFailed',   severity: 'ERROR',  verb: 'FAILED'   },
};

export function phaseToPayload(phase, { env, version, detail } = {}) {
  const m = PHASE_MAP[phase];
  if (!m) return null;
  const envLabel = env || 'unknown';
  const verSuffix = version ? ` ${version}` : '';
  return {
    eventType: m.eventType,
    severity: m.severity,
    category: 'ALERT',
    subject: `Deploy ${m.verb} — ${envLabel}${verSuffix}`,
    body: detail || `Deploy ${m.verb} for ${envLabel}${verSuffix}.`,
    resource: { resourceName: `deploy-${envLabel}`, resourceType: 'deployment' },
  };
}

async function handler(req, res) {
  const { phase, env, version, detail } = req.body || {};
  const payload = phaseToPayload(phase, { env, version, detail });
  if (!payload) {
    return res.status(400).json({ error: 'invalid or missing "phase" (start|end|fail)' });
  }
  // Fire-and-forget; alerting.raise is itself fail-open. Never block the deploy.
  alerting.raise(payload).catch((err) => LOG.warn('deploy-event raise failed (swallowed):', err?.message ?? err));
  LOG.info(`deploy-event ${phase} env=${env ?? '?'} version=${version ?? '?'}`);
  return res.status(202).json({ ok: true });
}

export function register(app, { authMw } = {}) {
  const parse = express.json({ limit: '16kb' });
  const chain = authMw ? [parse, authMw, handler] : [parse, handler];
  app.post('/ops/deploy-event', ...chain);
}
