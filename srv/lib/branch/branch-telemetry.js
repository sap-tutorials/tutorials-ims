// srv/lib/branch/branch-telemetry.js
//
// Shared BranchDecisions telemetry writers used by:
//   - srv/lib/branch/mission-detail.js  (HTTP /build/mission/:slug; source='pageLoad')
//   - srv/lib/branch/decide.js          (HTTP /api/branches/decide; source='pageLoad' | 'click')
//   - srv/lib/branch/joule-tool.js      (chat tool getBranchRecommendation; source='jouleTool')
//
// All three call paths write the same row shape; consolidating prevents
// drift if the BranchDecisions schema gains new fields. (Issue #172 PR 4 —
// extracted during code-quality review.)
//
// Best-effort: try/catch + LOG.warn on failure. The caller's result is
// returned regardless — telemetry never blocks a recommendation response.

import cds from '@sap/cds';
import { resolveUserSapId } from '../resolve-db-user.js';

const LOG = cds.log('branch-telemetry');

async function resolveUserIdInternal(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  try {
    const { Users } = cds.entities('com.sap.developers.ims');
    const u = await SELECT.one.from(Users).columns('ID').where({ sapId });
    return u?.ID || null;
  } catch (err) {
    LOG.warn(`resolveUserIdInternal: ${err.message}`);
    return null;
  }
}

/**
 * Write a BranchDecisions row for a branch-point recommendation.
 *
 * @param {object} params
 * @param {object|null} params.user                    XSUAA user; null for anonymous
 * @param {'tutorialBranch'|'missionAltGroup'} params.surface
 * @param {string|null} params.missionSlug
 * @param {string|null} params.tutorialSlug
 * @param {string} params.branchPointId
 * @param {{picked, reason: {kind, source?, scores?}, confidence}} params.decision
 * @param {'pageLoad'|'click'|'jouleTool'} params.source
 */
export async function writeBranchDecision({
  user, surface, missionSlug, tutorialSlug, branchPointId, decision, source,
}) {
  try {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    const userIdInternal = await resolveUserIdInternal(user);
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface,
      missionSlug: missionSlug ?? null,
      tutorialSlug: tutorialSlug ?? null,
      branchPointId,
      recommendedKey: decision.picked,
      chosenKey: null,
      recommendationKind: decision.reason.kind,
      confidence: decision.confidence,
      source,
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions write failed: ${err.message}`);
  }
}

/**
 * Write a BranchDecisions row for a skip-step recommendation. Caller
 * should only invoke when result.skip === true.
 *
 * @param {object} params
 * @param {object|null} params.user
 * @param {string} params.tutorialSlug
 * @param {number} params.stepNumber
 * @param {{kind, source?, message?}} params.reason
 * @param {'pageLoad'|'click'|'jouleTool'} params.source
 */
export async function writeSkipDecision({
  user, tutorialSlug, stepNumber, reason, source,
}) {
  try {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    const userIdInternal = await resolveUserIdInternal(user);
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface: 'tutorialSkip',
      missionSlug: null,
      tutorialSlug,
      branchPointId: `step-${stepNumber}`,
      recommendedKey: 'skip',
      chosenKey: null,
      recommendationKind: reason.kind,
      confidence: 1.0,
      source,
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions skip write failed: ${err.message}`);
  }
}
