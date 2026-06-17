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

async function handleAdvocates(req, res) {
  try {
    const db = await cds.connect.to('db');
    const { Advocates, AdvocateTopics, AdvocateLinks, Tags } =
      cds.entities('com.sap.developers.ims');

    const advocates = await db.run(
      SELECT.from(Advocates).where({ isActive: true }),
    );
    const ids = advocates.map((a) => a.ID);

    const [topics, links] = await Promise.all([
      ids.length
        ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } }))
        : [],
      ids.length
        ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } }))
        : [],
    ]);

    // Resolve topic tag → { slug, label }
    const tagIds = [...new Set(topics.map((t) => t.tag_ID).filter(Boolean))];
    const tagRows = tagIds.length
      ? await db.run(
          SELECT.from(Tags)
            .columns('ID', 'slug', 'label')
            .where({ ID: { in: tagIds } }),
        )
      : [];
    const tagById = new Map(tagRows.map((t) => [t.ID, t]));

    const topicsByAdv = new Map();
    for (const t of topics) {
      const tag = tagById.get(t.tag_ID);
      if (!tag) continue;
      if (!topicsByAdv.has(t.advocate_ID)) topicsByAdv.set(t.advocate_ID, []);
      topicsByAdv.get(t.advocate_ID).push({ slug: tag.slug, label: tag.label });
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

    const body = {
      advocates: advocates.map((a) => ({
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
      })),
    };

    const max = Math.max(
      maxModified(advocates),
      maxModified(topics),
      maxModified(links),
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
