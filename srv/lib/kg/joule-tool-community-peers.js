// srv/lib/kg/joule-tool-community-peers.js
// Joule chat tool: findCommunityPeers (#1126).
// Given a tutorial slug, returns sibling tutorials from the same Louvain
// community (KgCommunity, keyed by stable communityFingerprint) plus the
// LLM-generated cluster label (KgCommunityLabel). Fail-open: every error path
// returns an empty-peers shape so the chat stream never 500s.

import cds from '@sap/cds';

const LOG = cds.log('kg-community-peers');
const NS = 'com.sap.developers.ims';
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const HARD_SIBLING_CAP = 50;   // communities are small; defensive bound on the .in([]) set

export const FIND_COMMUNITY_PEERS_TOOL = {
  type: 'function',
  function: {
    name: 'findCommunityPeers',
    description: [
      'Given a tutorial the learner is on or asking about, return other tutorials',
      'from the same tightly-connected topic cluster (community) — a coherent themed',
      'set that tends to be learned together, with a short cluster label.',
      'Use for "what should I learn next" / "what else is in this area" questions',
      'when the learner is anchored to a specific tutorial.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tutorial_slug: { type: 'string', description: 'Slug of the anchor tutorial. Lowercase alphanumeric + hyphens.' },
        limit: { type: 'integer', description: 'Max sibling tutorials to return. 1-8, default 5.' },
      },
      required: ['tutorial_slug'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { tutorial_slug, limit? } from the LLM tool call
 * @returns {Promise<{label?:string, rationale?:string, peers:Array<{slug,title,url}>, reason?:string}>}
 */
export async function findCommunityPeersHandler({ db, args }) {
  const slug = typeof args?.tutorial_slug === 'string' ? args.tutorial_slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { peers: [], reason: 'bad-slug' };

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args?.limit) || DEFAULT_LIMIT));
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);

  try {
    // 1. Resolve the anchor's community fingerprint.
    const anchor = await db.run(
      SELECT.one.from(KgCommunity).columns('communityFingerprint')
        .where({ slug, vertexType: 'tutorial' })
    );
    const fp = anchor?.communityFingerprint;
    if (!fp) return { peers: [], reason: 'no-community' };

    // 2. Sibling tutorial slugs sharing the fingerprint (exclude self).
    const siblingRows = await db.run(
      SELECT.from(KgCommunity).columns('slug')
        .where({ communityFingerprint: fp, vertexType: 'tutorial' })
        .limit(HARD_SIBLING_CAP)
    );
    const siblingSlugs = [...new Set(siblingRows.map((r) => r.slug?.toLowerCase()).filter(Boolean))]
      .filter((s) => s !== slug);
    if (siblingSlugs.length === 0) return { peers: [], reason: 'singleton' };

    // 3. Resolve to live tutorials (status ACTIVE or NULL — NULL is treated as
    // ACTIVE, matching knowledge-graph-service.js:477-486 and co-completion.js:18),
    // ordered by title, capped to limit. Tutorials has no `published` column.
    // NOTE: SQL `IN (...)` does not match NULL, so we cannot use
    //   `.where({ slug: { in: siblingSlugs }, status: { in: ['ACTIVE', null] } })`.
    // Instead: fetch status alongside slug/title and filter in JS.
    // Community sibling sets are small (hard-capped 50) so this is fine.
    const tutRows = await db.run(
      SELECT.from(Tutorials).columns('slug', 'title', 'status')
        .where({ slug: { in: siblingSlugs } })
        .orderBy('title asc')
    );
    const peers = tutRows
      .filter((t) => !t.status || t.status === 'ACTIVE')
      .slice(0, limit)
      .map((t) => ({
        slug: t.slug,
        title: t.title,
        url: `https://developers.sap.com/tutorials/${t.slug}.html`,
      }));
    if (peers.length === 0) return { peers: [], reason: 'no-published-peers' };

    // 4. Attach the cluster label if one exists.
    const labelRow = await db.run(
      SELECT.one.from(KgCommunityLabel).columns('label', 'rationale')
        .where({ communityFingerprint: fp })
    );

    const out = { peers };
    if (labelRow?.label) { out.label = labelRow.label; out.rationale = labelRow.rationale || undefined; }
    return out;
  } catch (err) {
    LOG.warn('findCommunityPeers dispatch failed:', err.message);
    return { peers: [], reason: 'error' };
  }
}

export default { FIND_COMMUNITY_PEERS_TOOL, findCommunityPeersHandler };
