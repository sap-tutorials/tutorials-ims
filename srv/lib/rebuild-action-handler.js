// srv/lib/rebuild-action-handler.js
//
// Shared body for the rebuildContent bound action on AdminService.Tutorials and
// AuthorService.Tutorials (#617). Surfaces differ only by the `source` string;
// slug resolution, audit emission, dispatch, and response shape are identical.
//
// Usage:
//   this.on('rebuildContent', 'Tutorials', (req) => handleRebuildAction(req, {
//     source: 'admin-ui:tutorial-detail',
//     selectOne: (id) => SELECT.one.from(Tutorials).columns('slug','title').where({ ID: id }),
//     audit: auditEvent,
//     schedule: scheduleRebuild,
//   }));
//
// The reason string passed to `schedule` is derived from the source by taking
// the prefix before the first ':' — so 'admin-ui:tutorial-detail' yields
// 'admin-ui:rebuild-button:<user>' and 'author-ui:tutorial-detail' yields
// 'author-ui:rebuild-button:<user>'. This matches the convention the rebuild
// trigger's diagnostic log surfaces back into GitHub Actions run UI.
//
// Result shape preserves the existing AdminService.rebuildContent contract:
// `debounced: true` and the canonical workflow URL are constants (scheduleRebuild
// itself returns undefined; the UI uses these only for status display). If a
// future `schedule` implementation returns its own `{ debounced, workflowUrl }`,
// those values override the defaults.

const DEFAULT_WORKFLOW_URL =
  'https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml';

export async function handleRebuildAction(req, deps) {
  const { source, selectOne, audit, schedule } = deps;
  const tutorialId = req.params[0].ID;

  const row = await selectOne(tutorialId);
  if (!row?.slug) {
    return req.reject(400, 'Tutorial has no slug; cannot rebuild');
  }

  const userId = req.user?.id ?? 'anonymous';

  await audit('TutorialRebuildTriggered', {
    user: userId,
    tutorialId,
    slug: row.slug,
    source,
  });

  const dispatch = await schedule(
    `${source.split(':')[0]}:rebuild-button:${userId}`,
    { mode: 'slug-targeted', slug: row.slug }
  );

  return {
    dispatched: true,
    slug: row.slug,
    debounced: dispatch?.debounced ?? true,
    workflowUrl: dispatch?.workflowUrl ?? DEFAULT_WORKFLOW_URL,
  };
}

