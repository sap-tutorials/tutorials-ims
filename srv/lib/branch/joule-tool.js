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

  // Subsequent tasks fill in tutorial + mission resolution.
  return { branchPoints: [], altGroups: [], skipPoints: [], note: 'not_yet_implemented' };
}
