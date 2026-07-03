// test/unit/srv/help-doc-payload.test.js
//
// Phase 4.7 (#748): assert /build/concepts payload includes helpDocs[] per
// concept. Mirrors published-concepts-query-with-samples.test.js for the
// LOB-locator safety pattern (LargeString description omitted from SELECT).

import { describe, it, beforeAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — helpDocs field (Phase 4.7)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  it('every concept has a helpDocs array (empty when no links)', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const now = new Date().toISOString();
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries({
      slug: 'lonely-hd', name: 'Lonely HD', description: 'd',
      status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c',
    });
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.helpDocs)).toBe(true);
    }
    const lonely = payload.concepts.find(c => c.slug === 'lonely-hd');
    expect(lonely.helpDocs).toEqual([]);
  });

  it('populates helpDocs[] sorted by source ASC, title ASC', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const now = new Date().toISOString();
    await DELETE.from(HelpDocConceptLinks);
    await DELETE.from(HelpDocs);
    await DELETE.from(Concepts);

    await INSERT.into(Concepts).entries({
      slug: 'multi-hd', name: 'Multi HD', description: 'd',
      status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c',
    });
    const multi = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'multi-hd' });

    await INSERT.into(HelpDocs).entries([
      { slug: 'hd-help-sap-com__x', source: 'help-sap-com', product: 'btp', section: null,
        title: 'Zebra', url: 'https://help.sap.com/z', description: 'x',
        sourceId: 'z', contentHash: 'h1', firstSeenAt: now, lastSeenAt: now },
      { slug: 'hd-cap-cloud-sap__y', source: 'cap-cloud-sap', product: 'cap', section: null,
        title: 'Apple', url: 'https://cap.cloud.sap/a', description: 'apple body',
        sourceId: 'a', contentHash: 'h2', firstSeenAt: now, lastSeenAt: now },
      { slug: 'hd-ui5-sap-com__u', source: 'ui5-sap-com', product: 'ui5', section: null,
        title: 'Umbrella', url: 'https://ui5.sap.com/u', description: 'x',
        sourceId: 'u', contentHash: 'h3', firstSeenAt: now, lastSeenAt: now },
    ]);
    const z = await SELECT.one.from(HelpDocs).columns('ID').where({ slug: 'hd-help-sap-com__x' });
    const a = await SELECT.one.from(HelpDocs).columns('ID').where({ slug: 'hd-cap-cloud-sap__y' });
    const u = await SELECT.one.from(HelpDocs).columns('ID').where({ slug: 'hd-ui5-sap-com__u' });

    await INSERT.into(HelpDocConceptLinks).entries([
      { helpDoc_ID: z.ID, concept_ID: multi.ID, predicate: 'explains',
        confidence: 0.9, anchor: null, snippet: 'zebra…', extractedAt: now },
      { helpDoc_ID: a.ID, concept_ID: multi.ID, predicate: 'explains',
        confidence: 0.9, anchor: 'before-create', snippet: 'apple body…', extractedAt: now },
      { helpDoc_ID: u.ID, concept_ID: multi.ID, predicate: 'explains',
        confidence: 0.9, anchor: null, snippet: 'umbrella…', extractedAt: now },
    ]);

    const payload = await buildConceptsPayload(cds.db);
    const multiPayload = payload.concepts.find(c => c.slug === 'multi-hd');
    expect(multiPayload.helpDocs).toHaveLength(3);
    // source ASC: cap-cloud-sap < help-sap-com < ui5-sap-com
    expect(multiPayload.helpDocs.map(hd => hd.source)).toEqual([
      'cap-cloud-sap', 'help-sap-com', 'ui5-sap-com',
    ]);
  });

  it('sourceLabel mapping: cap-cloud-sap → CAP, help-sap-com → SAP Help, ui5-sap-com → UI5, architecture-sap-com → Architecture Center', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const now = new Date().toISOString();

    // Insert an architecture-sap-com row + link so the label mapping is
    // exercised end-to-end for the fourth source (#860).
    await INSERT.into(HelpDocs).entries([{
      slug: 'hd-architecture-sap-com__ra0001', source: 'architecture-sap-com',
      product: 'architecture', section: null,
      title: 'RA0001', url: 'https://architecture.learning.sap.com/docs/ref-arch/RA0001',
      description: 'ref arch body', sourceId: 'docs/ref-arch/RA0001.md',
      contentHash: 'h4', firstSeenAt: now, lastSeenAt: now,
    }]);
    const arch = await SELECT.one.from(HelpDocs).columns('ID').where({ slug: 'hd-architecture-sap-com__ra0001' });
    const multi = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'multi-hd' });
    await INSERT.into(HelpDocConceptLinks).entries([{
      helpDoc_ID: arch.ID, concept_ID: multi.ID, predicate: 'explains',
      confidence: 0.9, anchor: null, snippet: 'ra0001…', extractedAt: now,
    }]);

    const payload = await buildConceptsPayload(cds.db);
    const multiPayload = payload.concepts.find(c => c.slug === 'multi-hd');
    const labels = new Map(multiPayload.helpDocs.map(hd => [hd.source, hd.sourceLabel]));
    expect(labels.get('cap-cloud-sap')).toBe('CAP');
    expect(labels.get('help-sap-com')).toBe('SAP Help');
    expect(labels.get('ui5-sap-com')).toBe('UI5');
    expect(labels.get('architecture-sap-com')).toBe('Architecture Center');
  });

  it('derives anchorLabel from anchor (title-case, dashes → spaces); null-safe', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const multi = payload.concepts.find(c => c.slug === 'multi-hd');
    const withAnchor = multi.helpDocs.find(hd => hd.anchor === 'before-create');
    expect(withAnchor.anchorLabel).toBe('Before Create');
    const nullAnchor = multi.helpDocs.find(hd => hd.anchor === null);
    expect(nullAnchor.anchorLabel).toBeNull();
  });

  it('reads snippet from HelpDocConceptLinks.snippet column (NOT description; LOB-locator safety)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const multi = payload.concepts.find(c => c.slug === 'multi-hd');
    for (const hd of multi.helpDocs) {
      expect(hd).not.toHaveProperty('description');
      expect(typeof hd.snippet).toBe('string');
    }
    const apple = multi.helpDocs.find(hd => hd.title === 'Apple');
    expect(apple.snippet).toBe('apple body…');
  });

  it('caps at 8 rows per concept', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const now = new Date().toISOString();
    // Fresh concept — don't blow away 'multi-hd', we'll query 'over-cap' specifically.
    await INSERT.into(Concepts).entries({
      slug: 'over-cap', name: 'Over Cap', description: 'd',
      status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c',
    });
    const over = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'over-cap' });

    const docsPayload = Array.from({ length: 10 }, (_, i) => ({
      slug: `hd-cap-cloud-sap__over-${i}`, source: 'cap-cloud-sap', product: 'cap', section: null,
      title: `Over T${String(i).padStart(2, '0')}`, url: `https://x/${i}`, description: 'x',
      sourceId: `over-${i}`, contentHash: `over-h${i}`, firstSeenAt: now, lastSeenAt: now,
    }));
    await INSERT.into(HelpDocs).entries(docsPayload);
    const docRows = await SELECT.from(HelpDocs).columns('ID', 'slug').where({ slug: { like: 'hd-cap-cloud-sap__over-%' } });
    const links = docRows.map((d, i) => ({
      helpDoc_ID: d.ID, concept_ID: over.ID, predicate: 'explains',
      confidence: 0.9, anchor: null, snippet: `s${i}`, extractedAt: now,
    }));
    await INSERT.into(HelpDocConceptLinks).entries(links);

    const payload = await buildConceptsPayload(cds.db);
    const overPayload = payload.concepts.find(c => c.slug === 'over-cap');
    expect(overPayload.helpDocs).toHaveLength(8);
  });
});
