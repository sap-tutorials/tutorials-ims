// Public read endpoint for the developer-advocates page.
// Spec: docs/superpowers/specs/2026-06-17-developer-advocates-design.md

import cds from '@sap/cds';
import { fetchPhoto } from '../lib/advocate-photo-store.js';

const log = cds.log('advocates');

/**
 * Find the latest modifiedAt timestamp across a row set.
 * Returns 0 when nothing has a timestamp, so the ETag stays stable.
 */
function maxModified(rows) {
  let max = 0;
  for (const r of rows) {
    const t = r.modifiedAt ? new Date(r.modifiedAt).getTime() : 0;
    if (t > max) max = t;
  }
  return max;
}

/**
 * Map a raw Advocates row + pre-built lookup maps into the canonical
 * JSON shape used by both /api/advocates (list) and /api/advocates/:slug
 * (single). Optional fields (email, authoredTutorials, contributedTutorials)
 * are omitted entirely when the advocate has no user link OR the linked
 * user has no email / tutorials — same gating logic the existing list
 * handler used inline.
 */
export function shapeAdvocateRow(a, ctx) {
  const { topicsByAdv, linksByAdv, userById, authoredByUserId, contribByUserId } = ctx;
  const linkedUser = a.user_ID ? userById.get(a.user_ID) : null;
  const authored = a.user_ID ? authoredByUserId.get(a.user_ID) : null;
  const contributed = a.user_ID ? contribByUserId.get(a.user_ID) : null;
  return {
    ID: a.ID,
    slug: a.slug,
    firstName: a.firstName,
    lastName: a.lastName,
    title: a.title,
    pronouns: a.pronouns,
    location: a.location,
    region: a.region,
    bio: a.bio,
    joinedDate: a.joinedDate,
    hasPhoto: !!a.hasPhoto,
    photoUpdatedAt: a.photoUpdatedAt,
    topics: topicsByAdv.get(a.ID) || [],
    links: linksByAdv.get(a.ID) || [],
    ...(linkedUser?.email ? { email: linkedUser.email } : {}),
    ...(authored?.length
      ? { authoredTutorials: authored.slice().sort((x, y) => x.title.localeCompare(y.title)) }
      : {}),
    ...(contributed?.length
      ? { contributedTutorials: contributed.slice().sort((x, y) => x.title.localeCompare(y.title)) }
      : {}),
  };
}

