// srv/lib/concept-input-digest.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';

// Pure, testable core: canonicalize probe rows (sort by table name) → sha256.
export function digestFromProbes(probes) {
  const canon = [...probes]
    .map(p => ({ t: p.t, max: p.max ?? '', n: p.n ?? 0 }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .map(p => `${p.t}:${p.max}:${p.n}`)
    .join('|');
  return createHash('sha256').update(canon, 'utf-8').digest('hex');
}

// Each entry: [tableLogicalName, entityRef, tsColumn, extraWhere?]
// CommunityEventConceptLinks has no `managed` → use extractedAt.
// Published concepts: aggregate base Concepts with the publish gate.
export async function computeConceptInputDigest(db, namespace) {
  const ims = cds.entities(namespace);
  const ext = cds.entities(`${namespace}.external`);
  const probes = [];
  const probe = async (t, ent, tsCol, where) => {
    let q = SELECT.one.from(ent).columns(`max(${tsCol}) as mx`, 'count(*) as n');
    if (where) q = q.where(where);
    const r = await db.run(q);
    probes.push({ t, max: r?.mx ? String(r.mx) : '', n: Number(r?.n ?? 0) });
  };
  await probe('Concepts', ims.Concepts, 'modifiedAt', { publishedAt: { '!=': null }, status: 'ACTIVE' });
  await probe('ConceptEdges', ims.ConceptEdges, 'modifiedAt');
  await probe('TutorialConceptLinks', ims.TutorialConceptLinks, 'modifiedAt');
  await probe('LearningJourneyConceptLinks', ext.LearningJourneyConceptLinks, 'modifiedAt');
  await probe('BlogPostConceptLinks', ext.BlogPostConceptLinks, 'modifiedAt');
  await probe('DiscoveryMissionConceptLinks', ext.DiscoveryMissionConceptLinks, 'modifiedAt');
  await probe('VideoConceptLinks', ext.VideoConceptLinks, 'modifiedAt');
  await probe('ApiDocConceptLinks', ext.ApiDocConceptLinks, 'modifiedAt');
  await probe('SampleConceptLinks', ext.SampleConceptLinks, 'modifiedAt');
  await probe('HelpDocConceptLinks', ext.HelpDocConceptLinks, 'modifiedAt');
  await probe('CommunityEventConceptLinks', ext.CommunityEventConceptLinks, 'extractedAt'); // no managed
  await probe('CommunityEvents', ext.CommunityEvents, 'modifiedAt');
  return digestFromProbes(probes);
}
