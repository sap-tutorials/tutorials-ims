import cds from '@sap/cds';
import { orderConcepts } from './topic-path-order.js';
import { loadRankMaps } from '../knowledge-graph-service.js';

const NS = 'com.sap.developers.ims';
const MAX_TOP_CONCEPTS = 4;
const MAX_PEERS = 6;

export async function buildTopicsGalleryPayload(db) {
  const buildAt = new Date().toISOString();
  try {
    const { TopicClusters, KgCommunity, Concepts, ConceptEdges } = cds.entities(NS);

    const clusters = await db.run(
      SELECT.from(TopicClusters).where({ status: 'ACTIVE', hidden: false })
    );
    if (!clusters.length) return { gallery: [], clusters: {}, buildAt, error: null };

    // fingerprint -> cluster
    const clusterByFp = new Map(clusters.map((c) => [c.fingerprint, c]));

    // concept memberships (all clusters at once, bucket in Node)
    const conceptMembers = await db.run(
      SELECT.from(KgCommunity).columns('communityFingerprint', 'slug').where({ vertexType: 'concept' })
    );
    const conceptSlugsByFp = new Map();
    const fpBySlug = new Map();
    for (const m of conceptMembers) {
      const fp = m.communityFingerprint;
      if (!clusterByFp.has(fp)) continue;
      const slug = (m.slug || '').toLowerCase();
      if (!slug) continue;
      (conceptSlugsByFp.get(fp) || conceptSlugsByFp.set(fp, []).get(fp)).push(slug);
      fpBySlug.set(slug, fp);
    }

    // concept names + rank
    const allConceptSlugs = [...fpBySlug.keys()];
    const conceptRows = allConceptSlugs.length
      ? await db.run(SELECT.from(Concepts).columns('ID', 'slug', 'name').where({ slug: { in: allConceptSlugs } }))
      : [];
    const nameBySlug = new Map(conceptRows.map((r) => [(r.slug || '').toLowerCase(), r.name]));
    const idToSlug = new Map(conceptRows.map((r) => [r.ID, (r.slug || '').toLowerCase()]));

    let rankMaps = { conceptRank: new Map() };
    try { rankMaps = await loadRankMaps(); } catch { /* fail-open: no ranks */ }
    const rankBySlug = rankMaps.conceptRank || new Map();

    // requires edges (ACTIVE) + inter-cluster peer weights
    const edges = await db.run(
      SELECT.from(ConceptEdges).columns('source_ID', 'target_ID', 'predicate').where({ status: 'ACTIVE' })
    );
    const requiresBySlugPair = [];
    const peerWeight = new Map(); // `${aSlug}|${bSlug}` -> count
    for (const e of edges) {
      const s = idToSlug.get(e.source_ID);
      const t = idToSlug.get(e.target_ID);
      if (!s || !t) continue;
      if (e.predicate === 'requires') requiresBySlugPair.push({ source: s, target: t });
      const fpS = fpBySlug.get(s);
      const fpT = fpBySlug.get(t);
      if (fpS && fpT && fpS !== fpT) {
        const cs = clusterByFp.get(fpS).slug;
        const ct = clusterByFp.get(fpT).slug;
        const key = cs < ct ? `${cs}|${ct}` : `${ct}|${cs}`;
        peerWeight.set(key, (peerWeight.get(key) || 0) + 1);
      }
    }

    // assemble per-cluster detail + gallery card
    const labelOf = (c) => c.curatedLabel || c.label;
    const clusterDetail = {};
    const gallery = [];
    for (const c of clusters) {
      const memberSlugs = conceptSlugsByFp.get(c.fingerprint) || [];
      const concepts = memberSlugs.map((s) => ({ slug: s, name: nameBySlug.get(s) || s, rank: rankBySlug.get(s) || 0 }));
      const clusterRequires = requiresBySlugPair.filter((p) => memberSlugs.includes(p.source) && memberSlugs.includes(p.target));
      const { ordered, mode } = orderConcepts({ concepts, requiresEdges: clusterRequires, rankBySlug });
      const topConcepts = [...concepts].sort((a, b) => b.rank - a.rank).slice(0, MAX_TOP_CONCEPTS).map((x) => ({ slug: x.slug, name: x.name }));

      const peers = [];
      for (const [key, weight] of peerWeight) {
        const [a, b] = key.split('|');
        if (a === c.slug || b === c.slug) {
          const otherSlug = a === c.slug ? b : a;
          const other = clusters.find((x) => x.slug === otherSlug);
          if (other) peers.push({ slug: otherSlug, label: labelOf(other), weight });
        }
      }
      peers.sort((x, y) => y.weight - x.weight);

      clusterDetail[c.slug] = {
        slug: c.slug, label: labelOf(c), rationale: c.rationale || '',
        memberCount: c.memberCount, tutorialCount: c.tutorialCount,
        orderMode: mode, concepts: ordered.map((x) => ({ slug: x.slug, name: x.name })),
        peers: peers.slice(0, MAX_PEERS),
      };
      gallery.push({
        slug: c.slug, label: labelOf(c), rationale: c.rationale || '',
        memberCount: c.memberCount, tutorialCount: c.tutorialCount, topConcepts,
      });
    }
    gallery.sort((a, b) => (b.tutorialCount * Math.log(1 + b.memberCount)) - (a.tutorialCount * Math.log(1 + a.memberCount)));

    return { gallery, clusters: clusterDetail, buildAt, error: null };
  } catch (err) {
    cds.log('build-topics-gallery').error('failed', err);
    return { gallery: [], clusters: {}, buildAt, error: 'topics_gallery_build_failed' };
  }
}

export async function buildTopicsGalleryHandler(_req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicsGalleryPayload(db);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(payload);
}

export default { buildTopicsGalleryPayload, buildTopicsGalleryHandler };
