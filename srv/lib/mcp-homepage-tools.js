// srv/lib/mcp-homepage-tools.js
//
// Authenticated recommendation MCP handlers for HomepageService.
// Persona-weighted from HomepageForYouCandidates — same logic as the
// homepage personalized() action. (#1105 Task 13)

import cds from '@sap/cds';
import { resolveUserSapId } from './resolve-db-user.js';
import { rankForYou } from './homepage/persona-scoring.js';
import { clampLimit } from './mcp-arg-validators.js';

const LOG = cds.log('mcp-homepage');
const NS  = 'com.sap.developers.ims';

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

  // rankForYou returns entries that match persona tags, sorted by score+sortOrder.
  // min:0 so we return results even when persona has no tags (profile all-null).
  const ranked = rankForYou(candidates, profile, { min: 0, max: limit * 4 });
  return ranked
    .filter(c => c.kind === kind)
    .slice(0, limit)
    .map(c => ({
      slug:        c.targetSlug ?? null,
      title:       c.title      ?? null,
      description: c.description ?? null,
    }));
}

/**
 * get_my_recommended_tutorials — return persona-ranked tutorial recommendations.
 * Authenticated (HomepageService @requires:'authenticated-user').
 */
export async function handleGetMyRecommendedTutorials(req) {
  const limit = clampLimit(req.data.limit, 10, 20);
  const profile = await resolvePersona(req);
  LOG.debug('[get_my_recommended_tutorials] limit=%d profile=%o', limit, profile);
  return fetchRankedCandidates(profile, 'tutorial', limit);
}

/**
 * get_my_recommended_missions — return persona-ranked mission recommendations.
 * Authenticated (HomepageService @requires:'authenticated-user').
 */
export async function handleGetMyRecommendedMissions(req) {
  const limit = clampLimit(req.data.limit, 5, 10);
  const profile = await resolvePersona(req);
  LOG.debug('[get_my_recommended_missions] limit=%d profile=%o', limit, profile);
  return fetchRankedCandidates(profile, 'mission', limit);
}
