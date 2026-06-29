// srv/lib/resolve-my-tutorials.js
//
// Issue #777. Thin JS wrapper over MyTutorialsView (db/views.cds) for
// callers that don't go through the CAP OData layer. The view does the
// real work (UNION ALL of 4 sources, MIN(priority) dedup, JOIN back to
// Tutorials + TutorialMeta); this wrapper just keeps the SELECT shape
// in one place so advocates-public.js doesn't have to know CQN.
//
// Spec: docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md §1.3
// Sibling (publish-time, distinct purpose): srv/lib/resolve-tutorial-author.js

import cds from '@sap/cds';

/**
 * Return tutorials "belonging to" a user via the canonical four-source view.
 *
 * @param {object} db     - cds db service (typically cds.db or the result of cds.connect.to('db'))
 * @param {object} opts
 * @param {string|null} [opts.userId]   - single Users.uuid value (NOT Users.ID)
 * @param {string[]} [opts.userIds]     - plural Users.uuid array — overrides userId if both given
 * @returns {Promise<Array<{ slug: string, title: string, userId: string, bestPriority: number }>>}
 */
export async function resolveMyTutorials(db, opts = {}) {
  const ids = Array.isArray(opts.userIds)
    ? opts.userIds
    : opts.userId
      ? [opts.userId]
      : [];
  if (ids.length === 0) return [];

  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  return db.run(
    SELECT.from(MyTutorialsView)
      .columns('tutorial_ID', 'userId', 'slug', 'title', 'bestPriority')
      .where({ userId: { in: ids } }),
  );
}
