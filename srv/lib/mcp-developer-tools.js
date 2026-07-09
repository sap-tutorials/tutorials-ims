// srv/lib/mcp-developer-tools.js
//
// Handlers for the 5 authenticated MCP curated tools on DeveloperService.
// Wired via developer-service.js init(). (#1105 Task 11)

import cds from '@sap/cds';
import { resolveDbUser } from './resolve-db-user.js';
import { sliceStep } from './tutorial-step-slicer.js';
import { assertEnum, clampLimit } from './mcp-arg-validators.js';
import * as store from './mcp-progress-store.js';

const LOG = cds.log('mcp-dev');

const STATUS_TUT = ['in_progress', 'completed', 'all'];
const STATUS_MIS = ['in_progress', 'completed', 'not_started', 'all'];
const WHEN_EVT   = ['upcoming', 'past', 'registered'];

async function requireDbUser(req) {
  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) {
    // WARN-log the miss so a stale-OAuth-clientId or unmigrated user shows up
    // in logs rather than a silent 401 (see resolveDbUser silent-resolution
    // fact / #1049). req.reject throws, so callers never see a return value.
    LOG.warn('[mcp-dev] resolveDbUser miss', { userId: req.user?.id, tokenSource: req.user?.tokenSource });
    return req.reject(401, 'unable to resolve user');
  }
  return dbUser;
}

export async function handleGetMyTutorials(req) {
  const status = req.data.status ?? 'all';
  try { assertEnum({ name: 'status', value: status, allowed: STATUS_TUT }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 20, 50);
  const dbUser = await requireDbUser(req);
  if (dbUser === undefined) return; // unreachable (req.reject throws) — defensive for mock contexts
  return store.getMyTutorials(req.user, { status, limit });
}

export async function handleGetMyMissions(req) {
  const status = req.data.status ?? 'all';
  try { assertEnum({ name: 'status', value: status, allowed: STATUS_MIS }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 10, 50);
  const dbUser = await requireDbUser(req);
  if (dbUser === undefined) return; // unreachable (req.reject throws) — defensive
  return store.getMyMissions(req.user, { status, limit });
}

export async function handleGetMyEvents(req) {
  const when = req.data.when ?? 'upcoming';
  try { assertEnum({ name: 'when', value: when, allowed: WHEN_EVT }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 20, 50);
  const dbUser = await requireDbUser(req);
  if (dbUser === undefined) return; // unreachable (req.reject throws) — defensive
  return store.getMyEvents(req.user, { when, limit });
}

export async function handleGetMyCompletedSteps(req) {
  const { slug } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  const dbUser = await requireDbUser(req);
  if (dbUser === undefined) return; // unreachable (req.reject throws) — defensive
  const result = await store.getMyCompletedSteps(req.user, slug.toLowerCase());
  if (result === null) return req.reject(404, `tutorial not found: ${slug}`);
  return result;
}

/** Also re-used by SearchService (anonymous mount) via the same handler symbol. */
export async function handleGetTutorialStep(req) {
  const { slug, stepNumber } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  if (!Number.isInteger(stepNumber) || stepNumber < 1)
    return req.reject(400, 'stepNumber must be a positive integer');
  const slice = await sliceStep(slug.toLowerCase(), stepNumber);
  if (!slice) return req.reject(404, 'step not found');
  return {
    slug: slug.toLowerCase(),
    stepNumber,
    stepTitle: slice.stepTitle,
    html:      slice.html,
    textLength: slice.text.length,
    totalSteps: slice.totalSteps,
  };
}

/**
 * complete_step is a pure delegation to the existing completeStep action.
 * One code path so the audit trail fires identically for browser and MCP callers.
 *
 * PAT scope gate: a PAT with scopes=['read'] only must NOT be allowed to mutate
 * progress. JWT/OAuth callers (browser) have no tokenSource and are always allowed.
 */
export async function handleCompleteStep(req) {
  // Scope gate: PAT callers must carry the 'pat-write' pseudo-role.
  // JWT/OAuth callers (tokenSource !== 'pat') are unaffected.
  if (req.user?.tokenSource === 'pat' && !req.user.is('pat-write')) {
    return req.reject(403, 'this token lacks write scope');
  }
  const { slug, stepNumber } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  if (!Number.isInteger(stepNumber) || stepNumber < 1)
    return req.reject(400, 'stepNumber must be a positive integer');
  const srv = (req._?.service) ?? cds.services.DeveloperService;
  return srv.send({
    event: 'completeStep',
    data: { slug: slug.toLowerCase(), stepNumber },
    user: req.user,
  });
}

/**
 * reset_tutorial_progress is a pure delegation to the existing
 * resetTutorialProgress action. The existing handler emits the
 * TutorialProgressReset audit event with the tokenSource field from req.user
 * (set by the PAT middleware, or null for JWT/OAuth callers).
 *
 * PAT scope gate: read-only PATs are rejected with 403.
 */
export async function handleResetTutorialProgress(req) {
  // Scope gate: PAT callers must carry the 'pat-write' pseudo-role.
  // JWT/OAuth callers (tokenSource !== 'pat') are unaffected.
  if (req.user?.tokenSource === 'pat' && !req.user.is('pat-write')) {
    return req.reject(403, 'this token lacks write scope');
  }
  const { slug } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  const srv = (req._?.service) ?? cds.services.DeveloperService;
  return srv.send({
    event: 'resetTutorialProgress',
    data: { slug: slug.toLowerCase() },
    user: req.user,
  });
}
