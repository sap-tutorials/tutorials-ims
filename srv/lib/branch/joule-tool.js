// srv/lib/branch/joule-tool.js
//
// Issue #172 PR 4 — Joule chat tool that returns branch recommendations
// for a tutorial or mission. Composes its own engine queries directly
// (does NOT go through HTTP-shaped handlers like decide.js / mission-detail.js).
// Writes one BranchDecisions row per recommendation with source='jouleTool'.
//
// Spec: docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md §4.1
//
// Registered in srv/lib/chat-orchestrator.js when ChatSettings.branchingEnabled.

import cds from '@sap/cds';
import { pickBranch, evaluateSkip } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';

const LOG = cds.log('branch-joule-tool');

export const GET_BRANCH_RECOMMENDATION_TOOL = {
  type: 'function',
  function: {
    name: 'getBranchRecommendation',
    description: "When the user is on a tutorial or mission with branching, return which branch is recommended for them and why. Use this when the user asks 'which path should I take', 'what next in this mission', 'should I do the cloud or on-prem version', or similar. Do NOT use this to decide which branch is best — return the engine's existing recommendation with reason.",
    parameters: {
      type: 'object',
      properties: {
        missionSlug:   { type: 'string', description: 'When set, return alt-group recommendations for the mission.' },
        tutorialSlug:  { type: 'string', description: 'When set, return branchPoints + skipPoints for the tutorial.' },
        branchPointId: { type: 'string', description: 'Optional — narrow tutorial result to one branch point. Requires tutorialSlug.' },
      },
    },
  },
};

export async function getBranchRecommendationHandler({ args, user }) {
  // Lowercase slugs at handler entry per CLAUDE.md tutorial-slug rule.
  const missionSlug   = args?.missionSlug   ? String(args.missionSlug).toLowerCase()   : null;
  const tutorialSlug  = args?.tutorialSlug  ? String(args.tutorialSlug).toLowerCase()  : null;
  const branchPointId = args?.branchPointId ? String(args.branchPointId)               : null;

  if (!missionSlug && !tutorialSlug && !branchPointId) {
    return { error: 'requires_at_least_one_of: missionSlug, tutorialSlug, branchPointId' };
  }
  if (branchPointId && !tutorialSlug) {
    return { error: 'branchPointId requires tutorialSlug' };
  }

  try {
    const out = { branchPoints: [], altGroups: [], skipPoints: [] };
    const loaders = makeBranchLoaders();
    const userState = await buildUserState(user, loaders);

    if (tutorialSlug) {
      const tutorialResult = await resolveTutorialScope({
        tutorialSlug, branchPointId, user, userState, loaders,
      });
      if (tutorialResult.error) return tutorialResult;
      out.branchPoints = tutorialResult.branchPoints;
      out.skipPoints = tutorialResult.skipPoints;
      if (tutorialResult.note) out.note = tutorialResult.note;
    }

    // Mission scope (Task 3) lands here.

    return out;
  } catch (err) {
    LOG.error('getBranchRecommendationHandler', err);
    return { error: 'tool_failed' };
  }
}

async function resolveTutorialScope({ tutorialSlug, branchPointId, user, userState, loaders }) {
  const { BranchSpecs } = cds.entities('com.sap.developers.ims');
  const spec = await SELECT.one.from(BranchSpecs).where({ slug: tutorialSlug });
  if (!spec) {
    return { branchPoints: [], skipPoints: [], note: 'tutorial_has_no_branches' };
  }

  let branchPoints = [];
  let skipPoints = [];
  try { branchPoints = JSON.parse(spec.branchPoints ?? '[]'); }
  catch (err) { LOG.warn(`branchPoints parse failed for ${tutorialSlug}: ${err.message}`); }
  try { skipPoints = JSON.parse(spec.skipPoints ?? '[]'); }
  catch (err) { LOG.warn(`skipPoints parse failed for ${tutorialSlug}: ${err.message}`); }

  if (branchPointId) {
    branchPoints = branchPoints.filter(bp => bp.id === branchPointId);
    if (branchPoints.length === 0) {
      return { error: `unknown_branch_point: ${branchPointId}` };
    }
  }

  const outBranchPoints = [];
  for (const bp of branchPoints) {
    const branchPoint = {
      id: bp.id,
      surface: 'tutorialBranch',
      branches: bp.branches,
    };
    let decision;
    try {
      decision = await pickBranch(branchPoint, userState, { tutorialSlug }, {
        rankBranches: (b, s, c) => rankBranches(b, s, c, loaders),
      });
    } catch (err) {
      LOG.warn(`pickBranch failed for ${tutorialSlug}/${bp.id}: ${err.message}`);
      decision = { picked: bp.branches[0]?.key ?? null, reason: { kind: 'default' }, confidence: 0 };
    }
    outBranchPoints.push({
      id: bp.id,
      picked: decision.picked,
      reason: decision.reason,
      confidence: decision.confidence,
      allBranches: bp.branches.map(b => ({ key: b.key, label: b.label })),
    });
    await writeBranchDecision({
      user, surface: 'tutorialBranch', tutorialSlug, missionSlug: null,
      branchPointId: bp.id, decision,
    });
  }

  const outSkipPoints = [];
  for (const sp of skipPoints) {
    let result;
    try { result = evaluateSkip(sp.skipIf, userState); }
    catch (err) {
      LOG.warn(`evaluateSkip failed for ${tutorialSlug}/step-${sp.stepNumber}: ${err.message}`);
      result = { skip: false, reason: { kind: 'parse-error', message: err.message } };
    }
    outSkipPoints.push({
      stepNumber: sp.stepNumber,
      skip: result.skip,
      reason: result.reason,
      ...(sp.skipLabel ? { skipLabel: sp.skipLabel } : {}),
      ...(sp.skipReason ? { skipReason: sp.skipReason } : {}),
    });
    if (result.skip) {
      await writeSkipDecision({ user, tutorialSlug, stepNumber: sp.stepNumber, reason: result.reason });
    }
  }

  return { branchPoints: outBranchPoints, skipPoints: outSkipPoints };
}

async function writeBranchDecision({ user, surface, missionSlug, tutorialSlug, branchPointId, decision }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
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
      source: 'jouleTool',
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions write failed: ${err.message}`);
  }
}

async function writeSkipDecision({ user, tutorialSlug, stepNumber, reason }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
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
      source: 'jouleTool',
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions skip write failed: ${err.message}`);
  }
}
