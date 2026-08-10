// srv/jobs/kg-topic-clusters-job.js
// Nightly reconciliation of Louvain KG communities into the stable-slug
// TopicClusters sidecar (#topics-discovery). Runs 04:47 UTC, after
// Louvain (03:57), labeling (04:12), WCC (04:07), FeaturedTopics (04:13),
// retire-orphans (04:37). Fail-open: throws after metric so the scheduler
// chassis writes PipelineLog FAILED while yesterday's rows survive
// (TRUNCATE is inside the tx which rolls back on error).
//
// Admin curatedLabel/hidden overrides are carried forward across every
// nightly TRUNCATE via overridesBySlug built from the pre-run snapshot.
//
// Spec: docs/superpowers/specs/2026-08-09-topics-discovery-front-door/

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';
import { reconcile } from '../lib/topic-cluster-reconcile.js';

const LOG = cds.log('kg-topic-clusters');
const NS = 'com.sap.developers.ims';
const TABLE = '"COM_SAP_DEVELOPERS_IMS_TOPICCLUSTERS"';
const INSERT_BATCH_SIZE = 500;
const JACCARD_THRESHOLD = Number(process.env.KG_TOPIC_CLUSTERS_JACCARD || '0.5');

/**
 * Read KgCommunityLabel + KgCommunity + KgCommunitySummaryV + current
 * TopicClusters and shape into { communities, existing, rationaleByFp,
 * overridesBySlug } for reconcile(). Exported for unit testing.
 *
 * @param {object} db - cds db connection (real or fake for tests)
 * @returns {{ communities, existing, rationaleByFp, overridesBySlug }}
 */
