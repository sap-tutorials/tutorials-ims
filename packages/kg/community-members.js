// srv/lib/kg/community-members.js
// Shared member-resolution for KG-community Joule tools (#1173).
// Given a community fingerprint, returns its tutorial members resolved to live
// Tutorials (status ACTIVE or NULL — NULL treated as ACTIVE per
// knowledge-graph-service.js:477-486 and co-completion.js:18), ordered by
// title, optionally excluding one anchor slug, capped at `limit`.
// Fail-open: any error returns [] so callers never 500 into the chat stream.
import cds from '@sap/cds';

const LOG = cds.log('kg-community-members');
const NS = 'com.sap.developers.ims';
const HARD_SIBLING_CAP = 50; // communities are small; defensive bound on the .in([]) set

/**
 * @param {object} opts
 * @param {object} opts.db          - CDS db handle
 * @param {string} opts.fingerprint - communityFingerprint (String(64))
 * @param {number} opts.limit       - max members to return
 * @param {string} [opts.excludeSlug] - anchor slug to exclude (lowercased internally)
 * @returns {Promise<Array<{slug:string, title:string, url:string}>>}
 */
export async function resolveCommunityMembers({ db, fingerprint, limit, excludeSlug }) {
  if (!fingerprint) return [];
  const exclude = typeof excludeSlug === 'string' ? excludeSlug.toLowerCase() : null;
  const cap = Math.max(1, Number(limit) || 1);
  try {
    const { KgCommunity, Tutorials } = cds.entities(NS);

    const memberRows = await db.run(
      SELECT.from(KgCommunity).columns('slug')
        .where({ communityFingerprint: fingerprint, vertexType: 'tutorial' })
        .limit(HARD_SIBLING_CAP)
    );
    const slugs = [...new Set(memberRows.map((r) => r.slug?.toLowerCase()).filter(Boolean))]
      .filter((s) => s !== exclude);
    if (slugs.length === 0) return [];

    // Fetch status alongside slug/title and filter in JS — SQL IN(...) does not
    // match NULL, so we cannot filter status in the WHERE.
    const tutRows = await db.run(
      SELECT.from(Tutorials).columns('slug', 'title', 'status')
        .where({ slug: { in: slugs } })
        .orderBy('title asc')
    );
    return tutRows
      .filter((t) => !t.status || t.status === 'ACTIVE')
      .slice(0, cap)
      .map((t) => ({
        slug: t.slug,
        title: t.title,
        url: `https://developers.sap.com/tutorials/${t.slug}.html`,
      }));
  } catch (err) {
    LOG.warn('resolveCommunityMembers failed:', err.message);
    return [];
  }
}

export default { resolveCommunityMembers };
