// srv/routes/alerts-public.js
//
// Public read endpoints for the alert system.
// Spec: docs/superpowers/specs/2026-06-26-548-alert-system-design.md
//
// GET /api/alerts        — anonymous; audience=ALL only.
// GET /api/alerts/me     — authenticated; ALL + AUTHENTICATED + ADMIN-if-admin.
//
// Both filter active=true AND startsAt <= now AND (endsAt IS NULL OR endsAt > now).
// Cached in-memory (alerts-cache.js); admin saves invalidate via after-hook.

import cds from '@sap/cds';
import { getCached, setCached } from '../lib/alerts-cache.js';

const log = cds.log('alerts');

function toResponseRow(r) {
  return {
    id: r.ID,
    title: r.title,
    body: r.body || null,
    severity: r.severity,
    ctaLabel: r.ctaLabel || null,
    ctaUrl: r.ctaUrl || null,
    dismissible: r.dismissible !== false,
    startsAt: r.startsAt,
    endsAt: r.endsAt || null,
  };
}

async function fetchAlerts(allowedAudiences) {
  const db = await cds.connect.to('db');
  const { Alerts } = cds.entities('com.sap.developers.ims');
  const nowIso = new Date().toISOString();

  // We fetch the candidate set with the cheap filters CDS QL handles cleanly
  // across dialects (active, audience IN, startsAt <= now), then drop expired
  // rows in JS. Doing the (endsAt IS NULL OR endsAt > now) branch in CQN
  // requires a nested expr that behaves differently between SQLite and HANA,
  // so a tiny JS filter on an already-narrowed result set is the safer call.
  const rows = await db.run(
    SELECT.from(Alerts).where({
      active: true,
      audience: { in: allowedAudiences },
      startsAt: { '<=': nowIso },
    }),
  );

  const now = Date.now();
  const visible = rows.filter((r) => {
    if (!r.endsAt) return true;
    return new Date(r.endsAt).getTime() > now;
  });

  // sort: newest startsAt first so the most recent campaign appears at top
  visible.sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));
  return visible.map(toResponseRow);
}

async function handlePublic(req, res) {
  try {
    let alerts = getCached('public:anon');
    if (!alerts) {
      alerts = await fetchAlerts(['ALL']);
      setCached('public:anon', alerts);
    }
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ alerts, fetchedAt: new Date().toISOString() });
  } catch (err) {
    log.error('GET /api/alerts failed', err);
    res.status(500).json({ error: 'internal' });
  }
}

async function handleAuthenticated(req, res) {
  const user = cds.context?.user;
  if (!user?.id || user.id === 'anonymous') {
    return res.status(401).json({ authenticated: false });
  }

  const isAdmin = typeof user.is === 'function' && user.is('Admin') === true;
  const cacheKey = isAdmin ? 'me:admin' : 'me:authenticated';
  const audiences = isAdmin
    ? ['ALL', 'AUTHENTICATED', 'ADMIN']
    : ['ALL', 'AUTHENTICATED'];

  try {
    let alerts = getCached(cacheKey);
    if (!alerts) {
      alerts = await fetchAlerts(audiences);
      setCached(cacheKey, alerts);
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ alerts, fetchedAt: new Date().toISOString() });
  } catch (err) {
    log.error('GET /api/alerts/me failed', err);
    res.status(500).json({ error: 'internal' });
  }
}

/**
 * Mount the alerts public routes on the given express app.
 *
 * For the authenticated route to receive `cds.context.user`, the app's
 * standard contextMw + authMw must be applied. The caller (srv/server.js)
 * passes them in. Unit tests skip the middlewares — the authenticated
 * handler then returns 401 because cds.context.user is empty, which is
 * the behaviour we want for the unauthenticated-path test.
 */
export function register(app, { contextMw, authMw } = {}) {
  app.get('/api/alerts', handlePublic);
  if (contextMw && authMw) {
    app.get('/api/alerts/me', contextMw, authMw, handleAuthenticated);
  } else {
    app.get('/api/alerts/me', handleAuthenticated);
  }
}
