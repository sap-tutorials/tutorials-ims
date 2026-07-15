// srv/lib/build-topic-clusters.js
//
// Express middleware backing GET /build/topic-clusters (#1170).
// Pattern matches srv/lib/build-concepts.js: unauthenticated, read direct
// from the db service, consumed by scripts/fetch-topic-clusters.ts at Hugo
// build time.
//
// Joins Louvain topic clusters (KgCommunityLabel, #1126) to their live
// tutorial members and returns the top-N labeled clusters for the homepage
// "topic cluster" band.  Fail-open: any throw yields { clusters: [] } so a
// backend hiccup never 500s a build.

import cds from '@sap/cds';

const log = cds.log('build-topic-clusters');

const MAX_CLUSTERS = 6;        // clusters shown in the band
const MIN_TUTORIALS = 3;       // gate: a cluster needs >= this many live tutorials
const MAX_TUTORIALS_PER_CARD = 4;
const NS = 'com.sap.developers.ims';

export async function buildTopicClustersPayload(db) {
  const buildAt = new Date().toISOString();
  try {
    const { KgCommunityLabel, KgCommunitySummaryV, KgCommunity, Tutorials } = cds.entities(NS);

    // 1. All labeled communities (small table).
    const labels = await db.run(
      SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label', 'rationale')
    );
    if (!labels || labels.length === 0) return { clusters: [], buildAt, error: null };

    // 2. fingerprint -> tutorialCount, to rank + gate.
    const summary = await db.run(
      SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount')
    );
    const countByFp = new Map();
    for (const r of summary) {
      // KgCommunitySummaryV aggregates per communityId; a fingerprint can span
      // multiple ids across a Louvain pass — keep the max tutorialCount seen.
      const prev = countByFp.get(r.communityFingerprint) ?? 0;
      if ((r.tutorialCount ?? 0) > prev) countByFp.set(r.communityFingerprint, r.tutorialCount ?? 0);
    }

    // 3. Keep labeled fingerprints that clear the min gate; rank; take top-N.
    //    (Over-fetch a few extra so the post-resolution re-gate in step 6 can
    //    still fill MAX_CLUSTERS if a borderline cluster loses tutorials.)
    const ranked = labels
      .map(l => ({ ...l, tutorialCount: countByFp.get(l.communityFingerprint) ?? 0 }))
      .filter(l => l.tutorialCount >= MIN_TUTORIALS)
      .sort((a, b) => b.tutorialCount - a.tutorialCount)
      .slice(0, MAX_CLUSTERS * 2);

    const clusters = [];
    for (const cluster of ranked) {
      if (clusters.length >= MAX_CLUSTERS) break;

      // 4. Tutorial-typed members for this fingerprint; lowercase slugs
      //    (canonical-slug gotcha).
      const members = await db.run(
        SELECT.from(KgCommunity)
          .columns('slug')
          .where({ communityFingerprint: cluster.communityFingerprint, vertexType: 'tutorial' })
      );
      const memberSlugs = [...new Set(members.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
      if (memberSlugs.length < MIN_TUTORIALS) continue;

      // 5. Resolve to live tutorials (ACTIVE or NULL status), title ASC.
      const live = await db.run(
        SELECT.from(Tutorials)
          .columns('slug', 'title')
          .where({ slug: { in: memberSlugs } })
          .and(`status = 'ACTIVE' or status is null`)
          .orderBy('title asc')
      );

      // 6. Re-gate on resolved live count; cap per-card; build url.
      if (live.length < MIN_TUTORIALS) continue;
      clusters.push({
        label: cluster.label,
        rationale: cluster.rationale,
        communityFingerprint: cluster.communityFingerprint,
        tutorialCount: cluster.tutorialCount,
        tutorials: live.slice(0, MAX_TUTORIALS_PER_CARD).map(t => ({
          slug: t.slug,
          title: t.title,
          url: `/tutorials/${t.slug}`,
        })),
      });
    }

    return { clusters, buildAt, error: null };
  } catch (err) {
    log.error('failed to build /build/topic-clusters payload', err);
    return { clusters: [], buildAt, error: 'topic_clusters_build_failed' };
  }
}

export async function buildTopicClustersHandler(_req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicClustersPayload(db);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(payload);
}
