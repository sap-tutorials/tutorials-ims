# SAP Architecture Center as 4th help-doc source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [#860](https://github.com/sap-tutorials/tutorials-ims/issues/860)
**Spec:** [`docs/superpowers/specs/2026-07-03-860-arch-center-help-doc-source.md`](../specs/2026-07-03-860-arch-center-help-doc-source.md)
**Parent spec:** [`docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md`](../specs/2026-07-01-748-phase4.7-help-docs.md)

**Goal:** Add `architecture.learning.sap.com` (repo `SAP/architecture-center`) as the fourth source feeding the existing Phase 4.7 `HelpDocs` entity, without changing schema, cron cadence, sidebar rendering, or concept-page layout.

**Architecture:** New fetcher `srv/lib/help-docs/architecture-sap-com-fetcher.js` mirrors `cap-cloud-sap-fetcher.js` (GitHub tree + raw file fetch). Wire into `srv/lib/help-docs/index.js` orchestrator (Promise.allSettled, SOURCE_PRECEDENCE, FETCHER_BY_SOURCE, perSource shape). Extend `HELP_DOC_SOURCE_LABEL` and the cron `summary.perSource` init with one new key. Zero UI branches — sidebar and concept-page templates iterate over source-label at runtime.

**Tech Stack:** Node 22, ESM, Vitest, `@sap/cds`, native `fetch`, GitHub REST API v3, MDX-aware markdown stripping.

## Global Constraints

- **Fetcher shape:** row schema `{source, sourceId, title, description, url, product, section}` — matches Phase 4.7 §4.1 verbatim.
- **`description` cap:** 2000 chars post-strip. Skip rows with empty description.
- **Slug format:** `hd-<source>__<canonicalized-path>`, 150-char ceiling. Do NOT re-implement `canonicalizeHelpDocPath`.
- **Test isolation:** every new fetcher module uses the `globalThis[Symbol.for(...)] ??= { mockFetcher: null }` seam pattern from the three existing fetchers. `_setMockFetcher` and `_resetForTests` are required exports.
- **Auth:** `apiKey` is a caller-provided GitHub token. Omit the `Authorization` header when it is falsy (never send `Bearer undefined`).
- **Node ≥ 20** — native `fetch`, `AbortSignal.timeout` are available. No polyfills.
- **New helper `_strip-markdown.js`** MUST be a private-module (leading underscore) under `srv/lib/help-docs/` and re-exported from both `cap-cloud-sap-fetcher.js` (refactor) and the new `architecture-sap-com-fetcher.js`.
- **Precedence:** `architecture-sap-com` = 4 (highest). Existing values (`cap-cloud-sap=3`, `ui5-sap-com=2`, `help-sap-com=1`) are unchanged.
- **Source label:** `'Architecture Center'` (verbatim, capital A + capital C, one space).

---

### Task 1: Extract shared markdown stripper (refactor prep)

Extract the `stripMarkdown` helper currently duplicated in `cap-cloud-sap-fetcher.js` into a shared private module so both fetchers can consume it, and add the two MDX-specific regexes (JSX components + top-of-file `import` lines) needed by the Architecture Center fetcher.

**Files:**
- Create: `srv/lib/help-docs/_strip-markdown.js`
- Modify: `srv/lib/help-docs/cap-cloud-sap-fetcher.js`
- Create: `test/unit/srv/strip-markdown.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `export function stripMarkdown(md: string): string` — MDX + MD safe.

- [ ] **Step 1: Write the failing test**

Create `test/unit/srv/strip-markdown.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../../../srv/lib/help-docs/_strip-markdown.js';

