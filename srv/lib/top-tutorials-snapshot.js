// srv/lib/top-tutorials-snapshot.js
// Issue #1782 — completions-based Top Tutorials ranking. Mirrors
// featured-topics-snapshot.js: recompute (write) + readForFeed (read+hydrate+etag).
// Window predicate binds a JS Date cutoff (cross-adapter; no HANA ADD_DAYS).
import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { selectTopN } from './top-tutorials-selection.js';
import { decodeDescription } from './featured-topics-snapshot.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('top-tutorials');
const DAY_MS = 24 * 60 * 60 * 1000;

export const WINDOWS = [90, 180, 360];
export const TOP_N = 8;

const lower = (x) => (x == null ? x : String(x).toLowerCase());

export function computeTopTutorialsEtag({ computedAt, rows }) {
  const canonical = [
    new Date(computedAt || 0).toISOString(),
    ...[...rows]
      .sort((a, b) => (a.windowDays - b.windowDays) || (a.rank - b.rank))
      .map(r => `${r.windowDays}:${r.rank}:${r.slug}:${r.completions}`),
  ].join('|');
  return `W/"${createHash('sha1').update(canonical).digest('hex')}"`;
}

// Active tutorial legacyId → lowercased slug (excludes INACTIVE/DELETED).
async function loadActiveSlugMap(tx) {
  const { Tutorials } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(Tutorials).columns('legacyId', 'slug').where(`status = 'ACTIVE' or status is null`));
  const map = new Map();
  for (const r of rows) if (r.legacyId != null && r.slug) map.set(r.legacyId, lower(r.slug));
  return map;
}

export async function recomputeSnapshot(tx) {
  const { TaskRecords, TopTutorialsSnapshot } = cds.entities(NS);
  const slugByLegacyId = await loadActiveSlugMap(tx);
  const now = Date.now();
  const computedAtIso = new Date(now).toISOString();

  const outRows = [];
  for (const windowDays of WINDOWS) {
    const cutoff = new Date(now - windowDays * DAY_MS);
    // Group by taskLegacyId in SQL (no association needed). count(*)/max()/groupBy
    // are cross-adapter (proven by TutorialCompletionStats). The window predicate
    // binds a JS Date — NOT ADD_DAYS — so this runs on SQLite + HANA identically.
    const grouped = await tx.run(
      SELECT.from(TaskRecords)
        .columns('taskLegacyId', 'count(*) as completions', 'max(completionDate) as lastCompletion')
        .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } })
        .and(`completionDate >=`, cutoff)
        .groupBy('taskLegacyId'),
    );
    const ranked = selectTopN(grouped, slugByLegacyId, TOP_N);
    ranked.forEach((r, i) => outRows.push({
      windowDays, rank: i + 1, slug: r.slug, completions: r.completions, computedAt: computedAtIso,
    }));
  }

  // Atomic replace within the caller's tx (mirrors featured-topics recompute).
  await tx.run(DELETE.from(TopTutorialsSnapshot));
  if (outRows.length) await tx.run(INSERT.into(TopTutorialsSnapshot).entries(outRows));
  LOG.info(`recomputeSnapshot wrote ${outRows.length} rows across ${WINDOWS.length} windows`);
  return { count: outRows.length, computedAt: new Date(computedAtIso) };
}

export async function readSnapshotForFeed(tx) {
  const { TopTutorialsSnapshot } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(TopTutorialsSnapshot).orderBy('windowDays asc', 'rank asc'));
  if (!rows.length) {
    return { computedAt: null, etag: computeTopTutorialsEtag({ computedAt: new Date(0), rows: [] }), windows: [] };
  }

  const slugList = [...new Set(rows.map(r => lower(r.slug)))];
  const cardBySlug = await hydrateTutorialCards(tx, slugList);

  const byWindow = new Map();
  for (const r of rows) {
    if (!byWindow.has(r.windowDays)) byWindow.set(r.windowDays, []);
    byWindow.get(r.windowDays).push({
      rank: r.rank,
      slug: lower(r.slug),
      completions: r.completions,
      card: cardBySlug.get(lower(r.slug)) || null,
    });
  }
  const windows = [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowDays, items]) => ({ windowDays, items: items.filter(i => i.card) }));

  return {
    computedAt: new Date(rows[0].computedAt),
    etag: computeTopTutorialsEtag({ computedAt: rows[0].computedAt, rows }),
    windows,
  };
}

// Tutorial-only card hydration (top tutorials are never missions). LOB-safe
// description fetch on HANA (separate query) to avoid LOB-locator expiry —
// mirrors featured-topics-snapshot.readSnapshotForFeed.
async function hydrateTutorialCards(tx, slugList) {
  const { Tutorials } = cds.entities(NS);
  const cardBySlug = new Map();
  if (!slugList.length) return cardBySlug;

  const tRows = await tx.run(SELECT.from(Tutorials)
    .columns('slug', 'title', 'experienceTag', 'averageTimeToComplete', 'primaryTag')
    .where({ slug: { in: slugList } })
    .and(`status = 'ACTIVE' or status is null`));

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  let descBySlug = new Map();
  if (isHana) {
    const placeholders = slugList.map(() => '?').join(',');
    const descRows = await db.run(
      `SELECT "SLUG", "DESCRIPTION" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "SLUG" IN (${placeholders})`,
      slugList,
    );
    descBySlug = new Map(descRows.map(r => [lower(r.SLUG ?? r.slug), decodeDescription(r.DESCRIPTION ?? r.description)]));
  } else {
    const descRows = await tx.run(SELECT.from(Tutorials).columns('slug', 'description').where({ slug: { in: slugList } }));
    descBySlug = new Map(descRows.map(r => [lower(r.slug), r.description || '']));
  }

  for (const c of tRows) {
    const slug = lower(c.slug);
    cardBySlug.set(slug, {
      slug,
      title: c.title,
      description: descBySlug.get(slug) || '',
      level: c.experienceTag || null,
      time: c.averageTimeToComplete || null,
      primaryTag: c.primaryTag || null,
      href: `/tutorials/${slug}`,
      isNew: false,
    });
  }
  return cardBySlug;
}
