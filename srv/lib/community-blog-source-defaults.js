// srv/lib/community-blog-source-defaults.js
//
// (#1144) Single source of truth for the 3 managed CommunityBlogSources
// rows and their Khoros LiQL `apiQuery` predicates.
//
// Why this module exists: the apiQuery column was introduced by #1155 but
// existing managed rows deployed before it carried apiQuery=NULL. The only
// backfill lived in AdminService's before('READ','CommunityBlogSources')
// hook — which fires ONLY when an admin opens the Sources page in the UI.
// The `community-blogs-fetch` cron reads straight from the `db` service and
// bypasses that hook, so on any env where nobody had opened the page the
// managed rows stayed null → every source degraded to the curl fallback on
// the raw RSS feed → curl 403s from the CF egress IP → all sources errored
// → the job's "all sources errored" alarm threw. (Diagnosed 2026-07-13:
// DEV feed was stuck 4 days stale for exactly this reason.)
//
// Making the backfill live here and calling it from BOTH the admin READ
// hook and fetchAllSources makes the fix self-healing regardless of admin
// UI visits — and keeps the defaults from drifting across two hand-curated
// copies (memory rule: hand-curated registration lists rot).

import cds from '@sap/cds'; // registers the SELECT/UPDATE CQL globals used below

const CBS = 'com.sap.developers.ims.CommunityBlogSources';

/**
 * The 3 managed community blog sources. Mirrors the seed CSV in db/data —
 * apiQuery is seeded HERE (not the CSV) because adding a column to a
 * db/data/*.csv triggers the .hdbtabledata editable-column wipe.
 */
export const COMMUNITY_BLOG_SOURCE_DEFAULTS = [
  {
    ID:        '00000000-0000-0000-0000-000000c81001',
    label:     'Community — Technology (all blogs)',
    feedUrl:   'https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog',
    topicSlug: 'community-technology',
    isActive:  true, sortOrder: 10, managed: true,
    apiQuery:  "category.id='technology' AND conversation.style='blog'",
  },
  {
    ID:        '00000000-0000-0000-0000-000000c81002',
    label:     'Technology Blogs by SAP',
    feedUrl:   'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap',
    topicSlug: 'technology-sap',
    isActive:  true, sortOrder: 20, managed: true,
    apiQuery:  "board.id='technology-blog-sap'",
  },
  {
    ID:        '00000000-0000-0000-0000-000000c81003',
    label:     'Technology Blogs by Members',
    feedUrl:   'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-members',
    topicSlug: 'technology-members',
    isActive:  true, sortOrder: 30, managed: true,
    apiQuery:  "board.id='technology-blog-members'",
  },
];

/**
 * Backfill apiQuery on managed rows that predate the #1144 column (or were
 * deployed before #1155 seeded it). Idempotent and fail-open: only touches
 * managed rows whose apiQuery IS NULL, matched by ID to the defaults above.
 * Rows the admin has since edited (non-null apiQuery) are never overwritten,
 * and unmanaged/user-added sources are never touched.
 *
 * @param {import('@sap/cds').Service} db - a connected `db` service or tx
 * @returns {Promise<number>} number of rows backfilled
 */
export async function backfillManagedApiQuery(db) {
  const byId = new Map(COMMUNITY_BLOG_SOURCE_DEFAULTS.map((d) => [d.ID, d.apiQuery]));
  const stale = await db.run(
    SELECT.from(CBS).columns('ID').where({ managed: true, apiQuery: null })
  );
  let patched = 0;
  for (const row of stale) {
    const q = byId.get(row.ID);
    if (!q) continue;
    await db.run(UPDATE(CBS).set({ apiQuery: q }).where({ ID: row.ID }));
    patched++;
  }
  return patched;
}
