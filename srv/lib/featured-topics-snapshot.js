// srv/lib/featured-topics-snapshot.js
import cds from '@sap/cds';
import { selectFeaturedTopics } from './featured-topics-selection.js';
import { computeSnapshotEtag } from './featured-topics-etag.js';

const NS = 'com.sap.developers.ims';
const TARGET_COUNT = 8;
const MISSIONS_PER_SLIDE = 4;
const LOG = cds.log('featured-topics');

const DAY_MS = 24 * 60 * 60 * 1000;

// #1783 — loose freshness floor for the Featured (PageRank) carousel.
// Admin-configurable via ImsConfig; the default is deliberately generous
// (~24 months) so evergreen-but-old tutorials stay eligible — the #1771 case
// was a 344-day-old tutorial that should NOT be auto-dropped. An explicit
// value of 0 (or negative) disables the age floor entirely.
const FRESHNESS_CFG_KEY = 'featured.freshness.maxAgeDays';
export const DEFAULT_FRESHNESS_MAX_AGE_DAYS = 730;

const lower = (x) => (x == null ? x : String(x).toLowerCase());

/**
 * Resolve the Featured-carousel freshness cutoff (in days) from ImsConfig.
 *
 * - Missing row / blank / non-numeric value → the generous default (issue
 *   #1783 wants a DB-configurable threshold with a generous fallback).
 * - An explicit numeric value is honoured verbatim; 0 or negative disables
 *   the age floor.
 * - Any read fault fails OPEN (returns 0 → no filtering) rather than risk
 *   gutting the curated surface on a transient DB hiccup.
 */
export async function resolveFreshnessMaxAgeDays(tx) {
  const { ImsConfig } = cds.entities(NS);
  try {
    const row = await tx.run(SELECT.one.from(ImsConfig).columns('value').where({ key: FRESHNESS_CFG_KEY }));
    const raw = row?.value;
    if (raw == null || String(raw).trim() === '') return DEFAULT_FRESHNESS_MAX_AGE_DAYS;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      LOG.warn(`featured freshness cutoff "${raw}" is not a number; using default ${DEFAULT_FRESHNESS_MAX_AGE_DAYS}d`);
      return DEFAULT_FRESHNESS_MAX_AGE_DAYS;
    }
    return n;
  } catch (err) {
    LOG.warn('featured freshness cutoff read failed; fail-open (no age floor):', err.message);
    return 0;
  }
}

/**
 * Partition an eligibility slug set by a freshness cutoff. Pure — no DB.
 *
 * @param {Set<string>} tutorialsBySlug  lowercased eligible slugs
 * @param {Map<string,number>} reviewedMsBySlug  slug → most-recent reviewedDate (ms since epoch)
 * @param {number} maxAgeDays  cutoff in days; <= 0 disables filtering
 * @param {number} now  reference time (ms), defaults to Date.now()
 * @returns {{kept: Set<string>, dropped: string[]}}
 *
 * A slug with no entry in `reviewedMsBySlug` (no TutorialMeta row or a NULL
 * reviewedDate) is KEPT — fail-open, consistent with the pipeline. Slugs whose
 * most-recent reviewedDate is older than the cutoff are dropped.
 */
export function applyFreshnessFilter(tutorialsBySlug, reviewedMsBySlug, maxAgeDays, now = Date.now()) {
  if (!(maxAgeDays > 0)) return { kept: tutorialsBySlug, dropped: [] };
  const cutoffMs = now - maxAgeDays * DAY_MS;
  const kept = new Set();
  const dropped = [];
  for (const slug of tutorialsBySlug) {
    const ms = reviewedMsBySlug.get(slug);
    if (ms == null || ms >= cutoffMs) kept.add(slug);
    else dropped.push(slug);
  }
  return { kept, dropped };
}

/**
 * Decode a raw description value from a HANA NCLOB column.
 *
 * The HANA node driver returns NCLOB values as Node Buffer instances. If left
 * raw, JSON.stringify emits `{ "type": "Buffer", "data": [...] }` — the Vue
 * island's v-html card template then renders that JSON blob as visible
 * garbage in the description slot. Exported so unit tests can guard the
 * behavior without spinning up a HANA connection.
 */