export async function _buildCommunitiesInput(db) {
  const { KgCommunity, KgCommunityLabel, KgCommunitySummaryV, TopicClusters } = cds.entities(NS);

  // Only labeled fingerprints qualify for the /topics/ gallery.
  const labels = await db.run(SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label', 'rationale'));
  const labelByFp = new Map(labels.map((l) => [l.communityFingerprint, l.label]));
  const rationaleByFp = new Map(labels.map((l) => [l.communityFingerprint, l.rationale || '']));

  // All KgCommunity memberships; bucket by fingerprint in JS.
  const members = await db.run(SELECT.from(KgCommunity).columns('communityFingerprint', 'vertexType', 'slug'));
  const tutMembersByFp = new Map();   // fp -> Set(tutorial slugs, lowercased)
  const allMembersByFp = new Map();   // fp -> Set(all slugs, lowercased)
  for (const m of members) {
    if (!m.communityFingerprint || !m.slug) continue;
    const fp = m.communityFingerprint;
    const slug = m.slug.toLowerCase();
    if (!allMembersByFp.has(fp)) allMembersByFp.set(fp, new Set());
    allMembersByFp.get(fp).add(slug);
    if (m.vertexType === 'tutorial') {
      if (!tutMembersByFp.has(fp)) tutMembersByFp.set(fp, new Set());
      tutMembersByFp.get(fp).add(slug);
    }
  }

  // tutorialCount from the summary view (pre-aggregated by communityFingerprint).
  const summaries = await db.run(SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount'));
  const tutCountByFp = new Map();
  for (const s of summaries) {
    if (!s.communityFingerprint) continue;
    const prev = tutCountByFp.get(s.communityFingerprint) || 0;
    if ((s.tutorialCount || 0) > prev) tutCountByFp.set(s.communityFingerprint, s.tutorialCount || 0);
  }

  // Build the communities array (only fingerprints with a KgCommunityLabel row).
  const communities = [];
  for (const [fp, label] of labelByFp) {
    const tutSet = tutMembersByFp.get(fp) || new Set();
    const allSet = allMembersByFp.get(fp) || new Set();
    const memberSlugsArr = [...tutSet];
    communities.push({
      fingerprint: fp,
      label,
      rationale: rationaleByFp.get(fp) || '',
      memberSlugs: memberSlugsArr,            // matching basis = tutorial slugs only
      memberSlugsBlob: memberSlugsArr.join('\n').slice(0, 5000), // persisted for C1 fix
      memberCount: allSet.size,
      tutorialCount: tutCountByFp.get(fp) || tutSet.size,
    });
  }

  // Current TopicClusters — needed both for reconcile() and for carrying
  // forward admin overrides (curatedLabel/hidden) across the nightly TRUNCATE.
  // Also read memberSlugsBlob so we can Jaccard-match against LAST night's
  // member set, not this run's (C1 fix: fingerprint has changed on drift, so
  // tutMembersByFp.get(r.fingerprint) would return undefined → empty set →
  // Jaccard=0 → slug re-minted every night).
  const existingRows = await db.run(
    SELECT.from(TopicClusters).columns('slug', 'fingerprint', 'previousFingerprints', 'status', 'curatedLabel', 'hidden', 'memberSlugsBlob')
  );

  // Use the persisted blob (last night's member set) as the matching basis so
  // that a drifted fingerprint can still be recognised by overlap.
  const existing = existingRows.map((r) => ({
    ...r,
    memberSlugs: r.memberSlugsBlob ? r.memberSlugsBlob.split('\n').filter(Boolean) : [],
  }));

  // Admin overrides keyed by stable slug — carried forward across TRUNCATE.
  const overridesBySlug = new Map(
    existingRows.map((r) => [r.slug, { curatedLabel: r.curatedLabel || null, hidden: !!r.hidden }])
  );

  return { communities, existing, rationaleByFp, overridesBySlug };
}

/**
 * Run the nightly TopicClusters reconciliation.
 * @returns {{ clusters, minted, reused, retired, durationMs }}
 */
export async function runKgTopicClusters() {
  const started = Date.now();
  const db = await cds.connect.to('db');
  try {
    const { communities, existing, rationaleByFp, overridesBySlug } = await _buildCommunitiesInput(db);
    const { upserts, retired } = reconcile({ existing, communities, threshold: JACCARD_THRESHOLD });

    // Build a lookup from fingerprint → memberSlugsBlob for the write step.
    const memberSlugsBlobByFp = new Map(communities.map((c) => [c.fingerprint, c.memberSlugsBlob || '']));

    const now = new Date().toISOString();
    // minted = new slugs (no pre-existing match, so previousFingerprints is empty)
    const minted = upserts.filter((u) => !u.previousFingerprints).length;
    const reused = upserts.length - minted;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${TABLE}`);

      const insertSql = `INSERT INTO ${TABLE}
        ("SLUG","LABEL","CURATEDLABEL","RATIONALE","FINGERPRINT","PREVIOUSFINGERPRINTS","STATUS","HIDDEN","MEMBERCOUNT","TUTORIALCOUNT","MEMBERSLUGSBLOB","COMPUTEDAT")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

      const rows = [
        ...upserts.map((u) => {
          const ov = overridesBySlug.get(u.slug) || { curatedLabel: null, hidden: false };
          return [
            u.slug,
            u.label,
            ov.curatedLabel,
            rationaleByFp.get(u.fingerprint) || '',
            u.fingerprint,
            u.previousFingerprints || '',
            'ACTIVE',
            ov.hidden ? 1 : 0,
            u.memberCount || 0,
            u.tutorialCount || 0,
            memberSlugsBlobByFp.get(u.fingerprint) || '',
            now,
          ];
        }),
        ...retired.map((slug) => {
          const ov = overridesBySlug.get(slug) || { curatedLabel: null, hidden: false };
          return [slug, '', ov.curatedLabel, '', '', '', 'RETIRED', ov.hidden ? 1 : 0, 0, 0, '', now];
        }),
      ];

      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        await tx.run(insertSql, rows.slice(i, i + INSERT_BATCH_SIZE));
      }
    });

    const durationMs = Date.now() - started;
    metrics.observe('kg_topic_clusters_duration_ms', durationMs);
    metrics.gauge('kg_topic_clusters_count', upserts.length);
    metrics.gauge('kg_topic_clusters_minted', minted);
    metrics.gauge('kg_topic_clusters_reused', reused);
    metrics.gauge('kg_topic_clusters_retired', retired.length);
    LOG.info(`[kg-topic-clusters] ${upserts.length} clusters (${minted} minted, ${reused} reused), ${retired.length} retired in ${durationMs}ms`);
    return { clusters: upserts.length, minted, reused, retired: retired.length, durationMs };
  } catch (err) {
    metrics.counter('kg_topic_clusters_failures');
    LOG.error('[kg-topic-clusters] failed', err);
    throw err;
  }
}

export default { runKgTopicClusters };
