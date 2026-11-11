import { describe, it, expect } from 'vitest';
import { renderConceptDetail } from '../srv/lib/concept-detail-render.js';

// #3095 — hub concepts (e.g. sap-btp-fundamentals, 235 "build on this") dump
// hundreds of tiles. KG-relationship sections cap at N=24; overflow moves into
// a no-JS <details>. Phase-4 external sections are left uncapped.
const mk = (n) => Array.from({ length: n }, (_, i) => ({ slug: `c${i}`, title: `Concept ${i}` }));
const base = { slug: 'x', name: 'X', description: '' };
const sectionOf = (body, heading) =>
  body.match(new RegExp(`${heading}[\\s\\S]*?</section>`))?.[0] ?? '';

describe('#3095 — KG relationship cap (N=24)', () => {
  it('no <details> when requiredBy.length === 24 (boundary)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(24) }, {});
    const sec = sectionOf(body, 'Concepts that build on this');
    expect(sec).not.toMatch(/<details/);
    expect((sec.match(/<li>/g) || []).length).toBe(24);
  });

  it('one item inside <details> when requiredBy.length === 25 (boundary)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(25) }, {});
    const sec = sectionOf(body, 'Concepts that build on this');
    expect(sec).toMatch(/<details/);
    const inside = sec.match(/<details[\s\S]*?<\/details>/)[0];
    expect((inside.match(/<li>/g) || []).length).toBe(1);
    expect(sec).toMatch(/Show all 25/);
  });

  it('235-item hub collapses overflow (24 visible, 211 in details)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(235) }, {});
    const sec = sectionOf(body, 'Concepts that build on this');
    const inside = sec.match(/<details[\s\S]*?<\/details>/)[0];
    expect((inside.match(/<li>/g) || []).length).toBe(211);
    // total visible + collapsed === 235
    expect((sec.match(/<li>/g) || []).length).toBe(235);
  });

  it('escapes titles rendered inside the collapsed overflow half', () => {
    const items = mk(25);
    items[24].title = '<script>x</script>';
    const { body } = renderConceptDetail({ ...base, requiredBy: items }, {});
    expect(body).not.toMatch(/<script>x<\/script>/);
    expect(body).toMatch(/&lt;script&gt;/);
  });

  it('leaves an uncapped external section (phase4 videos) untouched', () => {
    const { body } = renderConceptDetail(
      { ...base },
      { videos: mk(30).map((v) => ({ ...v, url: 'https://example.test' })) },
    );
    const sec = sectionOf(body, 'Videos teaching this');
    if (sec) expect(sec).not.toMatch(/<details/);
  });
});
