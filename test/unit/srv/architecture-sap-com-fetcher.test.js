import { describe, it, expect, beforeEach } from 'vitest';
import {
  fetchArchitectureSapComCorpus,
  _setMockFetcher,
  _resetForTests,
} from '../../../srv/lib/help-docs/architecture-sap-com-fetcher.js';
import treeFixture from './__fixtures__/arch-sap-com-tree.json' assert { type: 'json' };
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const refArchMd = readFileSync(
  fileURLToPath(new URL('./__fixtures__/arch-sap-com-ref-arch.md', import.meta.url)),
  'utf8'
);
const newsMdx = readFileSync(
  fileURLToPath(new URL('./__fixtures__/arch-sap-com-news.md', import.meta.url)),
  'utf8'
);

describe('architecture-sap-com-fetcher', () => {
  beforeEach(() => { _resetForTests(); });

  it('enumerates .md and .mdx under docs/ + news/; skips api/, images, root README', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return treeFixture;
      return refArchMd;   // any raw fetch returns non-empty body
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake' });
    // 4 docs/ .md|.mdx  +  1 news/ .mdx  =  5 rows
    // api/, .png, root README rejected
    expect(rows).toHaveLength(5);
    expect(rows.every(r => r.source === 'architecture-sap-com')).toBe(true);
    expect(rows.every(r => r.product === 'architecture')).toBe(true);
    expect(rows.every(r => r.section === null)).toBe(true);
    expect(rows.map(r => r.sourceId).sort()).toEqual([
      'docs/community/contribution.md',
      'docs/golden-path/ai-golden-path.md',
      'docs/ref-arch/RA0001.md',
      'docs/ref-arch/RA0002.mdx',
      'news/2026-06-agentic-code-quality.mdx',
    ]);
  });

  it('derives canonical URL from file path, dropping .md or .mdx extension', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return {
        ...treeFixture,
        tree: [treeFixture.tree[0], treeFixture.tree[1], treeFixture.tree[4]],
      };
      return refArchMd;
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake' });
    const byId = Object.fromEntries(rows.map(r => [r.sourceId, r.url]));
    expect(byId['docs/ref-arch/RA0001.md']).toBe('https://architecture.learning.sap.com/docs/ref-arch/RA0001');
    expect(byId['docs/ref-arch/RA0002.mdx']).toBe('https://architecture.learning.sap.com/docs/ref-arch/RA0002');
    expect(byId['news/2026-06-agentic-code-quality.mdx']).toBe('https://architecture.learning.sap.com/news/2026-06-agentic-code-quality');
  });

  it('title precedence: frontmatter > H1 > filename', async () => {
    // File 1: frontmatter title present → win
    // File 2: no frontmatter, has H1 → win
    // File 3: no frontmatter, no H1 → filename fallback
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return {
        ...treeFixture,
        tree: [
          treeFixture.tree[0],   // docs/ref-arch/RA0001.md (frontmatter title)
          treeFixture.tree[2],   // docs/golden-path/ai-golden-path.md (no fm, has H1)
          treeFixture.tree[3],   // docs/community/contribution.md (no fm, no H1)
        ],
      };
      if (url.endsWith('/RA0001.md')) return refArchMd;
      if (url.endsWith('/ai-golden-path.md')) return '# Golden Path\n\nBody.\n' + 'x '.repeat(120);
      if (url.endsWith('/contribution.md')) return 'Just a bunch of plain body text. '.repeat(20);
      throw new Error(`unexpected fetch url ${url}`);
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake' });
    const byId = Object.fromEntries(rows.map(r => [r.sourceId, r.title]));
    expect(byId['docs/ref-arch/RA0001.md']).toBe('Reference Architecture RA0001');
    expect(byId['docs/golden-path/ai-golden-path.md']).toBe('Golden Path');
    expect(byId['docs/community/contribution.md']).toBe('contribution');
  });

  it('strips MDX imports + JSX components; description ≤ 2000 chars', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return {
        ...treeFixture,
        tree: [treeFixture.tree[4]],   // news/…mdx
      };
      return newsMdx;
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake' });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.description).not.toMatch(/^import/);
    expect(row.description).not.toMatch(/<Callout|<Diagram/);
    expect(row.description).not.toMatch(/Callout body that must be stripped/);
    expect(row.description).toMatch(/Agentic code quality/);
    expect(row.description.length).toBeLessThanOrEqual(2000);
  });

  it('propagates tree-fetch failure as a thrown error (partial-catalog is orchestrator concern)', async () => {
    _setMockFetcher(async () => {
      const err = new Error('GitHub 500'); err.status = 500; throw err;
    });
    await expect(fetchArchitectureSapComCorpus({ apiKey: 'fake' })).rejects.toThrow(/500/);
  });

  it('skips per-blob raw failures (partial catalog survives)', async () => {
    let call = 0;
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return {
        ...treeFixture,
        tree: [treeFixture.tree[0], treeFixture.tree[2]],
      };
      call++;
      if (call === 1) {
        const err = new Error('raw 502'); err.status = 502; throw err;
      }
      return refArchMd;
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake' });
    expect(rows).toHaveLength(1);   // one blob's raw fetch failed; the other survives
  });

  it('honors seenSourceIds pass-through', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return treeFixture;
      return refArchMd;
    });
    const seen = new Set([
      'docs/ref-arch/RA0001.md',
      'docs/ref-arch/RA0002.mdx',
    ]);
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake', seenSourceIds: seen });
    expect(rows.map(r => r.sourceId)).not.toContain('docs/ref-arch/RA0001.md');
    expect(rows.map(r => r.sourceId)).not.toContain('docs/ref-arch/RA0002.mdx');
  });

  it('honors limit cap', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return treeFixture;
      return refArchMd;
    });
    const rows = await fetchArchitectureSapComCorpus({ apiKey: 'fake', limit: 2 });
    expect(rows).toHaveLength(2);
  });
});
