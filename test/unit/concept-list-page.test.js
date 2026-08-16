import { describe, it, expect } from 'vitest';
import {
  buildConceptListModel,
  renderConceptListBody,
} from '../../srv/lib/concept-list-page.js';

// Task 2 of docs/superpowers/plans/2026-07-08-concepts-scale.md (#1327).
// GET /content/concepts-index list-page backend. buildConceptListModel is
// dep-injected with buildConceptsPayload so unit tests need no HANA.
// renderConceptListBody emits the /concepts/ BODY (the concepts-index
// article + embedded JSON) — the handler composes it into __shell__ via the
// existing composeShell path (mirrors renderCatalogPage for groups/missions).

function makePayload(concepts) {
  return { concepts, generatedAt: '2026-07-27T00:00:00.000Z' };
}

// A fake db — unit tests never touch it directly; ConceptRank is injected via
// the fetchRankRows dep so no loaded CDS model is required.
const fakeDb = {};

// fetchRankRows dep: return rows, or a thrower to exercise fail-open.
function ranker(rows) {
  return async () => {
    if (typeof rows === 'function') return rows();
    return rows;
  };
}

const THREE = [
  {
    slug: 'cap', name: 'CAP', description: 'SAP Cloud Application Programming Model.',
    teaches: [{ slug: 't1', title: 'A' }, { slug: 't2', title: 'B' }],
    requires: [], requiredBy: [], relatedTo: [],
    learningJourneys: [{ slug: 'lj', title: 'x', url: 'https://x' }],
    blogPosts: [], discoveryMissions: [], videos: [], apiDocs: [], samples: [],
    helpDocs: [], communityEvents: [],
  },
  {
    slug: 'hana', name: 'HANA Cloud', description: 'In-memory DB.',
    teaches: [], requires: [], requiredBy: [], relatedTo: [],
    learningJourneys: [], blogPosts: [], discoveryMissions: [], videos: [],
    apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
  },
  {
    slug: '3d-thing', name: '3D thing', description: 'Numeric first char.',
    teaches: [{ slug: 't3', title: 'C' }], requires: [], requiredBy: [], relatedTo: [],
    learningJourneys: [], blogPosts: [], discoveryMissions: [], videos: [],
    apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
  },
];

const buildConceptsPayload = async () => makePayload(THREE);

describe('buildConceptListModel', () => {
  it('projects slim cards with tutorialCount and firstLetter, no phase-4 leak', async () => {
    const model = await buildConceptListModel(fakeDb, { buildConceptsPayload, fetchRankRows: ranker([]) });
    expect(model.cards).toHaveLength(3);
    expect(model.count).toBe(3);
    const cap = model.cards.find(c => c.slug === 'cap');
    expect(cap).toEqual({
      slug: 'cap',
      name: 'CAP',
      description: 'SAP Cloud Application Programming Model.',
      tutorialCount: 2,
      firstLetter: 'C',
    });
    // no phase-4 arrays leaked onto the slim card
    expect(cap).not.toHaveProperty('teaches');
    expect(cap).not.toHaveProperty('learningJourneys');
  });

  it('tutorialCount equals teaches.length (0 when none)', async () => {
    const model = await buildConceptListModel(fakeDb, { buildConceptsPayload, fetchRankRows: ranker([]) });
    expect(model.cards.find(c => c.slug === 'hana').tutorialCount).toBe(0);
    expect(model.cards.find(c => c.slug === '3d-thing').tutorialCount).toBe(1);
  });

  it('firstLetter uppercases alpha and buckets non-alpha under #', async () => {
    const model = await buildConceptListModel(fakeDb, { buildConceptsPayload, fetchRankRows: ranker([]) });
    expect(model.cards.find(c => c.slug === 'hana').firstLetter).toBe('H');
    expect(model.cards.find(c => c.slug === '3d-thing').firstLetter).toBe('#');
  });

  it('orders top by ConceptRank score desc', async () => {
    const rank = [
      { slug: 'hana', score: 9.0 },
      { slug: 'cap', score: 5.0 },
      { slug: '3d-thing', score: 1.0 },
    ];
    const model = await buildConceptListModel(fakeDb, { buildConceptsPayload, fetchRankRows: ranker(rank) });
    expect(model.top.map(c => c.slug)).toEqual(['hana', 'cap', '3d-thing']);
  });

  it('fails open to alphabetical top when ConceptRank query throws', async () => {
    const model = await buildConceptListModel(
      fakeDb,
      { buildConceptsPayload, fetchRankRows: ranker(() => { throw new Error('HANA down'); }) },
    );
    // alphabetical by name: '3D thing', 'CAP', 'HANA Cloud'
    expect(model.top.map(c => c.name)).toEqual(['3D thing', 'CAP', 'HANA Cloud']);
    // cards still present
    expect(model.cards).toHaveLength(3);
  });

  it('caps top at 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      slug: `c${i}`, name: `Concept ${i}`, description: 'd',
      teaches: [], requires: [], requiredBy: [], relatedTo: [],
      learningJourneys: [], blogPosts: [], discoveryMissions: [], videos: [],
      apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
    }));
    const model = await buildConceptListModel(
      fakeDb,
      { buildConceptsPayload: async () => makePayload(many), fetchRankRows: ranker([]) },
    );
    expect(model.cards).toHaveLength(150);
    expect(model.top).toHaveLength(100);
  });
});

