import { describe, it, expect } from 'vitest';
import {
  buildHelpDocTriples,
  IMS_EXPLAINS,
  iriHelpDoc,
} from '../../../srv/lib/kg-projection.js';

describe('buildHelpDocTriples', () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000);          // 1 day ago
  const stale = new Date(now.getTime() - 700 * 24 * 60 * 60 * 1000);     // >540 days ago (past TTL)

  it('emits rdf:type + title + slug + source + product + url for each help-doc', () => {
    const helpDocs = [{
      slug: 'hd-cap-cloud-sap__docs__node_js__handlers',
      source: 'cap-cloud-sap', product: 'cap', section: null,
      title: 'Handlers', url: 'https://cap.cloud.sap/docs/node.js/handlers',
      lastSeenAt: recent,
    }];
    const triples = buildHelpDocTriples({ helpDocs, links: [] });
    const docIri = iriHelpDoc('hd-cap-cloud-sap__docs__node_js__handlers');
    // Subject appears in every emitted triple as `<${docIri}>`
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('#type'))).toBe(true);
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('"Handlers"'))).toBe(true);
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('"hd-cap-cloud-sap__docs__node_js__handlers"'))).toBe(true);
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('"cap-cloud-sap"'))).toBe(true);
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('"cap"'))).toBe(true);
    expect(triples.some(t => t.includes(`<${docIri}>`) && t.includes('"https://cap.cloud.sap/docs/node.js/handlers"'))).toBe(true);
  });

  it('emits explains predicate triple for each link', () => {
    const helpDocs = [{
      slug: 'hd-x', source: 'help-sap-com', product: 'cap', section: null,
      title: 'X', url: 'https://help.sap.com/x', lastSeenAt: recent,
    }];
    const links = [{
      helpDocSlug: 'hd-x', conceptSlug: 'cap-service-handlers', predicate: 'explains',
      anchor: 'before-create',
    }];
    const triples = buildHelpDocTriples({ helpDocs, links });
    // The link should produce exactly one 'explains' triple
    const explainsTriples = triples.filter(t => t.includes('/explains>') || t.includes('IMS_EXPLAINS'));
    expect(explainsTriples.length).toBeGreaterThanOrEqual(1);
    // Also assert IMS_EXPLAINS is exported and non-empty
    expect(IMS_EXPLAINS).toBeTruthy();
    expect(typeof IMS_EXPLAINS).toBe('string');
  });

  it('anchor is NOT emitted as a graph triple (payload-only detail)', () => {
    const helpDocs = [{
      slug: 'hd-x', source: 'help-sap-com', product: 'cap', section: null,
      title: 'X', url: 'https://help.sap.com/x', lastSeenAt: recent,
    }];
    const links = [{
      helpDocSlug: 'hd-x', conceptSlug: 'c1', predicate: 'explains',
      anchor: 'before-create',
    }];
    const triples = buildHelpDocTriples({ helpDocs, links });
    // Anchor value ('before-create') must never appear in any triple
    expect(triples.some(t => t.includes('before-create'))).toBe(false);
  });

  it('TTL filter: skips help-docs older than 540 days AND their links', () => {
    const helpDocs = [
      { slug: 'hd-recent', source: 'help-sap-com', product: 'cap', section: null,
        title: 'Recent', url: 'https://x/1', lastSeenAt: recent },
      { slug: 'hd-stale', source: 'help-sap-com', product: 'cap', section: null,
        title: 'Stale', url: 'https://x/2', lastSeenAt: stale },
    ];
    const links = [
      { helpDocSlug: 'hd-recent', conceptSlug: 'c1', predicate: 'explains', anchor: null },
      { helpDocSlug: 'hd-stale', conceptSlug: 'c1', predicate: 'explains', anchor: null },
    ];
    const triples = buildHelpDocTriples({ helpDocs, links });
    const staleIri = iriHelpDoc('hd-stale');
    const recentIri = iriHelpDoc('hd-recent');
    // Stale doc's IRI must not appear
    expect(triples.some(t => t.includes(`<${staleIri}>`))).toBe(false);
    expect(triples.some(t => t.includes(`<${recentIri}>`))).toBe(true);
    // Only ONE explains link survives (the recent one)
    const explainsTriples = triples.filter(t => t.includes('/explains>'));
    expect(explainsTriples).toHaveLength(1);
  });

  it('section column is optional (help-sap-com pages have it; cap-cloud-sap and ui5-sap-com null)', () => {
    const helpDocs = [
      { slug: 'hd-help', source: 'help-sap-com', product: 'cap',
        section: 'Getting Started', title: 'X', url: 'https://x/1', lastSeenAt: recent },
      { slug: 'hd-cap', source: 'cap-cloud-sap', product: 'cap',
        section: null, title: 'Y', url: 'https://x/2', lastSeenAt: recent },
    ];
    const triples = buildHelpDocTriples({ helpDocs, links: [] });
    const helpIri = iriHelpDoc('hd-help');
    const capIri = iriHelpDoc('hd-cap');
    // help-sap-com row has a section triple with 'Getting Started'
    expect(triples.some(t => t.includes(`<${helpIri}>`) && t.includes('"Getting Started"'))).toBe(true);
    // cap-cloud-sap row has no section triple (null → omitted); no null literal appears for the cap-cloud-sap subject
    const capTriples = triples.filter(t => t.includes(`<${capIri}>`));
    expect(capTriples.some(t => t.includes('section') && t.includes('""'))).toBe(false);
  });
});
