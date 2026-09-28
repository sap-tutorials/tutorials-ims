// srv/lib/kg/joule-tool-describe-community.js
// Joule chat tool: describeCommunity (#1173). Answers questions ABOUT a topic
// cluster as a whole ("what's the AI cluster?", "show me everything around
// RAP") by resolving a free-text topic to a labeled Louvain community and
// returning its label, rationale, and member tutorials.
//
// Matching is LLM-side: the learner prompt injects the labeled-cluster catalog
// (see communityCatalogLayer in chat-context.js); the model picks the best
// label and passes it as matched_label. The server exact-matches that against
// KgCommunityLabel (deterministic + testable) with a token-overlap fallback on
// the raw topic. Fail-open: every error path returns empty members.
import cds from '@sap/cds';
import { matchLabel } from './community-label-match.js';
import { resolveCommunityMembers } from './community-members.js';

const LOG = cds.log('kg-describe-community');
const NS = 'com.sap.developers.ims';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const MAX_LABELS = 200; // bound the catalog read; ~18 today

export const DESCRIBE_COMMUNITY_TOOL = {
  type: 'function',
  function: {
    name: 'describeCommunity',
    description: [
      'Answer a question ABOUT a topic cluster/area as a whole (e.g. "what\'s the',
      'AI cluster", "show me everything around RAP"). Returns the cluster label, a',
      'one-line rationale, and its member tutorials. Pass the cluster label that',
      'best matches the learner\'s topic as matched_label — prefer an exact label',
      'from the known-clusters list in your context. Use when the learner names a',
      'TOPIC AREA rather than a specific tutorial.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: "The learner's topic phrasing, e.g. \"the AI cluster\"." },
        matched_label: { type: 'string', description: 'The exact cluster label you picked from the known-clusters list, if any.' },
        limit: { type: 'integer', description: 'Max member tutorials to return. 1-12, default 8.' },
      },
      required: ['topic'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { topic, matched_label?, limit? }
 * @returns {Promise<{label?:string, rationale?:string, members:Array<{slug,title,url}>, reason?:string, candidates?:Array<{label:string}>}>}
 */
export async function describeCommunityHandler({ db, args }) {
  const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
  const matchedLabel = typeof args?.matched_label === 'string' ? args.matched_label.trim() : '';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args?.limit) || DEFAULT_LIMIT));
  if (!topic && !matchedLabel) return { members: [], reason: 'no-match' };

  try {
    const { KgCommunityLabel } = cds.entities(NS);
    const labels = await db.run(
      SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label', 'rationale').limit(MAX_LABELS)
    );

    const m = matchLabel({ topic, matchedLabel, labels });
    if (m.reason) return { members: [], reason: m.reason, ...(m.candidates ? { candidates: m.candidates } : {}) };

    const members = await resolveCommunityMembers({ db, fingerprint: m.fingerprint, limit });
    const out = { label: m.label, members };
    if (m.rationale) out.rationale = m.rationale;
    if (members.length === 0) out.reason = 'no-live-members';
    return out;
  } catch (err) {
    LOG.warn('describeCommunity dispatch failed:', err.message);
    return { members: [], reason: 'error' };
  }
}

export default { DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler };
