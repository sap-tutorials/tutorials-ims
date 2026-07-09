// srv/lib/mcp-homepage-tools.js
//
// Authenticated recommendation MCP handlers for HomepageService.
// Persona-weighted from HomepageForYouCandidates — same logic as the
// homepage personalized() action. (#1105 Task 13)

import cds from '@sap/cds';
import { resolveUserSapId } from './resolve-db-user.js';
import { rankForYou, isHidden } from './homepage/persona-scoring.js';
import { clampLimit } from './mcp-arg-validators.js';
import * as metrics from './metrics.js';

const LOG = cds.log('mcp-homepage');
const NS  = 'com.sap.developers.ims';
const SVC = 'HomepageService';

function tokenSource(req) {
  return req.user?.tokenSource ?? 'anon';
}

async function withToolMetrics(tool, req, fn) {
  const ts = tokenSource(req);
  try {
    const result = await fn();
    metrics.counter(`mcp.tool[service=${SVC},tool=${tool},tokenSource=${ts},outcome=ok]`);
    return result;
  } catch (err) {
    metrics.counter(`mcp.tool[service=${SVC},tool=${tool},tokenSource=${ts},outcome=error]`);
    throw err;
  }
}

/**
 * Resolve the user's persona profile from UserLearningPreferences.
 * Returns {role, deployment, cloud} with nulls for unknown/anonymous users.
 * Mirrors homepage-service.js:676-708 (the personalized() handler pattern).
 */
async function resolvePersona(req) {
  const { Users, UserLearningPreferences } = cds.entities(NS);
  const sapId  = resolveUserSapId(req.user);
  const dbUser = sapId
    ? await SELECT.one.from(Users).columns('ID').where({ sapId })
    : null;
  const prefs = dbUser?.ID
    ? await SELECT.one.from(UserLearningPreferences)
        .where({ user_ID: dbUser.ID })
        .columns('deployment', 'role', 'cloud')
    : null;
  return {
    role:       prefs?.role       ?? null,
    deployment: prefs?.deployment ?? null,
    cloud:      prefs?.cloud      ?? null,
  };
}

/** Get persona-ranked candidates from HomepageForYouCandidates. */
async function fetchRankedCandidates(profile, kind, limit) {
  const { HomepageForYouCandidates } = cds.entities(NS);
  const candidates = await SELECT.from(HomepageForYouCandidates)
    .where({ active: true })
    .columns('ID', 'kind', 'targetSlug', 'title', 'description',
             'personaTags', 'personaWeight', 'personaHidden', 'sortOrder');

  const shape = (c) => ({
    slug:        c.targetSlug ?? null,
    title:       c.title      ?? null,
    description: c.description ?? null,
  });

  // Persona-weighted path: rankForYou scores by persona-tag overlap.
  const ranked = rankForYou(candidates, profile, { min: 0, max: limit * 4 })
    .filter(c => c.kind === kind);

  // Fallback: rankForYou returns nothing when the profile has no persona tags
  // (brand-new user, or one who never set UserLearningPreferences). A "my
  // recommendations" tool must still surface something rather than an empty
  // list, so degrade to the unweighted active pool sorted by admin-curated
  // sortOrder. (Controller decision on Task 13 review — new users get the
  // curated default set, not an empty envelope.)
  //
  // Still honor personaHidden: rankForYou excludes hidden candidates, so the
  // fallback must too, or a candidate explicitly hidden for this persona would
  // reappear via the fallback path (security-review finding on Task 13).
  if (ranked.length === 0) {
    return candidates
      .filter(c => c.kind === kind && !isHidden(c, profile))
      .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100))
      .slice(0, limit)
      .map(shape);
  }

  return ranked.slice(0, limit).map(shape);
}

/**
 * get_my_recommended_tutorials — return persona-ranked tutorial recommendations.
 * Authenticated (HomepageService @requires:'authenticated-user').
 */
export async function handleGetMyRecommendedTutorials(req) {
  return withToolMetrics('get_my_recommended_tutorials', req, async () => {
    const limit = clampLimit(req.data.limit, 10, 20);
    const profile = await resolvePersona(req);
    LOG.debug('[get_my_recommended_tutorials] limit=%d profile=%o', limit, profile);
    return fetchRankedCandidates(profile, 'tutorial', limit);
  });
}

/**
 * get_my_recommended_missions — return persona-ranked mission recommendations.
 * Authenticated (HomepageService @requires:'authenticated-user').
 */
export async function handleGetMyRecommendedMissions(req) {
  return withToolMetrics('get_my_recommended_missions', req, async () => {
    const limit = clampLimit(req.data.limit, 5, 10);
    const profile = await resolvePersona(req);
    LOG.debug('[get_my_recommended_missions] limit=%d profile=%o', limit, profile);
    return fetchRankedCandidates(profile, 'mission', limit);
  });
}