describe('renderConceptListBody', () => {
  const model = {
    cards: THREE.map(c => ({
      slug: c.slug, name: c.name, description: c.description,
      tutorialCount: c.teaches.length,
      firstLetter: /[A-Z]/.test((c.name[0] || '').toUpperCase()) ? c.name[0].toUpperCase() : '#',
    })),
    get top() { return this.cards; },
    count: 3,
    version: 7,
  };

  it('carries the card/grid CSS so SSR cards are not bare links (#1327 regression)', () => {
    const body = renderConceptListBody(model);
    // The inline <style> block Hugo's list.html had — it never shipped in a
    // global stylesheet, so the CAP list page must carry it or the top-100
    // SSR <li> render as unstyled links (the bug this guards).
    expect(body).toContain('<style>');
    expect(body).toContain('.concepts-index__list');
    expect(body).toContain('grid-template-columns');
    expect(body).toContain('.concepts-index__item');
    expect(body).toContain('.concepts-index__link');
  });

  it('emits the concepts-index article shell with island hook IDs', () => {
    const body = renderConceptListBody(model);
    expect(body).toContain('id="concepts-filter-root"');
    expect(body).toContain('id="concepts-filter-list"');
    expect(body).toContain('id="concepts-filter-controls"');
    expect(body).toContain('id="concepts-filter-count"');
    // The island src is now content-hashed when srv/lib/island-manifest.json
    // exists (written by build:island-manifest after build:apps). The test
    // matches the prefix to stay valid both when the manifest is present
    // (hashed: /js/concepts-filter-<hash>.js) and when it's absent
    // (bare fallback: /js/concepts-filter.js, e.g. in a CI environment that
    // hasn't run build:apps yet).
    expect(body).toMatch(/\/js\/concepts-filter[\w-]*\.js/);
  });

  it('emits one SSR <li> per top card (min(100,N))', () => {
    const body = renderConceptListBody(model);
    const liCount = (body.match(/class="concepts-index__item"/g) || []).length;
    expect(liCount).toBe(3);
    expect(body).toContain('data-slug="cap"');
    expect(body).toContain('data-tutorial-count="2"');
    expect(body).toContain('data-first-letter="#"'); // 3d-thing
  });

  it('embeds the full slim array as JSON in #concepts-data', () => {
    const body = renderConceptListBody(model);
    const m = body.match(/<script type="application\/json" id="concepts-data">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const arr = JSON.parse(m[1]);
    expect(arr).toHaveLength(3);
    expect(arr[0]).toHaveProperty('slug');
    expect(arr[0]).toHaveProperty('tutorialCount');
  });

  it('renders a noscript A-Z fallback', () => {
    const body = renderConceptListBody(model);
    expect(body).toContain('<noscript>');
    expect(body).toMatch(/Showing \d+ of 3/);
  });

  it('renders empty-state and NO #concepts-data when count is 0', () => {
    const body = renderConceptListBody({ cards: [], top: [], count: 0, version: 7 });
    expect(body).toContain('No published concepts yet');
    expect(body).not.toContain('id="concepts-data"');
  });

  it('HTML-escapes name and description (XSS)', () => {
    const body = renderConceptListBody({
      cards: [{ slug: 'x', name: '<script>alert(1)</script>', description: 'A & B "q"', tutorialCount: 0, firstLetter: '#' }],
      top: [{ slug: 'x', name: '<script>alert(1)</script>', description: 'A & B "q"', tutorialCount: 0, firstLetter: '#' }],
      count: 1, version: 7,
    });
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // JSON blob also carries the raw value but safely inside a JSON string —
    // ensure the closing </script> of an injected value can't break out.
    expect(body).not.toMatch(/<\/script>\s*alert/);
  });
});
