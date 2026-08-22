// srv/lib/build-topic-cluster-content.js
//
// Resolves one Louvain community (by communityFingerprint) into normalized
// content items across all KG-linked types. Direct members (tutorial/mission/
// group) resolve by slug; everything else via concept-hop
// (KgCommunity concept members → Concepts → <Type>ConceptLinks → content).
// Fail-open per type; packet-cap chunked. Pure ranking lives in
// topic-cluster-content.js.

import cds from '@sap/cds';
import { CONTENT_TYPES, hrefFor, isNewFrom, computeRank } from './topic-cluster-content.js';

const log = cds.log('build-topic-cluster-content');
const NS = 'com.sap.developers.ims';
const EXT = 'com.sap.developers.ims.external';

export function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function whereForContent(entity, kind, slugsLower) {
  // Direct-member visibility filters. slugsLower already lowercased.
  const q = SELECT.from(entity).columns('slug', 'title').where({ slug: { in: slugsLower } });
  if (kind === 'tutorial') return q.and(`status = 'ACTIVE' or status is null`);
  return q.and({ published: true }); // mission/group
}

async function resolveDirect(db, desc, fingerprint) {
  const { KgCommunity } = cds.entities(NS);
  const members = await db.run(
    SELECT.from(KgCommunity).columns('slug')
      .where({ communityFingerprint: fingerprint, vertexType: desc.vertexType })
  );
  const slugs = [...new Set(members.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
  if (!slugs.length) return [];
  const { [desc.contentEntity]: Entity } = cds.entities(NS);
  const rows = [];
  for (const c of chunk(slugs)) rows.push(...await db.run(whereForContent(Entity, desc.kind, c)));
  return rows.map(r => ({ kind: desc.kind, slug: r.slug, title: r.title, url: null, confidence: 1, dateMs: null }));
}

async function resolveConceptHop(db, desc, conceptIds, nowMs) {
  if (!conceptIds.length) return [];
  const { [desc.linkEntity]: Link } = cds.entities(EXT);
  const linkRows = [];
  for (const c of chunk(conceptIds)) {
    linkRows.push(...await db.run(
      SELECT.from(Link).columns(desc.contentFk, 'confidence').where({ concept_ID: { in: c } })
    ));
  }
  // best confidence per content id
  const confById = new Map();
  for (const r of linkRows) {
    const id = r[desc.contentFk];
    if (!id) continue;
    const prev = confById.get(id) ?? 0;
    if ((r.confidence ?? 0.7) > prev) confById.set(id, r.confidence ?? 0.7);
  }
  const ids = [...confById.keys()];
  if (!ids.length) return [];
  const cols = ['ID', 'slug', desc.titleField, desc.urlField];
  if (desc.dateField) cols.push(desc.dateField); // scalar dates only — never NCLOB description
  const { [desc.contentEntity]: Entity } = cds.entities(EXT);
  const rows = [];
  for (const c of chunk(ids)) {
    let q = SELECT.from(Entity).columns(...cols).where({ ID: { in: c } });
    if (desc.statusFilter === 'video') q = q.and({ excludeFromHomepage: false });
    rows.push(...await db.run(q));
  }
  return rows.map(r => {
    const dateVal = desc.dateField ? r[desc.dateField] : null;
    return {
      kind: desc.kind, slug: r.slug, title: r[desc.titleField], url: r[desc.urlField],
      confidence: confById.get(r.ID) ?? 0.7,
      dateMs: dateVal ? Date.parse(dateVal) : null,
      _isNew: isNewFrom(dateVal, nowMs),
    };
  });
}

export async function resolveClusterContent(db, fingerprint, { tiers, rankMaps = null, nowMs = Date.now() }) {
  const descs = CONTENT_TYPES.filter(d => tiers.includes(d.tier));
  const needsConcept = descs.some(d => d.source === 'concept');

  // Resolve concept ids once (shared across all concept-hop types).
  let conceptIds = [];
  if (needsConcept) {
    try {
      const { KgCommunity, Concepts } = cds.entities(NS);
      const cm = await db.run(
        SELECT.from(KgCommunity).columns('slug')
          .where({ communityFingerprint: fingerprint, vertexType: 'concept' })
      );
      const cslugs = [...new Set(cm.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
      const crows = [];
      for (const c of chunk(cslugs)) {
        crows.push(...await db.run(
          SELECT.from(Concepts).columns('ID', 'slug').where({ slug: { in: c } }).and({ status: 'ACTIVE' })
        ));
      }
      conceptIds = crows.map(r => r.ID);
    } catch (err) {
      log.warn('concept-id resolution failed; concept-hop types skipped', err);
      conceptIds = [];
    }
  }

  const items = [];
  for (const desc of descs) {
    try {
      const raw = desc.source === 'direct'
        ? await resolveDirect(db, desc, fingerprint)
        : await resolveConceptHop(db, desc, conceptIds, nowMs);
      for (const it of raw) {
        it._nowMs = nowMs;
        items.push({
          kind: it.kind,
          slug: it.slug,
          title: it.title,
          href: hrefFor(it.kind, it.slug, it.url),
          isNew: it._isNew ?? false,
          rank: computeRank(it, rankMaps),
        });
      }
    } catch (err) {
      log.warn(`topic-cluster resolve failed for kind=${desc.kind}; skipping`, err);
    }
  }
  // De-dupe by kind+slug (a slug can appear via multiple concepts).
  const seen = new Set();
  return items.filter(it => {
    const k = `${it.kind}:${it.slug}`;
    if (seen.has(k) || !it.href) return false;
    seen.add(k);
    return true;
  });
}