describe('_strip-markdown', () => {
  it('removes fenced code blocks', () => {
    expect(stripMarkdown('a\n```\nfoo\n```\nb')).toBe('a b');
  });

  it('removes inline code, links, and markdown syntax', () => {
    expect(stripMarkdown('# H\n\n[title](url) is `x`')).toBe('H title is');
  });

  it('collapses whitespace and trims', () => {
    expect(stripMarkdown('  a  \n\n  b  ')).toBe('a b');
  });

  it('handles null/undefined/empty gracefully', () => {
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
    expect(stripMarkdown('')).toBe('');
  });

  it('removes MDX top-of-file import statements', () => {
    const mdx = "import Foo from './Foo';\nimport { Bar } from '@site/x';\n\nBody text here.";
    expect(stripMarkdown(mdx)).toBe('Body text here.');
  });

  it('removes JSX-style component blocks', () => {
    const mdx = 'Before <MyComponent prop="x">inner text</MyComponent> after.';
    expect(stripMarkdown(mdx)).toBe('Before after.');
  });

  it('removes self-closing JSX components', () => {
    const mdx = 'A <Diagram src="foo.svg" /> B';
    expect(stripMarkdown(mdx)).toBe('A B');
  });

  it('leaves plain markdown untouched by MDX regexes', () => {
    // Sanity: JSX-only patterns must not accidentally chew plain-markdown emphasis.
    // Lowercase-first tokens (h1, x) are NOT matched by the JSX component regex,
    // which only fires on Capitalized-first component names.
    expect(stripMarkdown('lorem <br/> ipsum')).toBe('lorem <br/> ipsum');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/strip-markdown.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared module**

Create `srv/lib/help-docs/_strip-markdown.js`:

```js
// srv/lib/help-docs/_strip-markdown.js
//
// Shared markdown/MDX text-stripper used by help-docs fetchers.
// Handles both .md (help-sap-com fallback, cap-cloud-sap) and .mdx
// (architecture-sap-com) input. Emits plain text suitable for
// LLM-embedding input, with fenced code, inline code, links, and MDX
// scaffolding removed.
//
// Extracted from cap-cloud-sap-fetcher.js to keep the two consumers in
// sync. Adding the JSX-component + top-import regexes here does NOT
// change output on pure .md input — Capitalized-first component names
// and top-of-file import lines do not appear in plain markdown.

export function stripMarkdown(md) {
  return String(md || '')
    .replace(/^import\s+[^\n]+\n/gm, ' ')                          // MDX top-of-file imports
    .replace(/<[A-Z][A-Za-z0-9]*[^>]*\/>/g, ' ')                    // self-closing MDX components
    .replace(/<[A-Z][A-Za-z0-9]*[^>]*>[\s\S]*?<\/[A-Z][A-Za-z0-9]*>/g, ' ')  // opening+closing MDX components
    .replace(/```[\s\S]*?```/g, ' ')                                // fenced code blocks
    .replace(/`[^`]*`/g, ' ')                                       // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                        // links → text
    .replace(/[#>*_~`]/g, ' ')                                      // markdown syntax
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/strip-markdown.test.js`
Expected: PASS — 8/8 cases green.

- [ ] **Step 5: Refactor cap-cloud-sap-fetcher.js to consume the shared helper**

In `srv/lib/help-docs/cap-cloud-sap-fetcher.js`, DELETE the local `stripMarkdown` function (lines 120-128) and REPLACE its usage by importing from `_strip-markdown.js`.

At the top of the imports block (line 10, before the `SYM` line):

```js
import { stripMarkdown } from './_strip-markdown.js';
```

Delete the entire `function stripMarkdown(md) { … }` block at the bottom of the file (currently lines 120-128).

- [ ] **Step 6: Run the existing cap-cloud-sap-fetcher tests to confirm no regression**

Run: `npx vitest run test/unit/srv/cap-cloud-sap-fetcher.test.js`
Expected: PASS — all existing cases still green (proves the refactor is behavior-preserving on plain .md).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/help-docs/_strip-markdown.js srv/lib/help-docs/cap-cloud-sap-fetcher.js test/unit/srv/strip-markdown.test.js
git commit -m "refactor(#860): extract shared MDX-aware stripMarkdown helper"
```

---

### Task 2: Fixtures for the Architecture Center fetcher

Create the three fixtures used by the fetcher unit test in Task 3.

**Files:**
- Create: `test/unit/srv/__fixtures__/arch-sap-com-tree.json`
- Create: `test/unit/srv/__fixtures__/arch-sap-com-ref-arch.md`
- Create: `test/unit/srv/__fixtures__/arch-sap-com-news.md`

**Interfaces:**
- Consumes: nothing.
- Produces: three static fixtures consumed by `architecture-sap-com-fetcher.test.js` in Task 3.

- [ ] **Step 1: Create the GitHub-tree fixture**

Create `test/unit/srv/__fixtures__/arch-sap-com-tree.json`:

```json
{
  "sha": "fake-sha",
  "url": "https://api.github.com/repos/SAP/architecture-center/git/trees/fake-sha",
  "tree": [
    { "path": "docs/ref-arch/RA0001.md",             "mode": "100644", "type": "blob", "sha": "b1", "size": 1200, "url": "https://api.github.com/blobs/b1" },
    { "path": "docs/ref-arch/RA0002.mdx",            "mode": "100644", "type": "blob", "sha": "b2", "size": 1400, "url": "https://api.github.com/blobs/b2" },
    { "path": "docs/golden-path/ai-golden-path.md",  "mode": "100644", "type": "blob", "sha": "b3", "size": 900,  "url": "https://api.github.com/blobs/b3" },
    { "path": "docs/community/contribution.md",      "mode": "100644", "type": "blob", "sha": "b4", "size": 600,  "url": "https://api.github.com/blobs/b4" },
    { "path": "news/2026-06-agentic-code-quality.mdx","mode": "100644","type": "blob", "sha": "b5", "size": 1100, "url": "https://api.github.com/blobs/b5" },
    { "path": "api/plugins/some-internal-page.md",   "mode": "100644", "type": "blob", "sha": "b6", "size": 500,  "url": "https://api.github.com/blobs/b6" },
    { "path": "docs/ref-arch/diagram.png",           "mode": "100644", "type": "blob", "sha": "b7", "size": 20000,"url": "https://api.github.com/blobs/b7" },
    { "path": "README.md",                            "mode": "100644","type": "blob", "sha": "b8", "size": 300,  "url": "https://api.github.com/blobs/b8" }
  ],
  "truncated": false
}
```

- [ ] **Step 2: Create the reference-architecture MD fixture**

Create `test/unit/srv/__fixtures__/arch-sap-com-ref-arch.md`:

```md
---
title: Reference Architecture RA0001
authors: [alice, bob]
tags: [ai, integration]
---

# Should Not Appear As Title

Reference architecture for AI-native inference workloads on SAP BTP.

Overview: this pattern uses `@sap-ai/inference` bindings and connects to SAP HANA Cloud via a [Destination Service](https://help.sap.com/x) endpoint.

```yaml
# ignored code block
key: value
```

The architecture supports both batch and streaming ingestion paths.
```

- [ ] **Step 3: Create the news MDX fixture**

Create `test/unit/srv/__fixtures__/arch-sap-com-news.md` (note: `.md` extension for the fixture file even though the *content* is MDX-flavored — the fetcher content-detects by content, not extension):

```md
---
title: The Agentic Code Quality Funnel
date: 2026-06-14
---

import Diagram from '@site/src/components/Diagram';
import { Callout } from '@site/src/components/Callout';

<Callout type="info">
This is a Callout body that must be stripped.
</Callout>

Agentic code quality is a top-of-funnel practice for AI-assisted development.

<Diagram src="funnel.svg" />

The funnel narrows through review gates.
```

- [ ] **Step 4: Commit**

```bash
git add test/unit/srv/__fixtures__/arch-sap-com-*.{json,md}
git commit -m "test(#860): fixtures for architecture-sap-com fetcher"
```

---

### Task 3: Architecture Center fetcher module + unit test

Implement the new fetcher and its four-case unit test.

**Files:**
- Create: `srv/lib/help-docs/architecture-sap-com-fetcher.js`
- Create: `test/unit/srv/architecture-sap-com-fetcher.test.js`

**Interfaces:**
- Consumes: `stripMarkdown` from `_strip-markdown.js` (Task 1).
- Produces:
  - `export async function fetchArchitectureSapComCorpus({ apiKey, seenSourceIds, limit }): Promise<Array<HelpDocRow>>` where `HelpDocRow` matches the Phase 4.7 shape, with `source: 'architecture-sap-com'` and `product: 'architecture'`.
  - `export function _setMockFetcher(fn)` and `export function _resetForTests()`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/srv/architecture-sap-com-fetcher.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/architecture-sap-com-fetcher.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fetcher**

Create `srv/lib/help-docs/architecture-sap-com-fetcher.js`:

```js
// srv/lib/help-docs/architecture-sap-com-fetcher.js
//
// #860: SAP Architecture Center narrative-docs fetcher (fourth source).
// Direct GitHub REST API against SAP/architecture-center. Single tree call
// gives all .md/.mdx files under docs/ and news/; per-file raw fetch pulls
// the markdown body. Auth via TUTORIALS_GITHUB_TOKEN.
//
// Spec: docs/superpowers/specs/2026-07-03-860-arch-center-help-doc-source.md §4.2
// Parent: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.3

import { stripMarkdown } from './_strip-markdown.js';

const SYM = Symbol.for('com.sap.developers.ims.architecture-sap-com-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const REPO = 'SAP/architecture-center';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=true`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const SITE_BASE = 'https://architecture.learning.sap.com';
const PER_PAGE_TIMEOUT_MS = 30_000;
const DESCRIPTION_MAX_CHARS = 2000;

export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

/**
 * @typedef {Object} HelpDocRow
 * @property {'architecture-sap-com'} source
 * @property {string} sourceId       — repo-relative path, e.g. 'docs/ref-arch/RA0001.md'
 * @property {string} title
 * @property {string} description    — stripped body first 2000 chars
 * @property {string} url            — https://architecture.learning.sap.com/<path-without-extension>
 * @property {'architecture'} product
 * @property {null} section
 */

export async function fetchArchitectureSapComCorpus({
  apiKey,
  seenSourceIds = null,
  limit = null,
} = {}) {
  const tree = await fetchTree(apiKey);
  const blobs = (tree.tree || []).filter(
    (e) =>
      e.type === 'blob'
      && (e.path.startsWith('docs/') || e.path.startsWith('news/'))
      && (e.path.endsWith('.md') || e.path.endsWith('.mdx'))
  );

  const rows = [];
  for (const blob of blobs) {
    if (limit != null && rows.length >= limit) break;
    if (seenSourceIds && seenSourceIds.has(blob.path)) continue;

    let raw;
    try {
      raw = await fetchRaw(blob.path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('architecture-sap-com-fetcher: raw fetch failed', {
        path: blob.path,
        status: err?.status,
        message: err?.message,
      });
      continue;
    }

    const { frontmatterTitle, body } = parseFrontmatter(raw);
    const filenameTitle = blob.path.split('/').pop().replace(/\.mdx?$/, '');
    const title = frontmatterTitle || extractH1(body) || filenameTitle;

    const description = stripMarkdown(body).slice(0, DESCRIPTION_MAX_CHARS);
    if (description.length === 0) continue;

    rows.push({
      source: 'architecture-sap-com',
      sourceId: blob.path,
      title,
      description,
      url: `${SITE_BASE}/${blob.path.replace(/\.mdx?$/, '')}`,
      product: 'architecture',
      section: null,
    });
  }
  return rows;
}

async function fetchTree(apiKey) {
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(TREE_URL);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'sap-tutorials-fetch-help-docs',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(TREE_URL, {
    headers,
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} for ${TREE_URL}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchRaw(path) {
  const url = `${RAW_BASE}/${path}`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`raw.githubusercontent.com ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { frontmatterTitle: null, body: raw };
  const fm = m[1];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const frontmatterTitle = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : null;
  return { frontmatterTitle, body: raw.slice(m[0].length) };
}

function extractH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/architecture-sap-com-fetcher.test.js`
Expected: PASS — 8/8 cases green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/help-docs/architecture-sap-com-fetcher.js test/unit/srv/architecture-sap-com-fetcher.test.js
git commit -m "feat(#860): architecture-sap-com fetcher module + unit tests"
```

---

### Task 4: Wire the fetcher into the orchestrator

Add the fourth branch to `Promise.allSettled`, extend `SOURCE_PRECEDENCE` and `FETCHER_BY_SOURCE`, and add the fourth key to the `perSource` return shape.

**Files:**
- Modify: `srv/lib/help-docs/index.js`
- Modify: `test/unit/srv/help-docs-orchestrator.test.js`
- Modify: `test/unit/srv/help-docs-dedupe.test.js`

**Interfaces:**
- Consumes: `fetchArchitectureSapComCorpus` from Task 3.
- Produces: orchestrator emits `{ rows, perSource }` where `perSource` now has 4 keys; `SOURCE_PRECEDENCE` has 4 entries.

- [ ] **Step 1: Amend the orchestrator test (all-succeed case)**

Edit `test/unit/srv/help-docs-orchestrator.test.js`. In the "returns { rows, perSource } when all three fetchers succeed" test, rename it to "…all four fetchers succeed" and add:

```js
_setMockFetcher('architecture-sap-com', async (url) => url.includes('/git/trees/') ? { tree: [] } : '');
```

and after the last existing `expect(result.perSource['ui5-sap-com'].fetcherRejected).toBe(false);` add:

```js
expect(result.perSource['architecture-sap-com'].fetcherRejected).toBe(false);
```

Also amend the "surfaces partial catalog when one fetcher rejects" test and the "returns empty rows when all fetchers produce zero output" test with a fourth mock (`architecture-sap-com`) that follows the same pattern as `cap-cloud-sap`.

- [ ] **Step 2: Add a fourth-source-precedence dedupe test**

Edit `test/unit/srv/help-docs-dedupe.test.js`. Add a new `it` case (place it near the existing `cap-cloud-sap > ui5-sap-com` precedence assertion):

```js
it('architecture-sap-com wins over cap-cloud-sap on same contentHash', async () => {
  _setMockOrchestrator(async () => ({
    rows: [
      { source: 'cap-cloud-sap',        sourceId: 'a.md', title: 'T', description: 'body', url: 'https://cap/x',  product: 'cap',          section: null },
      { source: 'architecture-sap-com', sourceId: 'b.md', title: 'T', description: 'body', url: 'https://arch/y', product: 'architecture', section: null },
    ],
    perSource: {},
  }));
  const { rows } = await fetchAllHelpDocs({ apiKey: 'fake' });
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('architecture-sap-com');
});
```

- [ ] **Step 3: Run the amended tests to verify they fail**

Run:
```bash
npx vitest run test/unit/srv/help-docs-orchestrator.test.js test/unit/srv/help-docs-dedupe.test.js
```
Expected: at least the dedupe and all-succeed tests FAIL (unknown source `architecture-sap-com` in SOURCE_PRECEDENCE / FETCHER_BY_SOURCE).

- [ ] **Step 4: Wire the fetcher into the orchestrator**

Edit `srv/lib/help-docs/index.js`. Six one-line changes:

Add the import (after the existing three imports around line 14):

```js
import * as archSapCom from './architecture-sap-com-fetcher.js';
```

Change `SOURCE_PRECEDENCE` to:

```js
const SOURCE_PRECEDENCE = Object.freeze({
  'architecture-sap-com': 4,
  'cap-cloud-sap': 3,
  'ui5-sap-com': 2,
  'help-sap-com': 1,
});
```

In `fetchAllHelpDocs`, change the `Promise.allSettled` and destructuring to:

```js
const [helpRes, capRes, ui5Res, archRes] = await Promise.allSettled([
  helpSapCom.fetchHelpSapComCorpus({ seenSourceIds, limit }),
  capCloudSap.fetchCapCloudSapCorpus({ apiKey, seenSourceIds, limit }),
  ui5SapCom.fetchUi5SapComCorpus({ seenSourceIds, limit }),
  archSapCom.fetchArchitectureSapComCorpus({ apiKey, seenSourceIds, limit }),
]);

const perSource = {
  'help-sap-com': shape(helpRes),
  'cap-cloud-sap': shape(capRes),
  'ui5-sap-com': shape(ui5Res),
  'architecture-sap-com': shape(archRes),
};

const rows = [
  ...(helpRes.status === 'fulfilled' ? helpRes.value : []),
  ...(capRes.status === 'fulfilled' ? capRes.value : []),
  ...(ui5Res.status === 'fulfilled' ? ui5Res.value : []),
  ...(archRes.status === 'fulfilled' ? archRes.value : []),
];
```

Change `FETCHER_BY_SOURCE` to:

```js
const FETCHER_BY_SOURCE = Object.freeze({
  'help-sap-com': helpSapCom,
  'cap-cloud-sap': capCloudSap,
  'ui5-sap-com': ui5SapCom,
  'architecture-sap-com': archSapCom,
});
```

Update the JSDoc for `canonicalizeHelpDocPath` to document the fourth source key:

```js
 * @param {string} source     — 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com' | 'architecture-sap-com'
```

Update the `apiKey` JSDoc to reflect both consumers:

```js
 * @param {string} [opts.apiKey]          — GitHub token for cap-cloud-sap + architecture-sap-com fetchers
```

- [ ] **Step 5: Run the amended tests to verify they pass**

Run:
```bash
npx vitest run test/unit/srv/help-docs-orchestrator.test.js test/unit/srv/help-docs-dedupe.test.js
```
Expected: PASS — all cases green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/help-docs/index.js test/unit/srv/help-docs-orchestrator.test.js test/unit/srv/help-docs-dedupe.test.js
git commit -m "feat(#860): wire architecture-sap-com fetcher into orchestrator"
```

---

### Task 5: Extend the source-label map + cron summary

Register `'Architecture Center'` as the human-readable badge, and extend the cron's `summary.perSource` init with the fourth key.

**Files:**
- Modify: `srv/lib/published-concepts-query.js`
- Modify: `srv/jobs/fetch-help-docs-job.js`
- Modify: `srv/knowledge-graph-service.cds`
- Modify: `test/unit/srv/fetch-help-docs-job.test.js`
- Modify: `test/unit/srv/help-doc-payload.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HELP_DOC_SOURCE_LABEL['architecture-sap-com'] === 'Architecture Center'`. Cron summary emits four `perSource` keys.

- [ ] **Step 1: Amend the payload-label test**

Read `test/unit/srv/help-doc-payload.test.js` first to find the `HELP_DOC_SOURCE_LABEL` assertions (grep for `Architecture` / `sourceLabel` in the file). Add a new `it` case near the existing `'CAP'` / `'UI5'` / `'SAP Help'` label mapping test:

```js
it('maps architecture-sap-com to "Architecture Center"', () => {
  expect(HELP_DOC_SOURCE_LABEL['architecture-sap-com']).toBe('Architecture Center');
});
```

If the file doesn't already import `HELP_DOC_SOURCE_LABEL`, add the import.

- [ ] **Step 2: Amend the cron summary-shape test**

Read `test/unit/srv/fetch-help-docs-job.test.js` first. Find every assertion that inspects `summary.perSource` and grow the expected shape to include `'architecture-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null }` as a fourth key.

For any test that uses `_setMockOrchestrator`, extend the returned `perSource` to include the fourth key with zeroed counters, unless the test is exercising the "one source rejected" path in which case follow the existing pattern for `cap-cloud-sap`.

- [ ] **Step 3: Run the amended tests to verify they fail**

Run:
```bash
npx vitest run test/unit/srv/help-doc-payload.test.js test/unit/srv/fetch-help-docs-job.test.js
```
Expected: FAIL — `HELP_DOC_SOURCE_LABEL['architecture-sap-com']` is undefined, and cron summary init is missing the fourth key.

- [ ] **Step 4: Add the source label**

Edit `srv/lib/published-concepts-query.js`, change the `HELP_DOC_SOURCE_LABEL` object:

```js
export const HELP_DOC_SOURCE_LABEL = Object.freeze({
  'architecture-sap-com': 'Architecture Center',
  'cap-cloud-sap': 'CAP',
  'help-sap-com': 'SAP Help',
  'ui5-sap-com': 'UI5',
});
```

- [ ] **Step 5: Extend the cron summary init**

Edit `srv/jobs/fetch-help-docs-job.js`. In `runFetchHelpDocs`, change the `summary.perSource` initializer (around line 81):

```js
perSource: {
  'help-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'cap-cloud-sap': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'ui5-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'architecture-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
},
```

Update the LOG.warn message about `TUTORIALS_GITHUB_TOKEN` (line 155) to mention both consumers:

```js
LOG.warn('fetch-help-docs: TUTORIALS_GITHUB_TOKEN unavailable; cap-cloud-sap + architecture-sap-com fetchers will fail (help.sap.com + ui5.sap.com still fetch).');
```

- [ ] **Step 6: Update the CDS doc-comment for the projected source column**

Edit `srv/knowledge-graph-service.cds` around lines 117-120. Update the `source` and `sourceLabel` comments to enumerate all four values:

```
    // Phase 4.7 (#748) + #860: help-doc rows carry source + product + anchor + snippet
    // + sourceLabel derived at payload time. anchor is optional (may be null).
    source        : String;             // 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com' | 'architecture-sap-com'
    sourceLabel   : String;             // 'SAP Help' | 'CAP' | 'UI5' | 'Architecture Center'
```

- [ ] **Step 7: Run the amended tests to verify they pass**

Run:
```bash
npx vitest run test/unit/srv/help-doc-payload.test.js test/unit/srv/fetch-help-docs-job.test.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/published-concepts-query.js srv/jobs/fetch-help-docs-job.js srv/knowledge-graph-service.cds test/unit/srv/help-doc-payload.test.js test/unit/srv/fetch-help-docs-job.test.js
git commit -m "feat(#860): register Architecture Center source label + cron summary key"
```

---

### Task 6: Update knowledge-graph architecture docs

Reflect the fourth source in the developer-facing architecture docs.

**Files:**
- Modify: `docs/developers/architecture/knowledge-graph.md`

**Interfaces:** documentation only.

- [ ] **Step 1: Update the Phase 4.7 section**

Edit `docs/developers/architecture/knowledge-graph.md`. Change the "Phase 4.7 — Help docs" bullet (around lines 52-55) to include the fourth source:

```md
### Phase 4.7 — Help docs (#748, extended by #860)

Documentation from help.sap.com, cap.cloud.sap, ui5.sap.com, and
architecture.learning.sap.com (SAP Architecture Center). Weekly cron.
Priority 70.
```

- [ ] **Step 2: Sanity-check docs build**

Run: `npm run docs:build`
Expected: build passes (sidebar guard + font copy + VitePress build all succeed).

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/knowledge-graph.md
git commit -m "docs(#860): note Architecture Center as 4th help-doc source"
```

---

### Task 7: Full unit-test sweep + verify

Run every help-doc-adjacent unit test one more time as a regression backstop before opening the PR.

**Files:** none.

- [ ] **Step 1: Run the whole help-doc unit test bundle**

Run:
```bash
npx vitest run \
  test/unit/srv/strip-markdown.test.js \
  test/unit/srv/cap-cloud-sap-fetcher.test.js \
  test/unit/srv/help-sap-com-fetcher.test.js \
  test/unit/srv/ui5-sap-com-fetcher.test.js \
  test/unit/srv/architecture-sap-com-fetcher.test.js \
  test/unit/srv/help-docs-orchestrator.test.js \
  test/unit/srv/help-docs-dedupe.test.js \
  test/unit/srv/fetch-help-docs-job.test.js \
  test/unit/srv/help-doc-payload.test.js \
  test/unit/srv/help-doc-slug-canonicalization.test.js \
  test/unit/srv/help-doc-extract.test.js \
  test/unit/srv/build-help-doc-triples.test.js \
  test/unit/srv/kg-neighborhood-help-docs.test.js \
  test/unit/srv/admin-seed-help-docs.test.js \
  test/unit/srv/jobs/gc-external-content-iteration-set.test.js \
  test/unit/srv/kg-explore-data-iri-types.test.js \
  test/unit/kg-resource-type-config.test.js \
  test/unit/scripts/fetch-concepts-help-docs.test.ts \
  test/unit/hugo-apps/related-graph-help-doc-row.test.ts \
  test/unit/hugo-apps/related-graph-nodetype-help-doc.test.ts
```

Expected: every file PASS. If any test that was NOT amended in Tasks 4-5 fails, its failure means a hidden coupling to the three-source shape — read the failure, fix by extending the assertion to accept four sources (mirror the pattern used in Task 5 Step 2), commit as `test(#860): extend <name> for 4th source`, and re-run this step.

- [ ] **Step 2: Sanity — full unit suite**

Run: `npm test`
Expected: green. If unrelated tests fail (unrelated to help-docs), investigate before proceeding — those are not necessarily your bug, but a fresh main should be clean.

---

## Self-review

**Spec coverage:**
- §2 In-scope fetcher module → Task 3
- §2 Orchestrator wiring (6 touches) → Task 4
- §2 `HELP_DOC_SOURCE_LABEL` → Task 5 Step 4
- §2 Cron `summary.perSource` init → Task 5 Step 5
- §2 CDS doc-comment update → Task 5 Step 6
- §2 `docs/developers/architecture/knowledge-graph.md` → Task 6
- §2 Three fixtures → Task 2
- §2 Unit test file → Task 3
- §2 Dedupe test amendment → Task 4 Step 2
- §2 Orchestrator test amendment → Task 4 Step 1
- §2 Cron test amendment → Task 5 Step 2
- §4.2 Shared `_strip-markdown.js` refactor → Task 1

Every scope item is covered.

**Placeholder scan:** no TBDs, no "add appropriate handling", no "similar to Task N without code". All code blocks are complete.

**Type consistency:**
- `fetchArchitectureSapComCorpus` signature matches sibling fetchers (same option keys: `apiKey`, `seenSourceIds`, `limit`).
- `SOURCE_PRECEDENCE` key `'architecture-sap-com'` matches the fetcher's `source` field and the label-map key.
- `HELP_DOC_SOURCE_LABEL['architecture-sap-com']` = `'Architecture Center'` (identical string in cron JSDoc, CDS comment, doc page).
- Row shape: `source, sourceId, title, description, url, product, section` — same seven fields as `cap-cloud-sap-fetcher.js`.
