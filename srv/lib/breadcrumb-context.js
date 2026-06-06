// srv/lib/breadcrumb-context.js
//
// GET /build/breadcrumb-context?tutorial=<slug>
//
// Returns the current parent group + mission for a tutorial so the
// tutorial-page breadcrumb island can refresh stale text after a rename.
// Anonymous, public; cached for 60s.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

export async function breadcrumbContextHandler(req, res) {
  const slug = String(req.query.tutorial || '').trim().toLowerCase();
  if (!slug) {
    return res.status(400).json({ error: 'missing tutorial parameter' });
  }
  if (!/^[a-z0-9_][a-z0-9_-]{0,127}$/i.test(slug)) {
    return res.status(400).json({ error: 'invalid tutorial slug' });
  }

  try {
    const { Tutorials, GroupPathItems, Groups, CompletionPathItems,
            CompletionPaths, Missions } = cds.entities(NAMESPACE);

    const [tut] = await SELECT.from(Tutorials)
      // slug-canonical: pre-canonicalized
      .where({ slug })
      .columns('ID');
    if (!tut) {
      return res.status(404).json({ error: 'tutorial not found' });
    }

    const [gpi] = await SELECT.from(GroupPathItems)
      .where({ tutorial_ID: tut.ID })
      .columns('group_ID')
      .orderBy('itemOrder')
      .limit(1);

    if (!gpi?.group_ID) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json({});
    }

    const [group] = await SELECT.from(Groups)
      .where({ ID: gpi.group_ID })
      .columns('slug', 'title');

    const [cpi] = await SELECT.from(CompletionPathItems)
      .where({ group_ID: gpi.group_ID })
      .columns('path_ID')
      .orderBy('itemOrder')
      .limit(1);

    let mission = null;
    if (cpi?.path_ID) {
      const [path] = await SELECT.from(CompletionPaths)
        .where({ ID: cpi.path_ID })
        .columns('mission_ID');
      if (path?.mission_ID) {
        const [m] = await SELECT.from(Missions)
          .where({ ID: path.mission_ID })
          .columns('slug', 'title');
        mission = m || null;
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      missionTitle: mission?.title ?? null,
      missionSlug:  mission?.slug ?? null,
      groupTitle:   group?.title ?? null,
      groupSlug:    group?.slug ?? null,
    });
  } catch (err) {
    console.error('[build/breadcrumb-context]',
      err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: 'lookup failed' });
  }
}
