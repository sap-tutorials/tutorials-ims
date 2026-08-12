import cds from '@sap/cds';
import { buildModelJson } from './model-json.js';

const NS = 'com.sap.developers.ims';
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

// GET /content/tutorial-model/:slug  (unauthenticated)
//
// Serves the legacy-compatible AEM `.model.json` for a tutorial. The approuter
// maps `^/tutorials/<slug>.model.json$` here. See ./model-json.js for the WHY
// and the exact envelope shape. Behaviour mirrors the tutorial serveHandler:
// mixed-case slugs 301 to the lowercase canonical form; redirected tutorials
// 301 to the target's `.model.json`; unknown slugs 404 with a JSON body.
export async function modelJsonHandler(req, res) {
  // Express 5 named wildcard (`*slug`) → array; fall back to [0] for older shapes.
  const raw = String(
    (Array.isArray(req.params.slug) ? req.params.slug.join('/') : req.params.slug) ??
      req.params[0] ??
      '',
  );
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

  // Strip a stray .html/.model.json/.json suffix, then canonicalise to lowercase.
  const cleaned = raw.replace(/\.(model\.json|html|json)$/i, '');
  const slug = cleaned.toLowerCase();

  if (!VALID_SLUG.test(slug)) {
    return res.status(404).json({ error: `Tutorial not found: ${cleaned}` });
  }

  // Mixed-case bookmark → 301 to the canonical lowercase .model.json URL.
  if (cleaned !== slug) {
    res.setHeader('Location', `/tutorials/${slug}.model.json${query}`);
    return res.status(301).end();
  }

  try {
    const { Tutorials, Tags, TutorialTags, TutorialContributors, RepoCatalog, Users } =
      cds.entities(NS);

    const tut = await SELECT.one
      .from(Tutorials)
      .where({ slug })
      .columns(
        'ID',
        'slug',
        'title',
        'description',
        'legacyId',
        'experienceTag',
        'primaryTag',
        'averageTimeToComplete',
        'status',
        'redirectTo_ID',
      );

    if (!tut) {
      return res.status(404).json({ error: `Tutorial not found: ${slug}` });
    }

    // Admin renamed/redirected this tutorial → 301 to the live slug's model.json.
    if (tut.redirectTo_ID) {
      const target = await SELECT.one
        .from(Tutorials)
        .where({ ID: tut.redirectTo_ID })
        .columns('slug');
      if (target?.slug && target.slug !== slug) {
        res.setHeader('Location', `/tutorials/${target.slug}.model.json${query}`);
        return res.status(301).end();
      }
    }

    // Tags → [{ label, titlePath }]
    const tagLinks = await SELECT.from(TutorialTags)
      .where({ tutorial_ID: tut.ID })
      .columns('tag_ID');
    let tags = [];
    const tagIds = tagLinks.map((r) => r.tag_ID).filter(Boolean);
    if (tagIds.length) {
      const tagRows = await SELECT.from(Tags)
        .where({ ID: { in: tagIds } })
        .columns('label', 'titlePath');
      tags = tagRows.map((r) => ({ label: r.label, titlePath: r.titlePath }));
    }

    // Contributors → [{ name, role, login }] (login from Users.githubLogin)
    const conRows = await SELECT.from(TutorialContributors)
      .where({ tutorial_ID: tut.ID })
      .columns('name', 'role', 'user_ID');
    let loginById = {};
    const userIds = [...new Set(conRows.map((c) => c.user_ID).filter(Boolean))];
    if (userIds.length) {
      const users = await SELECT.from(Users)
        .where({ ID: { in: userIds } })
        .columns('ID', 'githubLogin');
      loginById = Object.fromEntries(users.map((u) => [u.ID, u.githubLogin]));
    }
    const contributors = conRows.map((c) => ({
      name: c.name || '',
      role: c.role || '',
      login: loginById[c.user_ID] || '',
    }));

    // Repo/owner from RepoCatalog (same source the admin tutorial-links use).
    // Fail-quiet: a catalog miss just drops the github feedback option.
    let repoInfo = {};
    try {
      const row = await SELECT.one.from(RepoCatalog).where({ slug }).columns('payload');
      if (row?.payload) repoInfo = JSON.parse(row.payload) || {};
    } catch (err) {
      cds.log('model-json').warn(`RepoCatalog lookup failed for ${slug}: ${err.message}`);
    }

    const doc = buildModelJson({
      slug,
      title: tut.title,
      description: tut.description,
      legacyId: tut.legacyId ?? null,
      experienceTag: tut.experienceTag,
      primaryTag: tut.primaryTag,
      averageTimeToComplete: tut.averageTimeToComplete ?? null,
      tags,
      contributors,
      owner: repoInfo.owner || 'sap-tutorials',
      repo: repoInfo.repo || null,
      branch: repoInfo.branch || 'main',
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Source', 'db');
    return res.json(doc);
  } catch (err) {
    cds.log('model-json').error(`serve failed for ${slug}: ${err.message}`);
    return res.status(500).json({ error: 'model.json build failed' });
  }
}