export function decodeDescription(raw) {
  if (raw == null) return '';
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  return String(raw);
}

async function loadInputs(tx) {
  const { HomepageFeaturedTopics, Concepts, ConceptRank, TutorialRank, KgCommunity, TutorialConceptLinks, Tutorials, Missions, TutorialMeta } = cds.entities(NS);

  const editorialRows = await tx.run(SELECT.from(HomepageFeaturedTopics).columns('ID','concept_ID','displayTitle','sortOrder','validFrom','validUntil','missionSlugs','isActive','createdAt'));
  const editorialConceptIds = [...new Set(editorialRows.map(r => r.concept_ID).filter(Boolean))];
  const editorialConceptsById = new Map();
  if (editorialConceptIds.length) {
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt').where({ ID: { in: editorialConceptIds } }));
    for (const r of rows) editorialConceptsById.set(r.ID, r);
  }
  const editorial = editorialRows.map(r => {
    const c = editorialConceptsById.get(r.concept_ID) || {};
    return {
      conceptId: r.concept_ID,
      conceptSlug: lower(c.slug),
      conceptName: c.name,
      conceptStatus: c.status,
      conceptPublishedAt: c.publishedAt,
      displayTitle: r.displayTitle,
      sortOrder: r.sortOrder,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      missionSlugs: Array.isArray(r.missionSlugs) ? r.missionSlugs.map(lower) : r.missionSlugs,
      isActive: r.isActive,
      createdAt: r.createdAt,
    };
  }).filter(r => r.conceptSlug);

  const rankRows = await tx.run(SELECT.from(ConceptRank).columns('slug','score').orderBy('score desc','slug asc'));
  const conceptMetaBySlug = new Map();
  if (rankRows.length) {
    // Fetch all Concepts and filter in Node — a WHERE slug IN (…) over
    // thousands of ConceptRank slugs blows HANA's max packet size ("Failed
    // to set parameters, maximum packet size exceeded"). 5,895 rows × 5
    // short columns is well under 2 MB, so unbounded read is safe.
    const rankedSlugs = new Set(rankRows.map(r => lower(r.slug)));
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt'));
    for (const r of rows) {
      const s = lower(r.slug);
      if (rankedSlugs.has(s)) conceptMetaBySlug.set(s, r);
    }
  }
  const kgCandidates = rankRows.map(r => {
    const meta = conceptMetaBySlug.get(lower(r.slug)) || {};
    return {
      conceptSlug: lower(r.slug),
      conceptName: meta.name,
      conceptStatus: meta.status,
      conceptPublishedAt: meta.publishedAt,
      pagerankScore: r.score,
    };
  });

  const communityByConcept = new Map();
  try {
    const rows = await tx.run(SELECT.from(KgCommunity).columns('slug','communityFingerprint').where({ vertexType: 'CONCEPT' }));
    for (const r of rows) communityByConcept.set(lower(r.slug), r.communityFingerprint);
  } catch (err) {
    LOG.warn('KgCommunity read failed; diversity filter no-ops:', err.message);
  }

  const conceptSlugsById = new Map();
  for (const c of editorialConceptsById.values()) if (c.slug) conceptSlugsById.set(c.ID, lower(c.slug));
  for (const c of conceptMetaBySlug.values()) if (c.ID) conceptSlugsById.set(c.ID, lower(c.slug));

  // Use CDS path expansion to get tutorial slug alongside concept_ID
  const links = await tx.run(SELECT.from(TutorialConceptLinks).columns('tutorial.slug as tutorial_slug','concept_ID').where({ predicate: 'teaches' }));
  const trRows = await tx.run(SELECT.from(TutorialRank).columns('slug','score').orderBy('score desc','slug asc'));
  const rankBySlug = new Map(trRows.map(r => [lower(r.slug), r.score]));
  const tutorialRanksByConcept = new Map();
  for (const l of links) {
    const cs = conceptSlugsById.get(l.concept_ID);
    if (!cs) continue;
    const ts = lower(l.tutorial_slug);
    if (!ts) continue;
    if (!tutorialRanksByConcept.has(cs)) tutorialRanksByConcept.set(cs, []);
    tutorialRanksByConcept.get(cs).push({ tutorialSlug: ts, score: rankBySlug.has(ts) ? rankBySlug.get(ts) : 0 });
  }
  for (const arr of tutorialRanksByConcept.values()) {
    arr.sort((a, b) => (b.score - a.score) || a.tutorialSlug.localeCompare(b.tutorialSlug));
  }

  const tutorialsBySlug = new Set();
  const tuts = await tx.run(SELECT.from(Tutorials).columns('slug').where(`status = 'ACTIVE' or status is null`));
  for (const t of tuts) tutorialsBySlug.add(lower(t.slug));
  try {
    const missions = await tx.run(SELECT.from(Missions).columns('slug').where(`status = 'ACTIVE' or status is null`));
    for (const m of missions) tutorialsBySlug.add(lower(m.slug));
  } catch (err) {
    LOG.warn('Missions read failed in loadInputs; slug set will be incomplete:', err.message);
  }

  // #1783 — loose freshness floor: drop genuinely ancient tutorials from the
  // Featured eligibility set so they can't be PageRank-ranked onto the curated
  // carousel. Signal is TutorialMeta.reviewedDate (git last-commit date,
  // monotonic-guarded) — NOT Tutorials.modifiedAt, which churns catalog-wide on
  // every --force rebuild. reviewedDate is NULL for ~half of rows; a NULL (or a
  // missing meta row) KEEPS the tutorial (fail-open). Missions carry no
  // reviewedDate and are therefore always kept. The cutoff is admin-configurable
  // via ImsConfig with a generous default. This is the sole chokepoint — the
  // pure selectFeaturedTopics needs no change.
  let eligibleSlugs = tutorialsBySlug;
  try {
    const maxAgeDays = await resolveFreshnessMaxAgeDays(tx);
    if (maxAgeDays > 0) {
      // Unbounded read (like the Concepts read above): one row per tutorial, a
      // handful of short columns — well under HANA's packet ceiling, and no
      // WHERE slug IN (…) that would blow it.
      const metaRows = await tx.run(SELECT.from(TutorialMeta).columns('tutorial.slug as slug', 'reviewedDate'));
      const reviewedMsBySlug = new Map();
      for (const r of metaRows) {
        const s = lower(r.slug);
        if (!s || r.reviewedDate == null) continue; // NULL reviewedDate → keep (never recorded)
        const ms = new Date(r.reviewedDate).getTime();
        if (!Number.isFinite(ms)) continue;
        const prev = reviewedMsBySlug.get(s);
        if (prev == null || ms > prev) reviewedMsBySlug.set(s, ms); // most-recent wins across dup meta rows
      }
      const { kept, dropped } = applyFreshnessFilter(tutorialsBySlug, reviewedMsBySlug, maxAgeDays);
      eligibleSlugs = kept;
      if (dropped.length) LOG.info(`featured freshness floor (${maxAgeDays}d) dropped ${dropped.length} stale tutorial(s) from eligibility`);
    }
  } catch (err) {
    // Fail OPEN: a filter fault must never gut the carousel — keep the full set.
    LOG.warn('featured freshness filter failed; keeping full eligibility set:', err.message);
    eligibleSlugs = tutorialsBySlug;
  }

  return { editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug: eligibleSlugs };
}