async function handleAdvocates(req, res) {
  try {
    const db = await cds.connect.to('db');
    const { Advocates, AdvocateTopics, AdvocateLinks, Tags, Users, Tutorials, TutorialContributors } =
      cds.entities('com.sap.developers.ims');

    const advocates = await db.run(
      SELECT.from(Advocates).where({ isActive: true }),
    );
    const ids = advocates.map((a) => a.ID);
    // Spec 2026-06-25-advocate-user-link-design §3: pull linked user data
    // for advocates that have user_ID set. Separate query + JS-side join
    // (matches the topics/links pattern below — no deep CQN expand).
    const userIds = [...new Set(advocates.map((a) => a.user_ID).filter(Boolean))];

    const [topics, links, users, authoredRows, contribRows] = await Promise.all([
      ids.length
        ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } }))
        : [],
      ids.length
        ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } }))
        : [],
      // NEW — only fetch Users that an advocate links to.
      userIds.length
        ? db.run(SELECT.from(Users).columns('ID', 'email').where({ ID: { in: userIds } }))
        : [],
      // NEW — tutorials authored by any of those users.
      userIds.length
        ? db.run(
            SELECT.from(Tutorials)
              .columns('slug', 'title', 'author_ID')
              .where({ author_ID: { in: userIds } }),
          )
        : [],
      // NEW — contributor rows for any of those users; tutorial slug/title
      // resolved in a second small query below to avoid CQN deep-expand.
      userIds.length
        ? db.run(
            SELECT.from(TutorialContributors)
              .columns('user_ID', 'tutorial_ID')
              .where({ user_ID: { in: userIds } }),
          )
        : [],
    ]);

    const contribTutorialIds = [
      ...new Set(contribRows.map((r) => r.tutorial_ID).filter(Boolean)),
    ];
    const contribTutorials = contribTutorialIds.length
      ? await db.run(
          SELECT.from(Tutorials)
            .columns('ID', 'slug', 'title')
            .where({ ID: { in: contribTutorialIds } }),
        )
      : [];

    // Resolve topic tag → { slug, label }.
    // Note: the Tags entity has no `slug` column — its slug-equivalent is
    // `name` (e.g. "software-product>cap"). We expose it as `slug` in the
    // public API for client-side simplicity.
    const tagIds = [...new Set(topics.map((t) => t.tag_ID).filter(Boolean))];
    const tagRows = tagIds.length
      ? await db.run(
          SELECT.from(Tags)
            .columns('ID', 'name', 'label')
            .where({ ID: { in: tagIds } }),
        )
      : [];
    const tagById = new Map(tagRows.map((t) => [t.ID, t]));

    const topicsByAdv = new Map();
    for (const t of topics) {
      const tag = tagById.get(t.tag_ID);
      if (!tag) continue;
      // Fallback chain: if a Tag row has no human-readable label, use its
      // 'name' (slug-equivalent). Skip entirely if both are missing — an
      // empty-string label causes a no-text chip to render on the public
      // page. Defense in depth is also applied client-side in App.vue.
      const label = (tag.label && String(tag.label).trim())
        || (tag.name  && String(tag.name).trim())
        || null;
      if (!label) continue;
      if (!topicsByAdv.has(t.advocate_ID)) topicsByAdv.set(t.advocate_ID, []);
      topicsByAdv.get(t.advocate_ID).push({ slug: tag.name, label });
    }

    const linksByAdv = new Map();
    const sortedLinks = [...links].sort(
      (a, b) =>
        (a.sortOrder ?? 100) - (b.sortOrder ?? 100) ||
        String(a.kind).localeCompare(String(b.kind)),
    );
    for (const l of sortedLinks) {
      if (!linksByAdv.has(l.advocate_ID)) linksByAdv.set(l.advocate_ID, []);
      linksByAdv.get(l.advocate_ID).push({
        kind: l.kind,
        url: l.url,
        label: l.label,
        sortOrder: l.sortOrder,
      });
    }

    // Spec 2026-06-25-advocate-user-link-design §3: build the linked-user
    // / authored-tutorial / contributed-tutorial lookups so the response
    // shaper below can conditionally surface them per advocate.
    const userById = new Map(users.map((u) => [u.ID, u]));
    const authoredByUserId = new Map();
    for (const t of authoredRows) {
      if (!t.slug || !t.title) continue;
      if (!authoredByUserId.has(t.author_ID)) authoredByUserId.set(t.author_ID, []);
      authoredByUserId.get(t.author_ID).push({ slug: t.slug, title: t.title });
    }
    const tutorialById = new Map(contribTutorials.map((t) => [t.ID, t]));
    const contribByUserId = new Map();
    for (const c of contribRows) {
      const tut = tutorialById.get(c.tutorial_ID);
      if (!tut || !tut.slug || !tut.title) continue;
      if (!contribByUserId.has(c.user_ID)) contribByUserId.set(c.user_ID, []);
      contribByUserId.get(c.user_ID).push({ slug: tut.slug, title: tut.title });
    }

    // Collator-aware sort: sortOverride first (NULLS LAST), then lastName, then firstName.
    const collator = new Intl.Collator('en', { sensitivity: 'base' });
    advocates.sort((a, b) => {
      const ao = a.sortOverride ?? Number.POSITIVE_INFINITY;
      const bo = b.sortOverride ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      const last = collator.compare(a.lastName || '', b.lastName || '');
      if (last !== 0) return last;
      return collator.compare(a.firstName || '', b.firstName || '');
    });

    const ctx = { topicsByAdv, linksByAdv, userById, authoredByUserId, contribByUserId };
    const body = { advocates: advocates.map((a) => shapeAdvocateRow(a, ctx)) };

    const max = Math.max(
      maxModified(advocates),
      maxModified(topics),
      maxModified(links),
      // Spec §3: bust the 60s cache when linked-user data changes.
      maxModified(users),
      maxModified(authoredRows),
      maxModified(contribRows),
      maxModified(contribTutorials),
    );
    const etag = '"' + max.toString(36) + '"';

    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      'public, max-age=60, stale-while-revalidate=600',
    );

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.json(body);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'advocates_unavailable' });
  }
}

async function handlePhoto(req, res) {
  try {
    const size = req.query.size === 'thumb' ? 'thumb' : 'full';
    const out = await fetchPhoto(req.params.slug, size);
    if (!out) {
      res.status(404).end();
      return;
    }
    res.setHeader('ETag', out.etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.headers['if-none-match'] === out.etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', out.mimeType);
    res.send(out.buffer);
  } catch (err) {
    log.error(err);
    res.status(500).end();
  }
}

export function register(app) {
  app.get('/api/advocates', handleAdvocates);
  app.get('/api/advocates/:slug/photo', handlePhoto);
}