export async function recomputeSnapshot(tx) {
  const { FeaturedTopicsSnapshot } = cds.entities(NS);
  const inputs = await loadInputs(tx);
  const slots = selectFeaturedTopics({ ...inputs, targetCount: TARGET_COUNT, missionsPerSlide: MISSIONS_PER_SLIDE });
  const computedAt = new Date().toISOString();

  await tx.run(DELETE.from(FeaturedTopicsSnapshot));
  if (slots.length) {
    await tx.run(INSERT.into(FeaturedTopicsSnapshot).entries(
      slots.map((s, i) => ({
        slotOrder: i + 1,
        source: s.source,
        conceptSlug: s.conceptSlug,
        displayTitle: s.displayTitle || '',
        missionSlugs: s.missionSlugs,
        computedAt,
      })),
    ));
  }
  LOG.info(`recomputeSnapshot wrote ${slots.length} slots`);
  return { count: slots.length, computedAt: new Date(computedAt) };
}

export async function readSnapshotForFeed(tx) {
  const { FeaturedTopicsSnapshot, Tutorials, Missions } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(FeaturedTopicsSnapshot).orderBy('slotOrder asc'));
  if (!rows.length) {
    return { computedAt: null, slots: [], etag: computeSnapshotEtag({ computedAt: new Date(0), slots: [] }) };
  }
  const allSlugs = new Set();
  for (const r of rows) for (const s of (r.missionSlugs || [])) allSlugs.add(lower(s));
  const slugList = [...allSlugs];

  const cardBySlug = new Map();
  if (slugList.length) {
    // (a) Tutorial metadata via CDS QL — excludes LargeString to avoid LOB locator expiry on HANA
    const tRows = await tx.run(SELECT.from(Tutorials)
      .columns('slug','title','experienceTag','averageTimeToComplete','primaryTag')
      .where({ slug: { in: slugList } })
      .and(`status = 'ACTIVE' or status is null`));

    // (b) Tutorial descriptions via a separate query — LOB-safe on HANA
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    let descBySlug = new Map();
    if (isHana) {
      const placeholders = slugList.map(() => '?').join(',');
      const descRows = await db.run(
        `SELECT "SLUG", "DESCRIPTION" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "SLUG" IN (${placeholders})`,
        slugList
      );
      // (#1032 followup) NCLOB columns come back from the HANA node driver as
      // Node Buffer instances. Decode to UTF-8 up front (see decodeDescription
      // above) so both the /build/featured-topics build-time fetch and the
      // /homepage/featuredTopics() hydration payload carry plain strings.
      descBySlug = new Map(descRows.map(r => {
        const slug = lower(r.SLUG ?? r.slug);
        return [slug, decodeDescription(r.DESCRIPTION ?? r.description)];
      }));
    } else {
      const descRows = await tx.run(SELECT.from(Tutorials).columns('slug','description').where({ slug: { in: slugList } }));
      descBySlug = new Map(descRows.map(r => [lower(r.slug), r.description || '']));
    }

    for (const c of tRows) {
      const slug = lower(c.slug);
      cardBySlug.set(slug, {
        slug,
        kind: 'tutorial',
        title: c.title,
        description: descBySlug.get(slug) || '',
        level: c.experienceTag || null,
        time: c.averageTimeToComplete || null,
        primaryTag: c.primaryTag || null,
        tutorialCount: 1,
        href: `/tutorials/${slug}`,
        isNew: false,
      });
    }

    try {
      const mRows = await tx.run(SELECT.from(Missions)
        .columns('slug','title','primaryTag')
        .where({ slug: { in: slugList } })
        .and(`status = 'ACTIVE' or status is null`));
      for (const c of mRows) {
        const slug = lower(c.slug);
        cardBySlug.set(slug, {
          slug,
          kind: 'mission',
          title: c.title,
          description: '',
          level: null,
          time: null,
          primaryTag: c.primaryTag || null,
          tutorialCount: null,
          href: `/tutorials/mission-${slug}`,
          isNew: false,
        });
      }
    } catch (err) {
      LOG.warn('Missions read failed in readSnapshotForFeed; mission slots will be missing:', err.message);
    }
  }

  const computedAt = rows[0].computedAt;
  const slots = rows.map(r => ({
    slotOrder: r.slotOrder,
    source: r.source,
    conceptSlug: r.conceptSlug,
    displayTitle: r.displayTitle,
    missions: (r.missionSlugs || []).map(s => cardBySlug.get(lower(s))).filter(Boolean),
  }));
  const etag = computeSnapshotEtag({
    computedAt,
    slots: rows.map(r => ({ slotOrder: r.slotOrder, conceptSlug: r.conceptSlug, missionSlugs: r.missionSlugs || [] })),
  });
  return { computedAt: new Date(computedAt), slots, etag };
}
