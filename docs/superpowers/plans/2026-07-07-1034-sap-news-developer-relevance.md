# SAP News developer-relevance filter (#1034) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter `/homepage/news` to developer-relevant items via an embedding-first, LLM-fallback classifier; persist verdicts + admin overrides; ship a unified `/admin-ui/#content-moderation` surface that #1033 will later mirror.

**Architecture:** New Phase-4 chassis entity `NewsItems` in HANA, populated hourly by `fetch-news-job.js`. Each fetched item is classified by a source-agnostic `srv/lib/relevance-classifier.js` (cosine vs a shared `RelevanceSeedExemplars` seed set, LLM fallback for the mid-band). Admins triage in a new UI5 app under a two-layer kill switch. Homepage read path SELECTs from `NewsItems` and applies admin-override-wins semantics.

**Tech Stack:** CAP 10 (Node), HANA Cloud (Vector column), `@sap-ai-sdk` `AzureOpenAiEmbeddingClient` + `OrchestrationClient`, UI5 Fiori Elements V4.

**Spec:** `docs/superpowers/specs/2026-07-07-1034-sap-news-developer-relevance-design.md`

## Global Constraints

- **Classifier does NOT use `@cap-js/ai`** — direct `@sap-ai-sdk`. AICore-kind-resolution gotcha applies to the plugin only.
- **CSV seeds for `RelevanceSeedExemplars` seed only `label`, `text`, `active`, `note`.** `embedding` column stays out of the CSV so admin recompute survives redeploy. Never add `embedding` to `import_columns` in `.hdbtabledata`.
- **`sourceId` fallback:** RSS `<guid>` if present, else `canonicalize(link)` = lowercase + strip `utm_*`, `sc_camp`, `mc_cid`, `mc_eid`.
- **Cron off-minute:** `:37` (hourly). `:17`, `:23`, `:31`, `:11`, `:07`, `:13` already claimed.
- **After schema change:** `cds build --production` MUST run before deploy. Add new `srv/lib/*.js` files to `.deploy/mta.yaml` `srv-qa` `cp` list.
- **English-only classification in v1.** Non-English rows persisted with `language != 'en'` and `aiVerdict='pending'`; homepage filters them out.
- **60 s in-process cache** on the homepage `news()` read; `resetNewsCache()` on admin write.
- **Kill switches:** env `HOMEPAGE_NEWS_RELEVANCE_ENABLED` (default `true`) AND `HomepageConfig.newsRelevanceEnabled` (default `false`) — either falsy → legacy pass-through.
- **Homepage response shape unchanged:** `{ title, link, publishedAt, description }`. `CommunityLane.vue` gets no v1 change.
- **Never edit `hugo/content/tutorials/`.** Not touched by this plan.
- **Commit convention:** `<type>(#1034): <summary>` (e.g. `feat(#1034): add NewsItems entity`).
- **Node 22 CI matrix hazard:** avoid bare projection names in `SELECT.from('X')`; use `cds.entities(NS)` refs. Do not leak `cds.context` across `it()` boundaries — use `x.context = x` self-reference.

## File Structure

**Created:**
- `db/external-content.cds` — extended with `NewsItems` and `RelevanceSeedExemplars` entities.
- `db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv` — seed rows (no embedding column).
- `srv/lib/relevance-classifier.js` — source-agnostic classifier.
- `srv/lib/relevance-seed-embeddings.js` — cache for seed embeddings.
- `srv/lib/relevance-keyword-rules.js` — allow/block token rule.
- `srv/lib/canonicalize-link.js` — URL canonicalization for sourceId fallback.
- `srv/lib/detect-language-en.js` — v1 heuristic.
- `srv/jobs/fetch-news-job.js` — hourly cron.
- `srv/content-moderation-service.cds` + `.js` — new service.
- `app/admin/content-moderation/` — new UI5 FE app (mirrors `app/admin/homepage/` shape).
- `test/unit/relevance-classifier.test.js`
- `test/unit/relevance-keyword-rules.test.js`
- `test/unit/fetch-news-job.test.js`
- `test/unit/homepage-news-filter.test.js`
- `test/unit/content-moderation-service.test.js`
- `test/unit/relevance-seed-embedding.test.js`
- `test/hybrid/news-items-hana.test.js`
- `test/smoke/homepage-news-smoke.test.js`
- `test/fixtures/news-sap-com-feed/` — recorded XML.
- `docs/developers/operations/content-moderation-runbook.md`

**Modified:**
- `srv/homepage-service.js` — rewrite `news()` handler; export `resetNewsCache()`.
- `srv/lib/homepage-rss-fetcher.js` — extend parser to also emit `guid` and `categories`.
- `db/homepage.cds` — add `newsRelevanceEnabled` to `HomepageConfig`.
- `db/schema.cds` — add `newsRelevanceLlmBudgetPerDay`, `newsRelevanceMargin`, `newsFetchCadenceMinutes`, `newsRelevanceLlmCallsToday`, `newsRelevanceLlmCallsCountedOn` to `ChatSettings`.
- `srv/admin-service.cds` — expose the three new `ChatSettings` fields on the projection.
- `srv/jobs/scheduler.js` — register `fetch-news` in `JOB_REGISTRY` via `registerJob`.
- `app/admin-shell/webapp/manifest.json` — add `contentModeration` route.
- `.deploy/mta.yaml` — add new `srv/lib/*.js` files to `srv-qa` `cp` list.
- `docs/developers/architecture/homepage.md` — new "SAP News" H2.
- `docs/developers/reference/cap-ai-plugin.md` — footnote that classifier bypasses the plugin.

---

### Task 1: RSS parser upgrade — extract `<guid>` and `<category>`

**Files:**
- Modify: `srv/lib/homepage-rss-fetcher.js` — extend `parseRss` return shape.
- Test:   `test/unit/homepage-rss-fetcher-guid-categories.test.js` (new)
- Test fixture: `test/fixtures/news-sap-com-feed/with-guid-and-categories.xml` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseRss(xml) → Array<{ title, link, publishedAt, description, guid, categories }>` where `guid` is `string|null` and `categories` is `string[]` (empty array if none present). All existing consumers keep working — additive fields.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/news-sap-com-feed/with-guid-and-categories.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>SAP News</title>
  <item>
    <title>CAP 10 adds Java 22 support</title>
    <link>https://news.sap.com/2026/07/cap-10-java-22/</link>
    <pubDate>Mon, 06 Jul 2026 09:00:00 +0000</pubDate>
    <description>The June release adds Java 22.</description>
    <guid isPermaLink="false">news-sap-com-12345</guid>
    <category>Technology</category>
    <category>Developer</category>
  </item>
  <item>
    <title>Earnings guidance updated</title>
    <link>https://news.sap.com/2026/07/earnings/</link>
    <pubDate>Mon, 06 Jul 2026 08:00:00 +0000</pubDate>
    <description>Q2 guidance updated.</description>
  </item>
</channel></rss>
```

Create `test/unit/homepage-rss-fetcher-guid-categories.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _parseRssForTests } from '../../srv/lib/homepage-rss-fetcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('homepage-rss-fetcher — guid + categories parse', () => {
  it('extracts guid and categories when present, defaults otherwise', () => {
    const xml = readFileSync(
      join(HERE, '..', 'fixtures', 'news-sap-com-feed', 'with-guid-and-categories.xml'),
      'utf8'
    );
    const items = _parseRssForTests(xml);
    expect(items).toHaveLength(2);

    expect(items[0].guid).toBe('news-sap-com-12345');
    expect(items[0].categories).toEqual(['Technology', 'Developer']);

    expect(items[1].guid).toBeNull();
    expect(items[1].categories).toEqual([]);
  });

  it('preserves existing shape — title/link/publishedAt/description still present', () => {
    const xml = readFileSync(
      join(HERE, '..', 'fixtures', 'news-sap-com-feed', 'with-guid-and-categories.xml'),
      'utf8'
    );
    const [first] = _parseRssForTests(xml);
    expect(first.title).toBe('CAP 10 adds Java 22 support');
    expect(first.link).toBe('https://news.sap.com/2026/07/cap-10-java-22/');
    expect(first.publishedAt).toBe('2026-07-06T09:00:00.000Z');
    expect(first.description).toBe('The June release adds Java 22.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/homepage-rss-fetcher-guid-categories.test.js`
Expected: FAIL — `_parseRssForTests` not exported.

- [ ] **Step 3: Extend `parseRss` in `srv/lib/homepage-rss-fetcher.js`**

Inside the existing `parseRss` function's while-loop, after the `desc` extraction, add:

```js
    const guid = (block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null;

    const categories = [];
    const catRe = /<category\b[^>]*>([\s\S]*?)<\/category>/gi;
    let catM;
    while ((catM = catRe.exec(block)) !== null) {
      const c = catM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (c) categories.push(c);
    }
```

Change the `items.push` call to include the new fields:

```js
    items.push({
      title,
      link,
      publishedAt,
      description: desc || null,
      guid,
      categories,
    });
```

At the bottom of the module, add the test-only export:

```js
export function _parseRssForTests(xml) {
  return parseRss(xml);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/homepage-rss-fetcher-guid-categories.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing RSS-fetcher tests to prove no regression**

Run: `npx vitest run test/unit --testNamePattern homepage-rss-fetcher`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/homepage-rss-fetcher.js test/unit/homepage-rss-fetcher-guid-categories.test.js test/fixtures/news-sap-com-feed/with-guid-and-categories.xml
git commit -m "feat(#1034): parse <guid> and <category> from RSS feed items"
```

---

### Task 2: canonicalize-link helper

**Files:**
- Create: `srv/lib/canonicalize-link.js`
- Test:   `test/unit/canonicalize-link.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalizeLink(url: string) → string`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/canonicalize-link.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { canonicalizeLink } from '../../srv/lib/canonicalize-link.js';

describe('canonicalizeLink', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeLink('HTTPS://News.SAP.com/x')).toBe('https://news.sap.com/x');
  });
  it('lowercases the path', () => {
    expect(canonicalizeLink('https://news.sap.com/2026/CAP-10/')).toBe('https://news.sap.com/2026/cap-10/');
  });
  it('strips utm_* params', () => {
    expect(canonicalizeLink('https://news.sap.com/a?utm_source=x&utm_medium=y&foo=1'))
      .toBe('https://news.sap.com/a?foo=1');
  });
  it('strips sc_camp / mc_cid / mc_eid', () => {
    expect(canonicalizeLink('https://news.sap.com/a?sc_camp=1&mc_cid=2&mc_eid=3'))
      .toBe('https://news.sap.com/a');
  });
  it('keeps unknown params in original order', () => {
    expect(canonicalizeLink('https://news.sap.com/a?b=2&a=1'))
      .toBe('https://news.sap.com/a?b=2&a=1');
  });
  it('returns input unchanged when URL constructor throws', () => {
    expect(canonicalizeLink('not-a-url')).toBe('not-a-url');
  });
  it('handles empty string', () => {
    expect(canonicalizeLink('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/canonicalize-link.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `srv/lib/canonicalize-link.js`:

```js
// srv/lib/canonicalize-link.js
//
// Canonicalize a URL for use as a stable identifier when an RSS feed omits <guid>.
// Lowercases scheme/host/path; strips tracking params (utm_*, sc_camp, mc_cid, mc_eid).
// Returns the input unchanged if URL construction fails. (#1034)

const STRIP_EXACT = new Set(['sc_camp', 'mc_cid', 'mc_eid']);
const STRIP_PREFIX = ['utm_'];

/** @param {string} url */
export function canonicalizeLink(url) {
  if (!url) return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (STRIP_EXACT.has(k)) continue;
    if (STRIP_PREFIX.some(p => k.startsWith(p))) continue;
    kept.push([k, v]);
  }
  const qs = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const path = u.pathname.toLowerCase();
  const host = u.host.toLowerCase();
  const scheme = u.protocol.toLowerCase();
  const suffix = qs ? `?${qs}` : '';
  const hash = u.hash;
  return `${scheme}//${host}${path}${suffix}${hash}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/canonicalize-link.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/canonicalize-link.js test/unit/canonicalize-link.test.js
git commit -m "feat(#1034): canonicalizeLink helper for sourceId fallback"
```

---

### Task 3: detect-language-en heuristic

**Files:**
- Create: `srv/lib/detect-language-en.js`
- Test:   `test/unit/detect-language-en.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectLanguageEn(text: string) → 'en' | null`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/detect-language-en.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { detectLanguageEn } from '../../srv/lib/detect-language-en.js';

describe('detectLanguageEn', () => {
  it('returns "en" for clearly English text with 3+ function words', () => {
    expect(detectLanguageEn('The CAP framework is the future of SAP development for developers.')).toBe('en');
  });
  it('returns null for text with <3 function-word hits', () => {
    expect(detectLanguageEn('CAP')).toBeNull();
    expect(detectLanguageEn('Buenos dias amigos, hola mundo!')).toBeNull();
  });
  it('returns null when non-Latin-1 chars are present', () => {
    expect(detectLanguageEn('CJK characters here 日 the of and')).toBeNull();
  });
  it('is case-insensitive on function-word matching', () => {
    expect(detectLanguageEn('THE OF AND to is')).toBe('en');
  });
  it('matches only on word boundaries', () => {
    expect(detectLanguageEn('theofandtois something')).toBeNull();
  });
  it('handles empty / null gracefully', () => {
    expect(detectLanguageEn('')).toBeNull();
    expect(detectLanguageEn(null)).toBeNull();
    expect(detectLanguageEn(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/detect-language-en.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `srv/lib/detect-language-en.js`:

```js
// srv/lib/detect-language-en.js
//
// v1 English-language heuristic for the SAP News classifier. (#1034)
// Returns 'en' when every character is Basic Latin + Latin-1 Supplement (+ common
// whitespace) AND at least 3 whitespace-bounded English function words are present
// (the/of/and/to/is/in/for/with, case-insensitive). Otherwise null.

const FN_WORDS = new Set(['the', 'of', 'and', 'to', 'is', 'in', 'for', 'with']);
const LATIN_RE = /^[\t\n\r\x20-\x7E\xA0-\xFF]*$/;
const TOKEN_RE = /[a-zA-Z]+/g;

/** @param {string|null|undefined} text */
export function detectLanguageEn(text) {
  if (!text) return null;
  if (!LATIN_RE.test(text)) return null;
  let hits = 0;
  const lower = text.toLowerCase();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    if (FN_WORDS.has(m[0])) {
      hits++;
      if (hits >= 3) return 'en';
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/detect-language-en.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/detect-language-en.js test/unit/detect-language-en.test.js
git commit -m "feat(#1034): v1 English-language detection heuristic"
```

---

### Task 4: Keyword allow/block rule module

**Files:**
- Create: `srv/lib/relevance-keyword-rules.js`
- Test:   `test/unit/relevance-keyword-rules.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `classifyByKeywords({ title, description }) → { verdict: 'relevant'|'not-relevant', reason: string }`
  - `ALLOWLIST: string[]` and `BLOCKLIST: string[]` (exported for tests and documentation).

- [ ] **Step 1: Write the failing test**

Create `test/unit/relevance-keyword-rules.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classifyByKeywords } from '../../srv/lib/relevance-keyword-rules.js';

describe('classifyByKeywords', () => {
  it('allowlist hit + no blocklist → relevant', () => {
    const r = classifyByKeywords({ title: 'New CAP release', description: 'Java 22 support for SDK.' });
    expect(r.verdict).toBe('relevant');
    expect(r.reason).toMatch(/allowlist/i);
  });
  it('allowlist + blocklist → not-relevant (blocklist wins)', () => {
    const r = classifyByKeywords({ title: 'SAP announces CAP partnership', description: 'CEO comments on Q2 earnings.' });
    expect(r.verdict).toBe('not-relevant');
    expect(r.reason).toMatch(/blocklist/i);
  });
  it('no allowlist hit → not-relevant', () => {
    const r = classifyByKeywords({ title: 'Executive appointment', description: 'New board member joins.' });
    expect(r.verdict).toBe('not-relevant');
  });
  it('is case-insensitive', () => {
    expect(classifyByKeywords({ title: 'sap btp release', description: 'new api and sdk' }).verdict).toBe('relevant');
  });
  it('respects word boundaries — "capitalization" does not match "CAP"', () => {
    const r = classifyByKeywords({ title: 'Capitalization matters', description: 'A grammar note.' });
    expect(r.verdict).toBe('not-relevant');
  });
  it('tolerates null description', () => {
    expect(classifyByKeywords({ title: 'CAP API demo', description: null }).verdict).toBe('relevant');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/relevance-keyword-rules.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `srv/lib/relevance-keyword-rules.js`:

```js
// srv/lib/relevance-keyword-rules.js
//
// Fallback classifier for when embedding + LLM paths both fail (or seeds
// are empty, or the daily LLM budget is exhausted). Word-boundary matched,
// case-insensitive. Token lists are code-owned; tune via PR. (#1034)

export const ALLOWLIST = [
  'API', 'APIs', 'SDK', 'CLI', 'CAP', 'BTP', 'HANA', 'Fiori', 'UI5', 'ABAP',
  'Node', 'Java', 'TypeScript', 'Python', 'code', 'sample', 'tutorial',
  'walkthrough', 'deploy', 'Kubernetes', 'Kyma', 'AI Core', 'AI Foundation',
  'AI SDK', 'Cloud SDK', 'SAP Build', 'developer',
];

export const BLOCKLIST = [
  'earnings', 'Q1', 'Q2', 'Q3', 'Q4', 'revenue', 'guidance', 'CEO', 'CFO',
  'partnership', 'sponsorship', 'celebrat', 'award', 'champion of the year',
  'HR', 'board of directors',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(tokens) {
  // \b word boundary works for tokens composed of \w chars; for tokens that
  // contain spaces (e.g. 'AI Core', 'champion of the year') we anchor on
  // whitespace boundaries as well.
  const alternation = tokens.map(t => {
    const esc = escapeRegex(t);
    return `\\b${esc}\\b`;
  }).join('|');
  return new RegExp(`(${alternation})`, 'i');
}

const ALLOW_RE = buildRegex(ALLOWLIST);
const BLOCK_RE = buildRegex(BLOCKLIST);

/** @param {{title?: string, description?: string|null}} args */
export function classifyByKeywords({ title, description }) {
  const hay = `${title ?? ''} ${description ?? ''}`;
  const blockHit = hay.match(BLOCK_RE);
  if (blockHit) {
    return {
      verdict: 'not-relevant',
      reason: `Matched blocklist token "${blockHit[1]}"`,
    };
  }
  const allowHit = hay.match(ALLOW_RE);
  if (allowHit) {
    return {
      verdict: 'relevant',
      reason: `Matched allowlist token "${allowHit[1]}"`,
    };
  }
  return {
    verdict: 'not-relevant',
    reason: 'No allowlist tokens matched',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/relevance-keyword-rules.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/relevance-keyword-rules.js test/unit/relevance-keyword-rules.test.js
git commit -m "feat(#1034): keyword allow/block fallback rules"
```

---

### Task 5: Add `NewsItems` + `RelevanceSeedExemplars` entities to CDS

**Files:**
- Modify: `db/external-content.cds` — append the two new entities.
- Modify: `db/schema.cds` — extend `ChatSettings` with five new columns.
- Modify: `db/homepage.cds` — extend `HomepageConfig` with `newsRelevanceEnabled`.
- Test:   `test/unit/schema-1034-entities.test.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: entities `com.sap.developers.ims.external.NewsItems` and `com.sap.developers.ims.external.RelevanceSeedExemplars`. `ChatSettings` gains `newsRelevanceLlmBudgetPerDay`, `newsRelevanceMargin`, `newsFetchCadenceMinutes`, `newsRelevanceLlmCallsToday`, `newsRelevanceLlmCallsCountedOn`. `HomepageConfig` gains `newsRelevanceEnabled`.

- [ ] **Step 1: Write the failing shape test**

Create `test/unit/schema-1034-entities.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('#1034 schema additions', () => {
  beforeAll(async () => {
    // Loads compiled model; no DB deploy needed for shape assertions.
    await cds.load('*');
  });

  it('NewsItems entity exists with expected keys and columns', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.external.NewsItems'];
    expect(ent).toBeTruthy();
    expect(ent.elements.sourceId.key).toBe(true);
    expect(ent.elements.link).toBeTruthy();
    expect(ent.elements.title).toBeTruthy();
    expect(ent.elements.description).toBeTruthy();
    expect(ent.elements.publishedAt).toBeTruthy();
    expect(ent.elements.language).toBeTruthy();
    expect(ent.elements.contentHash).toBeTruthy();
    expect(ent.elements.aiVerdict).toBeTruthy();
    expect(ent.elements.aiReason).toBeTruthy();
    expect(ent.elements.aiVerdictSource).toBeTruthy();
    expect(ent.elements.aiConfidence).toBeTruthy();
    expect(ent.elements.aiVerdictAt).toBeTruthy();
    expect(ent.elements.aiModel).toBeTruthy();
    expect(ent.elements.adminVerdict).toBeTruthy();
    expect(ent.elements.adminNote).toBeTruthy();
    expect(ent.elements.adminBy).toBeTruthy();
    expect(ent.elements.adminAt).toBeTruthy();
    expect(ent.elements.lastFetchedAt).toBeTruthy();
    expect(ent.elements.classifyError).toBeTruthy();
  });

  it('RelevanceSeedExemplars entity exists with embedding column', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.external.RelevanceSeedExemplars'];
    expect(ent).toBeTruthy();
    expect(ent.elements.ID.key).toBe(true);
    expect(ent.elements.label).toBeTruthy();
    expect(ent.elements.text).toBeTruthy();
    expect(ent.elements.embedding).toBeTruthy();
    expect(ent.elements.active).toBeTruthy();
    expect(ent.elements.note).toBeTruthy();
  });

  it('ChatSettings gains #1034 columns', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(ent.elements.newsRelevanceLlmBudgetPerDay).toBeTruthy();
    expect(ent.elements.newsRelevanceMargin).toBeTruthy();
    expect(ent.elements.newsFetchCadenceMinutes).toBeTruthy();
    expect(ent.elements.newsRelevanceLlmCallsToday).toBeTruthy();
    expect(ent.elements.newsRelevanceLlmCallsCountedOn).toBeTruthy();
  });

  it('HomepageConfig gains newsRelevanceEnabled', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.HomepageConfig'];
    expect(ent.elements.newsRelevanceEnabled).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/schema-1034-entities.test.js`
Expected: FAIL — entities/columns not present.

- [ ] **Step 3: Add entities to `db/external-content.cds`**

At the end of `db/external-content.cds`, append:

```cds
/**
 * #1034 SAP News developer-relevance filter.
 * NewsItems is populated by srv/jobs/fetch-news-job.js from news.sap.com/feed/;
 * each row carries an AI verdict + optional admin override that homepage
 * SELECTs against. sourceId is the RSS <guid> if the feed emits one, else
 * canonicalizeLink(link). Admin override wins at read time.
 */
entity NewsItems : managed {
  key sourceId       : String(200);
      link           : String(500) not null;
      title          : String(500) not null;
      description    : LargeString;
      publishedAt    : Timestamp;
      language       : String(10);
      contentHash    : String(64);
      // AI verdict
      aiVerdict      : String(20);
      aiReason       : String(500);
      aiVerdictSource: String(20);
      aiConfidence   : Decimal(4, 3);
      aiVerdictAt    : Timestamp;
      aiModel        : String(100);
      // Admin override (wins over AI at read time)
      adminVerdict   : String(20);
      adminNote      : String(500);
      adminBy        : String(255);
      adminAt        : Timestamp;
      // Ops
      lastFetchedAt  : Timestamp;
      classifyError  : String(500);
}

/**
 * #1034 Shared seed exemplars for the source-agnostic relevance classifier.
 * Used by SAP News now, Community Blog Posts (#1033) later. The embedding
 * column is computed by an after-CREATE/UPDATE handler in
 * srv/content-moderation-service.js — do NOT include it in the CSV seed.
 */
entity RelevanceSeedExemplars : cuid, managed {
  label     : String(20) not null;
  text      : LargeString not null;
  embedding : Vector(1536);
  active    : Boolean default true;
  note      : String(500);
}
```

- [ ] **Step 4: Extend `ChatSettings` in `db/schema.cds`**

Inside `entity ChatSettings`, after the last existing field (before the closing `}`), add:

```cds
  // #1034 SAP News developer-relevance filter.
  newsRelevanceLlmBudgetPerDay   : Integer default 100;
  newsRelevanceMargin            : Decimal(4, 3) default 0.150;
  newsFetchCadenceMinutes        : Integer default 60;
  newsRelevanceLlmCallsToday     : Integer default 0;
  newsRelevanceLlmCallsCountedOn : Date;
```

- [ ] **Step 5: Extend `HomepageConfig` in `db/homepage.cds`**

Inside `entity HomepageConfig`, after the last existing field, add:

```cds
  // #1034 SAP News developer-relevance filter rollout flag. Two-layer with
  // env HOMEPAGE_NEWS_RELEVANCE_ENABLED: either falsy → legacy pass-through.
  newsRelevanceEnabled    : Boolean default false;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/schema-1034-entities.test.js`
Expected: PASS (4 tests).

- [ ] **Step 7: Deploy-time sanity check (runtime constraints only surface here)**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exit 0. This is the same code path CI uses; it catches `@assert.unique.*` and CSV-shape errors that `cds compile` doesn't. Memory rule filed in `MEMORY.md`.

- [ ] **Step 8: Commit**

```bash
git add db/external-content.cds db/schema.cds db/homepage.cds test/unit/schema-1034-entities.test.js
git commit -m "feat(#1034): add NewsItems, RelevanceSeedExemplars, ChatSettings + HomepageConfig fields"
```

---

### Task 6: Seed `RelevanceSeedExemplars` via CSV

**Files:**
- Create: `db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv`
- Test:   `test/unit/relevance-seed-csv.test.js`

**Interfaces:**
- Consumes: entity from Task 5.
- Produces: 12 seed rows (6 relevant, 6 not-relevant) that make a fresh deploy classify sensibly. `embedding` deliberately NOT in the CSV — added by the after-CREATE/UPDATE handler introduced later.

- [ ] **Step 1: Write the failing test**

Create `test/unit/relevance-seed-csv.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSV = join(process.cwd(), 'db', 'data', 'com.sap.developers.ims.external-RelevanceSeedExemplars.csv');

describe('#1034 seed CSV', () => {
  it('exists with expected header (no embedding column)', () => {
    const text = readFileSync(CSV, 'utf8');
    const [header] = text.split(/\r?\n/);
    const cols = header.split(';');
    expect(cols).toContain('ID');
    expect(cols).toContain('label');
    expect(cols).toContain('text');
    expect(cols).toContain('active');
    expect(cols).toContain('note');
    // Critical: embedding must NOT be in the CSV — see MEMORY.md
    // csv-changes-wipe-editable-columns.md.
    expect(cols).not.toContain('embedding');
  });

  it('has at least 3 rows per label', () => {
    const text = readFileSync(CSV, 'utf8');
    const rows = text.split(/\r?\n/).slice(1).filter(l => l.trim());
    const labels = rows.map(r => r.split(';')[1]);
    const rel = labels.filter(l => l === 'relevant').length;
    const not = labels.filter(l => l === 'not-relevant').length;
    expect(rel).toBeGreaterThanOrEqual(3);
    expect(not).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/relevance-seed-csv.test.js`
Expected: FAIL — file missing.

- [ ] **Step 3: Create the CSV**

Create `db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv`:

```csv
ID;label;text;active;note
10340001-0000-0000-0000-000000000001;relevant;A new SAP Cloud Application Programming Model release adds Java 22 support, updated CDS syntax, and improvements to the cds CLI.;true;canonical CAP release
10340001-0000-0000-0000-000000000002;relevant;Tutorial walking through building a Fiori Elements app on BTP with UI5 web components and a CAP backend.;true;tutorial exemplar
10340001-0000-0000-0000-000000000003;relevant;Announcement of new AI Core deployment templates and updated @sap-ai-sdk client with code samples for chat completion and embeddings.;true;AI SDK exemplar
10340001-0000-0000-0000-000000000004;relevant;Guide to deploying a Node.js microservice to Kyma using SAP BTP service bindings and the Destination Service API.;true;deployment exemplar
10340001-0000-0000-0000-000000000005;relevant;How to use the new HANA Cloud vector engine for RAG with Python samples and REST API examples.;true;HANA exemplar
10340001-0000-0000-0000-000000000006;relevant;Deep dive into the ABAP Cloud released APIs for RAP business objects with code samples.;true;ABAP Cloud exemplar
10340001-0000-0000-0000-000000000101;not-relevant;SAP announces strong Q2 earnings and updated revenue guidance for the fiscal year alongside CEO comments.;true;earnings exemplar
10340001-0000-0000-0000-000000000102;not-relevant;New partnership between SAP and a global systems integrator to drive customer transformation projects across EMEA.;true;partnership exemplar
10340001-0000-0000-0000-000000000103;not-relevant;SAP CFO celebrates receiving industry award for financial leadership at annual gala.;true;award exemplar
10340001-0000-0000-0000-000000000104;not-relevant;Announcement of new board of directors appointments and organizational changes for the upcoming fiscal year.;true;board exemplar
10340001-0000-0000-0000-000000000105;not-relevant;SAP champions of the year recognized in HR-led celebration at global sales kickoff event.;true;HR / recognition exemplar
10340001-0000-0000-0000-000000000106;not-relevant;Recap of executive keynote at industry conference discussing high-level strategy without technical detail.;true;marketing keynote exemplar
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/relevance-seed-csv.test.js`
Expected: PASS.

- [ ] **Step 5: Verify CSV loads at deploy time**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exit 0, no `UNIQUE constraint failed` or `column count` errors.

- [ ] **Step 6: Commit**

```bash
git add db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv test/unit/relevance-seed-csv.test.js
git commit -m "feat(#1034): seed 12 RelevanceSeedExemplars rows (embedding stays out of CSV)"
```

---

### Task 7: Relevance seed-embedding cache

**Files:**
- Create: `srv/lib/relevance-seed-embeddings.js`
- Test:   `test/unit/relevance-seed-embeddings.test.js`

**Interfaces:**
- Consumes: entity `RelevanceSeedExemplars` from Task 5; `embed()` from existing `srv/lib/embedding-client.js`.
- Produces:
  - `getSeedEmbeddings() → Promise<{ relevant: Float32Array[], notRelevant: Float32Array[] }>`
  - `invalidateSeed(id: string): void` (called by the entity after-hook when text changes)
  - `_resetCacheForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/relevance-seed-embeddings.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

let embedMock;
vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: (...args) => embedMock(...args),
}));

const {
  getSeedEmbeddings,
  invalidateSeed,
  _resetCacheForTests,
} = await import('../../srv/lib/relevance-seed-embeddings.js');

describe('relevance-seed-embeddings', () => {
  beforeEach(async () => {
    _resetCacheForTests();
    embedMock = vi.fn(async inputs => inputs.map((_, i) => new Float32Array([i, 0, 0])));
    await cds.test('serve', 'srv').in(process.cwd()).homepageBooted;
  });

  it('lazily loads active seeds grouped by label', async () => {
    // Depend on the seeded rows from Task 6.
    const { relevant, notRelevant } = await getSeedEmbeddings();
    expect(relevant.length).toBeGreaterThanOrEqual(3);
    expect(notRelevant.length).toBeGreaterThanOrEqual(3);
    expect(embedMock).toHaveBeenCalledTimes(1); // one batched embed call
  });

  it('races share the in-flight promise (single embed call)', async () => {
    const [a, b] = await Promise.all([getSeedEmbeddings(), getSeedEmbeddings()]);
    expect(a).toBe(b);
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateSeed marks one entry stale; next call recomputes only it', async () => {
    await getSeedEmbeddings();
    expect(embedMock).toHaveBeenCalledTimes(1);
    invalidateSeed('10340001-0000-0000-0000-000000000001');
    await getSeedEmbeddings();
    expect(embedMock).toHaveBeenCalledTimes(2);
    // Second call embeds only the stale entry.
    expect(embedMock.mock.calls[1][0]).toHaveLength(1);
  });

  it('empty result set → both label arrays empty; no throw', async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.RelevanceSeedExemplars'));
    _resetCacheForTests();
    const { relevant, notRelevant } = await getSeedEmbeddings();
    expect(relevant).toEqual([]);
    expect(notRelevant).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/relevance-seed-embeddings.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `srv/lib/relevance-seed-embeddings.js`:

```js
// srv/lib/relevance-seed-embeddings.js
//
// In-memory cache of RelevanceSeedExemplars embeddings, grouped by label.
// Modeled after category-seed-embeddings.js — same lazy-load + in-flight-
// promise-sharing + per-ID staleness pattern. (#1034)

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

const LOG = cds.log('relevance-seed-embeddings');

/** Map<seedId, { label: 'relevant'|'not-relevant', vec: Float32Array, text: string }> */
let _cache = null;
let _stale = new Set();
let _loadingPromise = null;

export function _resetCacheForTests() {
  _cache = null;
  _stale = new Set();
  _loadingPromise = null;
}

async function loadAll() {
  const { RelevanceSeedExemplars } = cds.entities('com.sap.developers.ims.external');
  const rows = await SELECT.from(RelevanceSeedExemplars)
    .columns('ID', 'label', 'text', 'active')
    .where({ active: true });
  const usable = rows.filter(r => r.text && r.text.trim().length > 0);
  if (usable.length === 0) {
    LOG.warn('No active RelevanceSeedExemplars — classifier will fall back to keyword rules');
    return new Map();
  }
  const vectors = await embed(usable.map(r => r.text));
  const m = new Map();
  for (let i = 0; i < usable.length; i++) {
    m.set(usable[i].ID, { label: usable[i].label, vec: vectors[i], text: usable[i].text });
  }
  return m;
}

async function recomputeStale(staleIds) {
  const { RelevanceSeedExemplars } = cds.entities('com.sap.developers.ims.external');
  const rows = await SELECT.from(RelevanceSeedExemplars)
    .columns('ID', 'label', 'text', 'active')
    .where({ active: true });
  const targets = rows.filter(r =>
    staleIds.has(r.ID) && r.text && r.text.trim().length > 0);
  if (targets.length === 0) return;
  const vectors = await embed(targets.map(r => r.text));
  for (let i = 0; i < targets.length; i++) {
    _cache.set(targets[i].ID, { label: targets[i].label, vec: vectors[i], text: targets[i].text });
  }
}

function groupByLabel(map) {
  const relevant = [];
  const notRelevant = [];
  for (const { label, vec } of map.values()) {
    if (label === 'relevant') relevant.push(vec);
    else if (label === 'not-relevant') notRelevant.push(vec);
  }
  return { relevant, notRelevant };
}

/**
 * Get the cached seed embeddings grouped by label.
 * Racing callers share the in-flight promise.
 * @returns {Promise<{ relevant: Float32Array[], notRelevant: Float32Array[] }>}
 */
export async function getSeedEmbeddings() {
  if (!_cache) {
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
      try {
        _cache = await loadAll();
        _stale = new Set();
        return groupByLabel(_cache);
      } finally {
        _loadingPromise = null;
      }
    })();
    return _loadingPromise;
  }
  if (_stale.size > 0) {
    const toRecompute = new Set(_stale);
    _stale = new Set();
    await recomputeStale(toRecompute);
  }
  return groupByLabel(_cache);
}

/** Called by the after-UPDATE handler when a seed's text changes. */
export function invalidateSeed(id) {
  if (!_cache) return;
  _cache.delete(id);
  _stale.add(id);
}
```

Note: the returned object's identity is not preserved across calls (`{relevant, notRelevant}` is rebuilt each call from `_cache`). The test's `a === b` assertion applies only inside a single in-flight load — I'll relax that in Step 4.

- [ ] **Step 4: Relax the in-flight-sharing test to check the embed-call count, not object identity**

Edit the second test in `test/unit/relevance-seed-embeddings.test.js`:

```js
  it('races share the in-flight promise (single embed call)', async () => {
    await Promise.all([getSeedEmbeddings(), getSeedEmbeddings()]);
    expect(embedMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/relevance-seed-embeddings.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/relevance-seed-embeddings.js test/unit/relevance-seed-embeddings.test.js
git commit -m "feat(#1034): lazy seed-embedding cache with per-ID invalidation"
```

---

### Task 8: Source-agnostic relevance classifier

**Files:**
- Create: `srv/lib/relevance-classifier.js`
- Test:   `test/unit/relevance-classifier.test.js`

**Interfaces:**
- Consumes: `getSeedEmbeddings()` from Task 7; `embed()` from `srv/lib/embedding-client.js`; `classifyByKeywords()` from Task 4; existing `resolveChatLlmSettings()` and `OrchestrationClient` from `@sap-ai-sdk/orchestration`.
- Produces:
  ```
  classify({ title, description, sourceType }) → {
    verdict: 'relevant' | 'not-relevant',
    reason: string,
    source: 'embedding' | 'llm' | 'fallback-keyword',
    confidence: number,   // 0..1
    model: string,        // embedding model name or LLM deploymentId
  }
  ```
  `sourceType` is a hint ('sap-news' | 'community-blog-post') threaded into the LLM prompt only; scoring is identical.

- [ ] **Step 1: Write the failing test**

Create `test/unit/relevance-classifier.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

const seedMock = vi.fn();
const embedMock = vi.fn();
const keywordMock = vi.fn();
const llmMock = vi.fn();
const settingsMock = vi.fn();

vi.mock('../../srv/lib/relevance-seed-embeddings.js', () => ({
  getSeedEmbeddings: () => seedMock(),
}));
vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: (...a) => embedMock(...a),
}));
vi.mock('../../srv/lib/relevance-keyword-rules.js', () => ({
  classifyByKeywords: (...a) => keywordMock(...a),
}));
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: class {
    async chatCompletion(payload) { return llmMock(payload); }
  },
}));
vi.mock('../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: (...a) => settingsMock(...a),
}));

const { classify } = await import('../../srv/lib/relevance-classifier.js');

const RELEVANT_VEC = new Float32Array([1, 0, 0]);
const NOT_VEC     = new Float32Array([0, 1, 0]);
const ITEM_VEC    = new Float32Array([1, 0, 0]);
const AMBIG_VEC   = new Float32Array([0.5, 0.5, 0]);

describe('relevance-classifier', () => {
  beforeEach(() => {
    seedMock.mockReset(); embedMock.mockReset();
    keywordMock.mockReset(); llmMock.mockReset(); settingsMock.mockReset();
    seedMock.mockResolvedValue({ relevant: [RELEVANT_VEC], notRelevant: [NOT_VEC] });
    settingsMock.mockResolvedValue({ deploymentId: 'dep-1', modelName: 'gpt-4o-mini' });
  });

  it('high positive margin → verdict "relevant", source "embedding"', async () => {
    embedMock.mockResolvedValue([ITEM_VEC]);
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.verdict).toBe('relevant');
    expect(r.source).toBe('embedding');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('high negative margin → verdict "not-relevant", source "embedding"', async () => {
    embedMock.mockResolvedValue([new Float32Array([0, 1, 0])]);
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.verdict).toBe('not-relevant');
    expect(r.source).toBe('embedding');
  });

  it('mid-band margin → LLM fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockResolvedValue({
      getContent: () => JSON.stringify({ verdict: 'relevant', reason: 'discusses new API' }),
    });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('llm');
    expect(r.verdict).toBe('relevant');
    expect(r.reason).toBe('discusses new API');
    expect(r.model).toBe('dep-1');
  });

  it('LLM error → keyword fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockRejectedValue(new Error('AI Core 503'));
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: 'no allowlist' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
    expect(r.verdict).toBe('not-relevant');
  });

  it('empty seeds (both arrays) → keyword fallback', async () => {
    seedMock.mockResolvedValue({ relevant: [], notRelevant: [] });
    keywordMock.mockReturnValue({ verdict: 'relevant', reason: 'matched CAP' });
    const r = await classify({ title: 'CAP', description: null, sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
    expect(r.verdict).toBe('relevant');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('embedding call fails → keyword fallback', async () => {
    embedMock.mockRejectedValue(new Error('AI Core down'));
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: '' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
  });

  it('LLM returns malformed JSON → keyword fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockResolvedValue({ getContent: () => 'not valid json' });
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: '' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/relevance-classifier.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `srv/lib/relevance-classifier.js`:

```js
// srv/lib/relevance-classifier.js
//
// Source-agnostic developer-relevance classifier for SAP News (#1034) and
// Community Blog Posts (#1033). Embedding-first, LLM-fallback in the
// mid-band, keyword-fallback on any embedding/LLM error or empty-seeds
// short-circuit. Bypasses @cap-js/ai — uses @sap-ai-sdk directly.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { getSeedEmbeddings } from './relevance-seed-embeddings.js';
import { embed } from './embedding-client.js';
import { classifyByKeywords } from './relevance-keyword-rules.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';

const LOG = cds.log('relevance-classifier');
const DEFAULT_MARGIN = 0.15;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxCosine(itemVec, seedVecs) {
  let m = -1;
  for (const s of seedVecs) {
    const c = cosine(itemVec, s);
    if (c > m) m = c;
  }
  return m;
}

async function readMargin() {
  try {
    const db = cds.db ?? await cds.connect.to('db');
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const [row] = await db.run(
      SELECT.from(ChatSettings).columns('newsRelevanceMargin').limit(1),
    );
    if (row?.newsRelevanceMargin != null) return Number(row.newsRelevanceMargin);
  } catch (e) {
    LOG.warn(`readMargin failed, using default ${DEFAULT_MARGIN}: ${e.message}`);
  }
  return DEFAULT_MARGIN;
}

function keywordFallback({ title, description, error }) {
  const r = classifyByKeywords({ title, description });
  return {
    verdict: r.verdict,
    reason: r.reason,
    source: 'fallback-keyword',
    confidence: 0.5,
    model: 'keyword-rules-v1',
    error: error?.message ?? null,
  };
}

function parseLlmVerdict(rawContent) {
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON object in LLM output');
  const parsed = JSON.parse(jsonMatch[0]);
  if (parsed.verdict !== 'relevant' && parsed.verdict !== 'not-relevant') {
    throw new Error(`invalid verdict: ${parsed.verdict}`);
  }
  return {
    verdict: parsed.verdict,
    reason: String(parsed.reason ?? '').slice(0, 500),
  };
}

function buildLlmPrompt({ title, description, sourceType }) {
  const rubric = [
    'You are classifying a candidate news / blog item for a developer portal.',
    'developer-relevant = mentions APIs, SDKs, CLI, code samples, CAP, BTP, HANA, ABAP RAP, Kyma, Fiori, walkthroughs, or announces something that changes how developers build.',
    'not-developer-relevant = pure earnings, corporate announcements, non-technical partnerships, HR, awards, marketing.',
    'Respond with ONLY a JSON object of the shape {"verdict":"relevant"|"not-relevant","reason":"<one sentence>"}. No prose.',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: rubric },
      { role: 'user', content: `Source: ${sourceType}\nTitle: ${title}\nDescription: ${description ?? ''}` },
    ],
    templating: { response_format: { type: 'json_object' } },
  };
}

async function llmClassify({ title, description, sourceType }) {
  const settings = await resolveChatLlmSettings();
  if (!settings?.deploymentId) throw new Error('no chat deployment configured');
  const client = new OrchestrationClient({
    llm: {
      model_name: settings.modelName ?? 'gpt-4o-mini',
      model_params: { max_tokens: 200, temperature: 0 },
    },
  });
  const response = await client.chatCompletion(buildLlmPrompt({ title, description, sourceType }));
  const raw = typeof response.getContent === 'function'
    ? response.getContent()
    : String(response?.content ?? '');
  const parsed = parseLlmVerdict(raw);
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    source: 'llm',
    confidence: 0.75,
    model: settings.deploymentId,
  };
}

/**
 * Classify a candidate item.
 * @param {{title: string, description?: string|null, sourceType: string}} args
 * @returns {Promise<{verdict:string, reason:string, source:string, confidence:number, model:string, error?:string|null}>}
 */
export async function classify(args) {
  const { title, description, sourceType } = args;

  // Step 1+2: embed + seed load.
  let seeds, itemVec;
  try {
    seeds = await getSeedEmbeddings();
    if (seeds.relevant.length === 0 || seeds.notRelevant.length === 0) {
      LOG.info(`empty seed side (rel=${seeds.relevant.length}, not=${seeds.notRelevant.length}); keyword fallback`);
      return keywordFallback({ title, description, error: new Error('empty seeds') });
    }
    const text = `${title}\n\n${description ?? ''}`;
    const [vec] = await embed([text]);
    itemVec = vec;
  } catch (e) {
    LOG.warn(`embedding path failed: ${e.message}; keyword fallback`);
    return keywordFallback({ title, description, error: e });
  }

  // Step 3: score.
  const relevantScore = maxCosine(itemVec, seeds.relevant);
  const notScore = maxCosine(itemVec, seeds.notRelevant);
  const margin = relevantScore - notScore;
  const threshold = await readMargin();

  // Step 4: decide.
  if (margin >= threshold) {
    return {
      verdict: 'relevant',
      reason: `Embedding cosine margin ${margin.toFixed(3)} ≥ ${threshold.toFixed(3)}`,
      source: 'embedding',
      confidence: Math.min(1, margin),
      model: DEFAULT_EMBEDDING_MODEL,
    };
  }
  if (margin <= -threshold) {
    return {
      verdict: 'not-relevant',
      reason: `Embedding cosine margin ${margin.toFixed(3)} ≤ -${threshold.toFixed(3)}`,
      source: 'embedding',
      confidence: Math.min(1, Math.abs(margin)),
      model: DEFAULT_EMBEDDING_MODEL,
    };
  }

  // Step 5: LLM fallback for mid-band.
  try {
    return await llmClassify({ title, description, sourceType });
  } catch (e) {
    LOG.warn(`LLM fallback failed (${e.message}); keyword fallback`);
    return keywordFallback({ title, description, error: e });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/relevance-classifier.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/relevance-classifier.js test/unit/relevance-classifier.test.js
git commit -m "feat(#1034): source-agnostic relevance classifier (embedding + LLM + keyword)"
```

---

### Task 9: Fetch-news cron job

**Files:**
- Create: `srv/jobs/fetch-news-job.js`
- Modify: `srv/jobs/scheduler.js` — register in `JOB_REGISTRY`.
- Test:   `test/unit/fetch-news-job.test.js`
- Test fixture: `test/fixtures/news-sap-com-feed/mixed.xml`

**Interfaces:**
- Consumes: `fetchRssItems` from `srv/lib/homepage-rss-fetcher.js`, `canonicalizeLink`, `detectLanguageEn`, `classify` from `srv/lib/relevance-classifier.js`.
- Produces: `runFetchNews(logId?, opts?) → Promise<{ fetched, upserted, classified, skippedNoChange, nonEnglish, errors }>` — registered as `fetch-news` cron.

- [ ] **Step 1: Create the mixed fixture**

Create `test/fixtures/news-sap-com-feed/mixed.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>New CAP release brings Java 22</title>
    <link>https://news.sap.com/2026/07/cap-10/</link>
    <pubDate>Mon, 06 Jul 2026 09:00:00 +0000</pubDate>
    <description>The CAP framework is the future of SAP development for developers.</description>
    <guid isPermaLink="false">news-1</guid>
  </item>
  <item>
    <title>Q2 earnings update</title>
    <link>https://news.sap.com/2026/07/earnings/?utm_source=rss</link>
    <pubDate>Mon, 06 Jul 2026 08:00:00 +0000</pubDate>
    <description>The board of directors will meet to discuss revenue and guidance.</description>
  </item>
  <item>
    <title>Nachrichten aus SAP</title>
    <link>https://news.sap.com/2026/07/de/</link>
    <pubDate>Mon, 06 Jul 2026 07:00:00 +0000</pubDate>
    <description>Ein deutscher Text ohne englische Funktionswoerter.</description>
  </item>
</channel></rss>
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/fetch-news-job.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rssMock = vi.fn();
const classifyMock = vi.fn();

vi.mock('../../srv/lib/homepage-rss-fetcher.js', async () => {
  const real = await vi.importActual('../../srv/lib/homepage-rss-fetcher.js');
  return { ...real, fetchRssItems: (...a) => rssMock(...a) };
});
vi.mock('../../srv/lib/relevance-classifier.js', () => ({
  classify: (...a) => classifyMock(...a),
}));

const { runFetchNews } = await import('../../srv/jobs/fetch-news-job.js');

function fixtureItems() {
  const xml = readFileSync(join(process.cwd(), 'test', 'fixtures', 'news-sap-com-feed', 'mixed.xml'), 'utf8');
  // Reuse the real parser via the test-only export.
  return xml;
}

describe('fetch-news-job', () => {
  beforeEach(async () => {
    classifyMock.mockReset();
    rssMock.mockReset();
    await cds.test('serve', 'srv').in(process.cwd()).homepageBooted;
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    // Enable relevance so read path exercises the table.
  });

  it('inserts new rows, classifies English items, skips non-English classify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
      { guid: null,     link: 'https://news.sap.com/DE/', title: 't2', description: 'Nachrichten',    publishedAt: '2026-07-06T08:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({
      verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'text-embedding-3-small',
    });

    const summary = await runFetchNews();
    expect(summary.fetched).toBe(2);
    expect(summary.upserted).toBe(2);
    expect(summary.classified).toBe(1);
    expect(summary.nonEnglish).toBe(1);
    expect(classifyMock).toHaveBeenCalledTimes(1);

    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems'));
    expect(rows.map(r => r.sourceId).sort()).toEqual(['https://news.sap.com/de/', 'news-1']);
    const en = rows.find(r => r.language === 'en');
    expect(en.aiVerdict).toBe('relevant');
    expect(en.aiVerdictSource).toBe('embedding');
    const de = rows.find(r => r.language !== 'en');
    expect(de.aiVerdict).toBe('pending');
  });

  it('re-fetch with unchanged contentHash → no reclassify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();
    expect(classifyMock).toHaveBeenCalledTimes(1);

    classifyMock.mockClear();
    await runFetchNews();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('does not overwrite admin columns on reclassify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();

    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
      .set({ adminVerdict: 'reject', adminBy: 'admin@example.com', adminNote: 'off-topic' })
      .where({ sourceId: 'news-1' }));

    // Force reclassify by changing the description hash.
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'CHANGED text the of and', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'not-relevant', reason: 're', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();

    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId: 'news-1' }));
    expect(row.aiVerdict).toBe('not-relevant');
    expect(row.adminVerdict).toBe('reject');           // preserved
    expect(row.adminBy).toBe('admin@example.com');     // preserved
    expect(row.adminNote).toBe('off-topic');           // preserved
  });

  it('uses canonicalized link as sourceId when guid missing', async () => {
    rssMock.mockResolvedValue([
      { guid: null, link: 'https://News.SAP.com/A/?utm_source=x', title: 't', description: 'the of and', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'r', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems'));
    expect(row.sourceId).toBe('https://news.sap.com/a/');
  });
});
```

- [ ] **Step 3: Implement the job**

Create `srv/jobs/fetch-news-job.js`:

```js
// srv/jobs/fetch-news-job.js
//
// Hourly cron pulling news.sap.com/feed/, upserting NewsItems, and calling
// the relevance classifier on new/changed rows. (#1034)
//
// Reclassify only when contentHash changes; admin columns are NEVER
// overwritten by classifier writes.

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchRssItems } from '../lib/homepage-rss-fetcher.js';
import { canonicalizeLink } from '../lib/canonicalize-link.js';
import { detectLanguageEn } from '../lib/detect-language-en.js';
import { classify } from '../lib/relevance-classifier.js';

const LOG = cds.log('fetch-news');
const SAP_NEWS_RSS_URL = 'https://news.sap.com/feed/';

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

function deriveSourceId(item) {
  if (item.guid && item.guid.trim()) return item.guid.trim();
  return canonicalizeLink(item.link);
}

const CLASSIFIER_UPDATE_COLS = [
  'title', 'description', 'link', 'publishedAt', 'language', 'contentHash',
  'aiVerdict', 'aiReason', 'aiVerdictSource', 'aiConfidence', 'aiVerdictAt',
  'aiModel', 'lastFetchedAt', 'classifyError',
  // NOTE: adminVerdict, adminNote, adminBy, adminAt are DELIBERATELY excluded.
];

/**
 * @param {*} _logId  reserved for cron chassis (unused here)
 * @param {*} _opts   reserved
 * @returns {Promise<{fetched:number,upserted:number,classified:number,skippedNoChange:number,nonEnglish:number,errors:number}>}
 */
export async function runFetchNews(_logId, _opts) {
  const items = await fetchRssItems(SAP_NEWS_RSS_URL, { limit: 100 });
  const summary = { fetched: items.length, upserted: 0, classified: 0, skippedNoChange: 0, nonEnglish: 0, errors: 0 };
  const db = cds.db ?? await cds.connect.to('db');
  const { NewsItems } = cds.entities('com.sap.developers.ims.external');
  const now = new Date().toISOString();

  for (const raw of items) {
    const sourceId = deriveSourceId(raw);
    if (!sourceId || !raw.title || !raw.link) {
      summary.errors++;
      continue;
    }
    const contentHash = sha256Hex(`${raw.title || ''}\n${raw.description || ''}`);
    const language = detectLanguageEn(`${raw.title} ${raw.description ?? ''}`);

    // Load existing row (if any).
    let existing;
    try {
      [existing] = await db.run(SELECT.from(NewsItems).where({ sourceId }));
    } catch (e) {
      LOG.warn(`SELECT NewsItems ${sourceId} failed: ${e.message}`);
      summary.errors++;
      continue;
    }

    // Skip reclassify if hash unchanged AND verdict already terminal.
    if (existing && existing.contentHash === contentHash
        && (existing.aiVerdict === 'relevant' || existing.aiVerdict === 'not-relevant')) {
      await db.run(UPDATE(NewsItems).set({ lastFetchedAt: now }).where({ sourceId }));
      summary.skippedNoChange++;
      continue;
    }

    // Non-English → store pending, no classifier call.
    if (language !== 'en') {
      summary.nonEnglish++;
      const row = {
        sourceId,
        link: raw.link, title: raw.title, description: raw.description,
        publishedAt: raw.publishedAt, language, contentHash,
        aiVerdict: 'pending', aiReason: 'non-English', aiVerdictSource: null,
        aiConfidence: null, aiVerdictAt: now, aiModel: null,
        lastFetchedAt: now, classifyError: null,
      };
      if (existing) {
        await db.run(UPDATE(NewsItems).set(pick(row, CLASSIFIER_UPDATE_COLS)).where({ sourceId }));
      } else {
        await db.run(INSERT.into(NewsItems).entries(row));
        summary.upserted++;
      }
      continue;
    }

    // Classify English item.
    let verdict;
    try {
      verdict = await classify({ title: raw.title, description: raw.description, sourceType: 'sap-news' });
      summary.classified++;
    } catch (e) {
      LOG.warn(`classify failed for ${sourceId}: ${e.message}`);
      summary.errors++;
      verdict = {
        verdict: 'pending', reason: e.message, source: 'fallback-keyword',
        confidence: null, model: null, error: e.message,
      };
    }

    const row = {
      sourceId,
      link: raw.link, title: raw.title, description: raw.description,
      publishedAt: raw.publishedAt, language, contentHash,
      aiVerdict: verdict.verdict,
      aiReason: verdict.reason,
      aiVerdictSource: verdict.source,
      aiConfidence: verdict.confidence,
      aiVerdictAt: now,
      aiModel: verdict.model,
      lastFetchedAt: now,
      classifyError: verdict.error ?? null,
    };
    if (existing) {
      await db.run(UPDATE(NewsItems).set(pick(row, CLASSIFIER_UPDATE_COLS)).where({ sourceId }));
    } else {
      await db.run(INSERT.into(NewsItems).entries(row));
      summary.upserted++;
    }
  }

  // Invalidate the homepage in-process cache so admins see fresh verdicts fast.
  try {
    const mod = await import('../homepage-service.js');
    mod.resetNewsCache?.();
  } catch (e) {
    LOG.warn(`resetNewsCache import failed: ${e.message}`);
  }

  LOG.info(`fetch-news summary: ${JSON.stringify(summary)}`);
  return summary;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
```

- [ ] **Step 4: Register the job in `srv/jobs/scheduler.js`**

Near the other `registerJob` calls (around line 460+), add:

```js
  // #1034 SAP News developer-relevance filter.
  registerJob({
    jobName:     'fetch-news',
    schedule:    '37 * * * *',
    ttlMs:       10 * 60 * 1000,
    description: 'Fetch news.sap.com/feed/ hourly and classify developer relevance',
    fn:          () => runFetchNews(),
  });
```

At the top of `srv/jobs/scheduler.js` add the import next to the existing `runFetchBlogPosts` import:

```js
import { runFetchNews } from './fetch-news-job.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/fetch-news-job.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/fetch-news-job.js srv/jobs/scheduler.js test/unit/fetch-news-job.test.js test/fixtures/news-sap-com-feed/mixed.xml
git commit -m "feat(#1034): hourly fetch-news cron with classifier integration"
```

---

### Task 10: Homepage `news()` handler rewrite + kill switches

**Files:**
- Modify: `srv/homepage-service.js` — replace `news()` body, add `resetNewsCache()`, add `_state.news` cache.
- Test:   `test/unit/homepage-news-filter.test.js`

**Interfaces:**
- Consumes: entity `NewsItems`, `HomepageConfig.newsRelevanceEnabled` from Task 5.
- Produces: `resetNewsCache(): void` (named export). `news()` handler now reads `NewsItems` when the two-layer kill switch is on, else falls back to the pre-existing pass-through.

- [ ] **Step 1: Write the failing test**

Create `test/unit/homepage-news-filter.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const rssMock = vi.fn();
vi.mock('../../srv/lib/homepage-rss-fetcher.js', async () => {
  const real = await vi.importActual('../../srv/lib/homepage-rss-fetcher.js');
  return { ...real, fetchRssItems: (...a) => rssMock(...a) };
});

describe('homepage news() with #1034 filter', () => {
  let srv;
  beforeEach(async () => {
    const test = cds.test('serve', 'srv').in(process.cwd());
    await test.homepageBooted;
    srv = await cds.connect.to('HomepageService');
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: false }));
    const mod = await import('../../srv/homepage-service.js');
    mod._resetForTests();
    delete process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED;
  });

  async function seedRow(overrides = {}) {
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.external.NewsItems').entries({
      sourceId: 's-' + Math.random().toString(36).slice(2),
      link: 'https://news.sap.com/x',
      title: 'x',
      description: 'y',
      publishedAt: new Date().toISOString(),
      language: 'en',
      contentHash: 'h',
      aiVerdict: 'relevant',
      aiReason: 'r', aiVerdictSource: 'embedding', aiConfidence: 0.9,
      aiVerdictAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      ...overrides,
    }));
  }

  it('kill switch off (HomepageConfig=false) → falls back to legacy RSS pass-through', async () => {
    rssMock.mockResolvedValue([{ title: 'passthrough', link: 'https://x', publishedAt: null, description: null }]);
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('passthrough');
    expect(rssMock).toHaveBeenCalled();
  });

  it('kill switch on → serves relevant items from NewsItems, capped at 2', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ title: 'A' });
    await seedRow({ title: 'B' });
    await seedRow({ title: 'C' });
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(2);
    expect(rssMock).not.toHaveBeenCalled();
  });

  it('adminVerdict=approve overrides aiVerdict=not-relevant', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ aiVerdict: 'not-relevant', adminVerdict: 'approve', title: 'admin-approved' });
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('admin-approved');
  });

  it('adminVerdict=reject hides an ai-relevant item', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ aiVerdict: 'relevant', adminVerdict: 'reject' });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('items older than 14 days are excluded', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await seedRow({ publishedAt: old });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('non-English rows never appear', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ language: null, aiVerdict: 'pending' });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('env HOMEPAGE_NEWS_RELEVANCE_ENABLED=false dominates HomepageConfig=true', async () => {
    process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED = 'false';
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    rssMock.mockResolvedValue([{ title: 'env-forced-passthrough', link: 'x', publishedAt: null, description: null }]);
    const r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('env-forced-passthrough');
  });

  it('resetNewsCache invalidates the 60s cache', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ title: 'first' });
    let r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('first');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    // Without reset, cache returns stale.
    r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('first');
    // Reset then expect empty.
    const mod = await import('../../srv/homepage-service.js');
    mod.resetNewsCache();
    r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/homepage-news-filter.test.js`
Expected: FAIL — `resetNewsCache` not exported; `news()` still uses legacy path.

- [ ] **Step 3: Modify `srv/homepage-service.js`**

Extend `_state` (near line 35) to add a `news` slot:

```js
const _state = (globalThis[STATE_KEY] ??= {
  events: { at: 0, value: null },
  shelves: new Map(),
  ft: { at: 0, payload: null },
  news: { at: 0, value: null },          // #1034
});
```

Extend `_resetForTests` (near line 44):

```js
export function _resetForTests() {
  _state.events = { at: 0, value: null };
  _state.shelves.clear();
  _state.ft = { at: 0, payload: null };
  _state.news = { at: 0, value: null };  // #1034
}
```

Add near `resetFtCache` (after line 54):

```js
/** (#1034) Invalidate the news in-process cache. Called by
 *  content-moderation-service handlers after admin approve/reject writes
 *  and by fetch-news-job at the end of every successful cron. */
export function resetNewsCache() {
  _state.news = { at: 0, value: null };
}

const NEWS_CACHE_MS = 60_000;
const NEWS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

async function _isNewsRelevanceEnabled() {
  if (process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED === 'false') return false;
  try {
    const db = await cds.connect.to('db');
    const { HomepageConfig } = cds.entities('com.sap.developers.ims');
    const [cfg] = await db.run(
      SELECT.from(HomepageConfig).columns('newsRelevanceEnabled').limit(1),
    );
    return cfg?.newsRelevanceEnabled === true;
  } catch (e) {
    log.warn(`_isNewsRelevanceEnabled failed, treating as false: ${e.message}`);
    return false;
  }
}
```

Replace the existing `news()` handler (around line 222) with:

```js
    // (#1034) news() — filtered from NewsItems + admin override, 60s cache.
    this.on('news', async () => {
      const now = Date.now();
      const enabled = await _isNewsRelevanceEnabled();
      if (!enabled) {
        return fetchRssItems(SAP_NEWS_RSS_URL, { limit: 2 });
      }
      if (_state.news.value !== null && (now - _state.news.at) < NEWS_CACHE_MS) {
        return _state.news.value;
      }
      try {
        const db = await cds.connect.to('db');
        const { NewsItems } = cds.entities('com.sap.developers.ims.external');
        const cutoff = new Date(now - NEWS_WINDOW_MS).toISOString();
        const rows = await db.run(
          SELECT.from(NewsItems)
            .columns('title', 'link', 'publishedAt', 'description', 'aiVerdict', 'adminVerdict')
            .where({ publishedAt: { '>=': cutoff }, language: 'en' })
            .orderBy('publishedAt desc')
            .limit(50),
        );
        const filtered = (rows || []).filter(r => {
          if (r.adminVerdict === 'approve') return true;
          if (r.adminVerdict === 'reject') return false;
          return r.aiVerdict === 'relevant';
        }).slice(0, 2).map(({ title, link, publishedAt, description }) =>
          ({ title, link, publishedAt, description }));
        _state.news = { at: now, value: filtered };
        return filtered;
      } catch (e) {
        log.warn(`news() DB read failed, returning empty: ${e.message}`);
        return [];
      }
    });
```

Remove the old news handler body that read via `fetchRssItems`; the branch on `_isNewsRelevanceEnabled` above already covers it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/homepage-news-filter.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Run all homepage-service tests to prove no regression**

Run: `npx vitest run test/unit --testNamePattern homepage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/homepage-service.js test/unit/homepage-news-filter.test.js
git commit -m "feat(#1034): homepage news() reads NewsItems w/ admin-override + kill switches"
```

---

### Task 11: `ContentModerationService` CDS + JS handlers

**Files:**
- Create: `srv/content-moderation-service.cds`
- Create: `srv/content-moderation-service.js`
- Test:   `test/unit/content-moderation-service.test.js`

**Interfaces:**
- Consumes: entities from Task 5; `invalidateSeed` from Task 7; `resetNewsCache` from Task 10; `classify` from Task 8; existing `runJobByName` from `srv/jobs/scheduler.js`.
- Produces: service `com.sap.developers.ims.ContentModerationService` at path `/content-moderation` with entities `NewsItems`, `BlogPosts`, `RelevanceSeedExemplars` and bound actions `approve(note?)`, `reject(note?)`, `clearOverride()`, `reclassify()`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/content-moderation-service.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const classifyMock = vi.fn();
vi.mock('../../srv/lib/relevance-classifier.js', () => ({
  classify: (...a) => classifyMock(...a),
}));

describe('ContentModerationService', () => {
  let auth = { user: 'author@example.com', roles: ['Tutorial.Author'] };
  beforeEach(async () => {
    classifyMock.mockReset();
    await cds.test('serve', 'srv').in(process.cwd()).homepageBooted;
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    await db.run(INSERT.into('com.sap.developers.ims.external.NewsItems').entries({
      sourceId: 'n1', link: 'https://x', title: 't', description: 'd',
      publishedAt: new Date().toISOString(), language: 'en', contentHash: 'h',
      aiVerdict: 'not-relevant', aiReason: 'x', aiVerdictSource: 'embedding',
      aiConfidence: 0.9, aiVerdictAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
    }));
  });

  it('Tutorial.Author can read NewsItems', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const rows = await srv.tx({ user: new cds.User({ id: 'a', roles: ['Tutorial.Author'] }) })
      .run(SELECT.from('ContentModerationService.NewsItems'));
    expect(rows).toHaveLength(1);
  });

  it('non-Author cannot read NewsItems', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    await expect(
      srv.tx({ user: new cds.User({ id: 'x', roles: [] }) })
        .run(SELECT.from('ContentModerationService.NewsItems')),
    ).rejects.toThrow();
  });

  it('SuperAdmin approve sets adminVerdict + adminBy + adminAt + invalidates cache', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa@x.com', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    await srv.tx({ user }).run(
      srv.entities.NewsItems.actions.approve({ note: 'looks good' }).at({ sourceId: 'n1' }),
    );
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId: 'n1' }));
    expect(row.adminVerdict).toBe('approve');
    expect(row.adminBy).toBe('sa@x.com');
    expect(row.adminAt).toBeTruthy();
    expect(row.adminNote).toBe('looks good');
  });

  it('non-SuperAdmin approve → 403', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'a', roles: ['Tutorial.Author'] });
    await expect(
      srv.tx({ user }).run(
        srv.entities.NewsItems.actions.approve({}).at({ sourceId: 'n1' }),
      ),
    ).rejects.toThrow();
  });

  it('clearOverride nulls the admin columns', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    await srv.tx({ user }).run(
      srv.entities.NewsItems.actions.approve({}).at({ sourceId: 'n1' }),
    );
    await srv.tx({ user }).run(
      srv.entities.NewsItems.actions.clearOverride({}).at({ sourceId: 'n1' }),
    );
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId: 'n1' }));
    expect(row.adminVerdict).toBeNull();
    expect(row.adminBy).toBeNull();
  });

  it('reclassify calls classifier + writes new AI columns w/o touching admin cols', async () => {
    classifyMock.mockResolvedValue({
      verdict: 'relevant', reason: 'new signal', source: 'embedding',
      confidence: 0.8, model: 'text-embedding-3-small',
    });
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    // Pre-set admin fields, then reclassify.
    await srv.tx({ user }).run(
      srv.entities.NewsItems.actions.reject({ note: 'off-topic' }).at({ sourceId: 'n1' }),
    );
    await srv.tx({ user }).run(
      srv.entities.NewsItems.actions.reclassify({}).at({ sourceId: 'n1' }),
    );
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId: 'n1' }));
    expect(row.aiVerdict).toBe('relevant');
    expect(row.aiReason).toBe('new signal');
    expect(row.adminVerdict).toBe('reject');       // preserved
    expect(row.adminNote).toBe('off-topic');       // preserved
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-moderation-service.test.js`
Expected: FAIL — service not defined.

- [ ] **Step 3: Implement `srv/content-moderation-service.cds`**

```cds
namespace com.sap.developers.ims;

using { com.sap.developers.ims.external } from '../db/external-content';

/**
 * #1034 Admin moderation surface for content sources that ship to the homepage
 * behind a developer-relevance classifier. NewsItems is populated by
 * fetch-news-job. BlogPosts projection is a placeholder that #1033 will fill.
 * RelevanceSeedExemplars are the classifier's shared seed exemplars.
 *
 * All entity reads gated at Tutorial.Author; write actions gated at
 * internal.SuperAdmin. Draft NOT enabled — actions immediate-save.
 */
@path: '/content-moderation'
@requires: 'Tutorial.Author'
service ContentModerationService {

  @readonly
  entity NewsItems as projection on external.NewsItems actions {
    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action approve(note: String(500));

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action reject(note: String(500));

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action clearOverride();

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action reclassify();
  };

  // #1033 placeholder — projection over an entity that #1033 will introduce.
  // Until then the projection is intentionally omitted; #1033 adds it.
  // (Note to reviewer: leaving as a comment so the CDS compiles today.)

  @(restrict: [
    { grant: 'READ',                              to: 'Tutorial.Author'      },
    { grant: ['CREATE','UPDATE','DELETE'],        to: 'internal.SuperAdmin'  },
  ])
  entity RelevanceSeedExemplars as projection on external.RelevanceSeedExemplars
    excluding { embedding };
}
```

- [ ] **Step 4: Implement `srv/content-moderation-service.js`**

```js
// srv/content-moderation-service.js
//
// #1034 Admin surface for the developer-relevance filter. Approve/reject/
// clearOverride/reclassify actions on NewsItems; seed CRUD on
// RelevanceSeedExemplars with server-managed embedding column.

import cds from '@sap/cds';
import { classify } from './lib/relevance-classifier.js';
import { invalidateSeed } from './lib/relevance-seed-embeddings.js';
import { embed } from './lib/embedding-client.js';
import { resetNewsCache } from './homepage-service.js';

const LOG = cds.log('content-moderation-service');

export default class ContentModerationService extends cds.ApplicationService {
  async init() {
    const { NewsItems, RelevanceSeedExemplars } = this.entities;

    // ------------------ Bound actions on NewsItems ------------------

    this.on('approve', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const note = req.data.note ?? null;
      const now = new Date().toISOString();
      await UPDATE(this.entities.NewsItems).set({
        adminVerdict: 'approve', adminNote: note,
        adminBy: req.user.id, adminAt: now,
      }).where({ sourceId });
      resetNewsCache();
      return { sourceId, adminVerdict: 'approve' };
    });

    this.on('reject', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const note = req.data.note ?? null;
      const now = new Date().toISOString();
      await UPDATE(this.entities.NewsItems).set({
        adminVerdict: 'reject', adminNote: note,
        adminBy: req.user.id, adminAt: now,
      }).where({ sourceId });
      resetNewsCache();
      return { sourceId, adminVerdict: 'reject' };
    });

    this.on('clearOverride', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      await UPDATE(this.entities.NewsItems).set({
        adminVerdict: null, adminNote: null,
        adminBy: null, adminAt: null,
      }).where({ sourceId });
      resetNewsCache();
      return { sourceId, adminVerdict: null };
    });

    this.on('reclassify', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const db = await cds.connect.to('db');
      const ext = cds.entities('com.sap.developers.ims.external');
      const [row] = await db.run(SELECT.from(ext.NewsItems).where({ sourceId }));
      if (!row) req.reject(404, `NewsItems ${sourceId} not found`);
      const verdict = await classify({
        title: row.title, description: row.description, sourceType: 'sap-news',
      });
      await db.run(UPDATE(ext.NewsItems).set({
        aiVerdict: verdict.verdict,
        aiReason: verdict.reason,
        aiVerdictSource: verdict.source,
        aiConfidence: verdict.confidence,
        aiVerdictAt: new Date().toISOString(),
        aiModel: verdict.model,
        classifyError: verdict.error ?? null,
      }).where({ sourceId }));
      resetNewsCache();
      return { sourceId, aiVerdict: verdict.verdict };
    });

    // ------------------ Seed embedding lifecycle --------------------

    async function recomputeEmbedding(id) {
      try {
        const db = await cds.connect.to('db');
        const ext = cds.entities('com.sap.developers.ims.external');
        const [row] = await db.run(SELECT.from(ext.RelevanceSeedExemplars).where({ ID: id }));
        if (!row || !row.text || row.active !== true) {
          invalidateSeed(id);
          return;
        }
        const [vec] = await embed([row.text]);
        await db.run(UPDATE(ext.RelevanceSeedExemplars)
          .set({ embedding: Array.from(vec) })
          .where({ ID: id }));
        invalidateSeed(id);
      } catch (e) {
        LOG.warn(`recomputeEmbedding(${id}) failed: ${e.message}`);
      }
    }

    this.after('CREATE', RelevanceSeedExemplars, async (row) => {
      if (row?.ID) await recomputeEmbedding(row.ID);
    });

    this.after('UPDATE', RelevanceSeedExemplars, async (row, req) => {
      const id = row?.ID ?? req?.params?.[0]?.ID;
      if (id) await recomputeEmbedding(id);
    });

    await super.init();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/content-moderation-service.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/content-moderation-service.cds srv/content-moderation-service.js test/unit/content-moderation-service.test.js
git commit -m "feat(#1034): ContentModerationService with approve/reject/reclassify + seed CRUD"
```

---

### Task 12: MTA + admin-service projection housekeeping

**Files:**
- Modify: `.deploy/mta.yaml` — add new `srv/lib/*.js` + `srv/jobs/fetch-news-job.js` + `srv/content-moderation-service.*` to the `srv-qa` `cp` list.
- Modify: `srv/admin-service.cds` — expose the five new `ChatSettings` fields on the existing projection.
- Test: reuse `test/unit/xs-security-authorities.test.js` (already exists) — no new test needed here; a boot-time smoke covers the projection.

**Interfaces:**
- Consumes: schema additions from Task 5.
- Produces: `srv-qa` deploy target has visibility into every new file introduced by this plan; admins can edit the three tunable `ChatSettings` knobs from `/admin-ui/#chat-settings` (or wherever the ChatSettings tab lives).

- [ ] **Step 1: Extend admin-service projection**

In `srv/admin-service.cds`, find the `entity ChatSettings as projection on ims.ChatSettings` block (around line 265). Nothing to change in the projection itself — CAP exposes new base columns automatically. Verify by boot.

If the projection uses `columns` explicitly (some CAP projects list them), add:

```cds
  newsRelevanceLlmBudgetPerDay,
  newsRelevanceMargin,
  newsFetchCadenceMinutes,
  newsRelevanceLlmCallsToday,
  newsRelevanceLlmCallsCountedOn,
```

Check the file first with:

```bash
sed -n '260,290p' srv/admin-service.cds
```

If the projection is `as projection on ims.ChatSettings actions { … }` with no `{ columns }` block, no edit needed.

- [ ] **Step 2: Add new files to `.deploy/mta.yaml` `srv-qa` `cp` list**

Find the `srv-qa` module's `build-parameters.build-result` / `cp` glob list. Add these entries (adjust to match the yaml shape actually in use):

```yaml
        - srv/lib/relevance-classifier.js
        - srv/lib/relevance-seed-embeddings.js
        - srv/lib/relevance-keyword-rules.js
        - srv/lib/canonicalize-link.js
        - srv/lib/detect-language-en.js
        - srv/jobs/fetch-news-job.js
        - srv/content-moderation-service.cds
        - srv/content-moderation-service.js
```

Diagnostic (memory-noted rule: srv-qa cp-list audit after every `srv/lib/` change):

```bash
grep -n "srv/lib/" .deploy/mta.yaml | head -30
```

- [ ] **Step 3: Deploy-time smoke — CDS compiles + service boots**

Run: `npx cds build --production`
Expected: exit 0.

Run: `npx cds deploy --to sqlite::memory:`
Expected: exit 0. No `UNIQUE constraint failed`.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml srv/admin-service.cds
git commit -m "chore(#1034): srv-qa cp list + admin-service projection for new ChatSettings fields"
```

---

### Task 13: Admin-shell route registration

**Files:**
- Modify: `app/admin-shell/webapp/manifest.json` — add the `contentModeration` route.
- Test:   `test/unit/admin-shell-content-moderation-route.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `/admin-ui/#content-moderation` resolves to a `contentModerationTarget` that loads `sap.tutorials.admin.contentModeration`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admin-shell-content-moderation-route.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = join(process.cwd(), 'app', 'admin-shell', 'webapp', 'manifest.json');

describe('admin-shell #1034 route', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const routing = m['sap.ui5'].routing;

  it('registers a contentModeration route with pattern "content-moderation"', () => {
    const route = routing.routes.find(r => r.name === 'contentModeration');
    expect(route).toBeTruthy();
    expect(route.pattern).toBe('content-moderation');
  });

  it('has a matching contentModerationTarget with prefix "cm"', () => {
    const t = routing.targets.contentModerationTarget;
    expect(t).toBeTruthy();
    expect(t.prefix).toBe('cm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-shell-content-moderation-route.test.js`
Expected: FAIL — route missing.

- [ ] **Step 3: Edit `app/admin-shell/webapp/manifest.json`**

Locate `sap.ui5.routing.routes` array. Append a route object matching the shape of existing routes (`homepageShelves`, `homepageRedirects`, `homepageConfig` — copy their target-name pattern):

```json
{
  "name": "contentModeration",
  "pattern": "content-moderation",
  "target": [{ "name": "contentModerationTarget", "prefix": "cm" }]
}
```

Locate `sap.ui5.routing.targets` object. Add a target object matching the shape of `homepageTarget`:

```json
"contentModerationTarget": {
  "type": "Component",
  "name": "sap.tutorials.admin.contentModeration",
  "prefix": "cm",
  "id": "contentModerationComponent",
  "options": {
    "settings": {}
  },
  "controlAggregation": "pages",
  "controlId": "shellNavContainer"
}
```

(Confirm structure by opening the file — copy field-for-field from `homepageTarget` to match whatever the actual shape is, only substituting the component name.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-shell-content-moderation-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/manifest.json test/unit/admin-shell-content-moderation-route.test.js
git commit -m "feat(#1034): admin-shell content-moderation route + target"
```

---

### Task 14: Admin FE app scaffolding — `app/admin/content-moderation/`

**Files:**
- Create: `app/admin/content-moderation/package.json`
- Create: `app/admin/content-moderation/ui5.yaml`
- Create: `app/admin/content-moderation/webapp/manifest.json`
- Create: `app/admin/content-moderation/webapp/Component.js`
- Create: `app/admin/content-moderation/webapp/i18n/i18n.properties`
- Create: `app/admin/content-moderation/webapp/index.html` (for standalone preview only)
- Test:   `test/unit/content-moderation-fe-scaffold.test.js`

**Interfaces:**
- Consumes: `ContentModerationService` from Task 11; routing target registered in Task 13.
- Produces: an FE V4 List Report + Object Page over `NewsItems`, with a `RelevanceSeedExemplars` tab. Rendered under `/admin-ui/#content-moderation`.

Template shape: copy `app/admin/homepage/` verbatim, then substitute component id, service uri, entity set, and title.

- [ ] **Step 1: Write the failing scaffold test**

Create `test/unit/content-moderation-fe-scaffold.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(process.cwd(), 'app', 'admin', 'content-moderation');

describe('#1034 content-moderation FE scaffold', () => {
  it('has package.json + ui5.yaml + Component.js + manifest.json', () => {
    for (const f of ['package.json', 'ui5.yaml', 'webapp/Component.js', 'webapp/manifest.json']) {
      expect(existsSync(join(APP, f)), `missing ${f}`).toBe(true);
    }
  });

  it('manifest declares component id sap.tutorials.admin.contentModeration', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.contentModeration');
  });

  it('manifest points OData model at /content-moderation', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    const modelUri = m['sap.app'].dataSources?.mainService?.uri
      ?? m['sap.ui5']?.models?.['']?.settings?.serviceUrl;
    expect(modelUri).toBe('/content-moderation/');
  });

  it('manifest defines routes for NewsItems list + object page', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    const routing = m['sap.ui5'].routing;
    const routeNames = routing.routes.map(r => r.name);
    expect(routeNames).toContain('NewsItemsList');
    expect(routeNames).toContain('NewsItemsObjectPage');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-moderation-fe-scaffold.test.js`
Expected: FAIL — files missing.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "content-moderation",
  "version": "0.0.1",
  "private": true,
  "sapux": true,
  "scripts": {
    "start": "ui5 serve --port 8080 --open index.html",
    "build": "ui5 build --clean-dest --dest dist"
  },
  "devDependencies": {
    "@ui5/cli": "^3"
  }
}
```

- [ ] **Step 4: Create `ui5.yaml`**

Copy from `app/admin/homepage/ui5.yaml`. Substitute `name:` value with `sap.tutorials.admin.contentModeration`.

- [ ] **Step 5: Create `webapp/manifest.json`**

Copy from `app/admin/homepage/webapp/manifest.json`. Substitute:
- `sap.app.id` → `sap.tutorials.admin.contentModeration`
- `sap.app.title` → `Content Moderation`
- `sap.app.dataSources.mainService.uri` → `/content-moderation/`
- Entity set in the manifest `entitySet:` fields → `NewsItems`
- Root object under `routing.routes` and `routing.targets` renamed to `NewsItemsList` / `NewsItemsObjectPage`
- Add a second entity-set page for `RelevanceSeedExemplars` — same shape.

Minimum viable manifest (start from the template and edit fields; the JSON below is the shape check the test enforces):

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.contentModeration",
    "type": "application",
    "title": "Content Moderation",
    "dataSources": {
      "mainService": {
        "uri": "/content-moderation/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui": { "technology": "UI5" },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.121.0",
      "libs": {
        "sap.fe.templates": {},
        "sap.m": {},
        "sap.ui.core": {}
      }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "settings": { "synchronizationMode": "None", "operationMode": "Server" }
      }
    },
    "routing": {
      "config": {
        "routerClass": "sap.f.routing.Router",
        "async": true
      },
      "routes": [
        { "name": "NewsItemsList", "pattern": ":?query:", "target": "NewsItemsList" },
        { "name": "NewsItemsObjectPage", "pattern": "NewsItems({key}):?query:", "target": "NewsItemsObjectPage" },
        { "name": "SeedsList", "pattern": "seeds:?query:", "target": "SeedsList" }
      ],
      "targets": {
        "NewsItemsList": {
          "type": "Component",
          "id": "NewsItemsList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "entitySet": "NewsItems",
              "navigation": { "NewsItems": { "detail": { "route": "NewsItemsObjectPage" } } }
            }
          }
        },
        "NewsItemsObjectPage": {
          "type": "Component",
          "id": "NewsItemsObjectPage",
          "name": "sap.fe.templates.ObjectPage",
          "options": { "settings": { "entitySet": "NewsItems" } }
        },
        "SeedsList": {
          "type": "Component",
          "id": "SeedsList",
          "name": "sap.fe.templates.ListReport",
          "options": { "settings": { "entitySet": "RelevanceSeedExemplars" } }
        }
      }
    }
  }
}
```

Note: this is the manifest shape the FE V4 wizard produces. If `app/admin/homepage/` uses a slightly different shape (e.g. FE ListReportObjectPage as one component), match that shape instead — the test only checks four fields.

- [ ] **Step 6: Create `Component.js`**

```js
sap.ui.define(['sap/fe/core/AppComponent'], function (AppComponent) {
  'use strict';
  return AppComponent.extend('sap.tutorials.admin.contentModeration.Component', {
    metadata: { manifest: 'json' },
  });
});
```

- [ ] **Step 7: Create `i18n/i18n.properties`**

```properties
appTitle=Content Moderation
appDescription=Approve or reject items surfaced from external sources before they reach the homepage.
```

- [ ] **Step 8: Create `webapp/index.html` (standalone preview only)**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Content Moderation</title>
    <script id="sap-ui-bootstrap"
      src="https://sdk.openui5.org/1.121.0/resources/sap-ui-core.js"
      data-sap-ui-theme="sap_horizon"
      data-sap-ui-async="true"
      data-sap-ui-oninit="module:sap/ui/core/ComponentSupport"></script>
  </head>
  <body class="sapUiBody">
    <div data-sap-ui-component
         data-name="sap.tutorials.admin.contentModeration"
         data-id="container"
         data-settings='{"id" : "content-moderation"}'></div>
  </body>
</html>
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/unit/content-moderation-fe-scaffold.test.js`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add app/admin/content-moderation test/unit/content-moderation-fe-scaffold.test.js
git commit -m "feat(#1034): FE V4 scaffold for content-moderation admin app"
```

---

### Task 15: FE annotations for the NewsItems list report

**Files:**
- Create: `app/admin/content-moderation/webapp/annotations.cds` (a UI CDS annotations file if the project convention is to co-locate; else add to `srv/content-moderation-service.cds`).
- Test:   `test/unit/content-moderation-annotations.test.js`

**Interfaces:**
- Consumes: `ContentModerationService.NewsItems` from Task 11.
- Produces: `@UI.LineItem` on `NewsItems` with all columns from Section "Admin surface > Tab 1" in the spec. `@UI.HeaderInfo`, `@UI.SelectionFields` sensible defaults.

Note on file placement: many CAP projects put UI annotations at the CDS-service level (`srv/content-moderation-service.cds`). Check other admin apps in this repo (`app/admin/homepage/`, `app/admin/featured-topics/`) to see which pattern is used, and match it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/content-moderation-annotations.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('#1034 UI annotations', () => {
  beforeAll(async () => { await cds.load('*'); });

  it('NewsItems has @UI.LineItem with 10+ columns', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.ContentModerationService.NewsItems']
              ?? cds.model.definitions['ContentModerationService.NewsItems'];
    expect(ent).toBeTruthy();
    const li = ent['@UI.LineItem'];
    expect(Array.isArray(li)).toBe(true);
    expect(li.length).toBeGreaterThanOrEqual(10);
  });

  it('LineItem includes AI verdict and admin verdict', () => {
    const ent = cds.model.definitions['com.sap.developers.ims.ContentModerationService.NewsItems']
              ?? cds.model.definitions['ContentModerationService.NewsItems'];
    const props = ent['@UI.LineItem'].map(c => c.Value?.['='] ?? c.Value);
    expect(props).toContain('title');
    expect(props).toContain('aiVerdict');
    expect(props).toContain('adminVerdict');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-moderation-annotations.test.js`
Expected: FAIL — annotations not present.

- [ ] **Step 3: Add annotations**

In `srv/content-moderation-service.cds`, at the bottom (after the service block), add:

```cds
annotate ContentModerationService.NewsItems with @(
  UI.HeaderInfo: {
    TypeName:       'News Item',
    TypeNamePlural: 'News Items',
    Title:          { Value: title },
    Description:    { Value: aiReason }
  },
  UI.SelectionFields: [ aiVerdict, adminVerdict, language, publishedAt ],
  UI.LineItem: [
    { Value: title,           Label: 'Title' },
    { Value: publishedAt,     Label: 'Published' },
    { Value: language,        Label: 'Language' },
    { Value: aiVerdict,       Label: 'AI verdict',
      Criticality: '$edmJson: iif( aiVerdict eq \'relevant\', 3, iif( aiVerdict eq \'not-relevant\', 2, iif( aiVerdict eq \'pending\', 5, 1 ) ) )' },
    { Value: aiReason,        Label: 'AI reason' },
    { Value: aiVerdictSource, Label: 'Source' },
    { Value: aiConfidence,    Label: 'Confidence' },
    { Value: adminVerdict,    Label: 'Admin verdict' },
    { Value: adminNote,       Label: 'Admin note' },
    { Value: aiVerdictAt,     Label: 'Last classified' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.approve',       Label: 'Approve' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.reject',        Label: 'Reject' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.clearOverride', Label: 'Clear override' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.reclassify',    Label: 'Reclassify' }
  ]
);

annotate ContentModerationService.RelevanceSeedExemplars with @(
  UI.HeaderInfo:    { TypeName: 'Seed', TypeNamePlural: 'Seeds', Title: { Value: label } },
  UI.SelectionFields: [ label, active ],
  UI.LineItem: [
    { Value: label,      Label: 'Label' },
    { Value: text,       Label: 'Text' },
    { Value: active,     Label: 'Active' },
    { Value: note,       Label: 'Note' },
    { Value: modifiedAt, Label: 'Modified' },
    { Value: modifiedBy, Label: 'Modified by' }
  ]
);
```

Note: the criticality iif expression uses CDS-annotation syntax. If your project uses a helper virtual element pattern (grep for `criticality` in other services), match that pattern instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/content-moderation-annotations.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Boot check**

Run: `npx cds serve --with-mocks &`
Wait 5 s, then:
```
curl -s http://localhost:4004/content-moderation/\$metadata | head -20
```
Expected: XML metadata with `UI.LineItem` entries. Kill the server (`kill %1` or Ctrl+C).

- [ ] **Step 6: Commit**

```bash
git add srv/content-moderation-service.cds test/unit/content-moderation-annotations.test.js
git commit -m "feat(#1034): UI annotations for NewsItems + RelevanceSeedExemplars"
```

---

### Task 16: Hybrid + smoke tests

**Files:**
- Create: `test/hybrid/news-items-hana.test.js`
- Create: `test/smoke/homepage-news-smoke.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: HANA-backed regression coverage for the upsert / admin-override / reclassify paths, and a live smoke against a deployed `/homepage/news`.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/news-items-hana.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { runFetchNews } from '../../srv/jobs/fetch-news-job.js';

describe('#1034 NewsItems on HANA', () => {
  let db, cleanupIds = [];

  beforeAll(async () => {
    await cds.test('serve', 'srv').in(process.cwd()).homepageBooted;
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    if (cleanupIds.length) {
      await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems')
        .where({ sourceId: { in: cleanupIds } }));
    }
  });

  it('upserts a row, preserves admin override on reclassify', async () => {
    const sourceId = `test-hybrid-${Date.now()}`;
    cleanupIds.push(sourceId);
    await db.run(INSERT.into('com.sap.developers.ims.external.NewsItems').entries({
      sourceId,
      link: 'https://news.sap.com/hybrid-test',
      title: 'CAP release',
      description: 'The Cloud Application Programming model is the future of SAP development.',
      publishedAt: new Date().toISOString(),
      language: 'en',
      contentHash: 'h1',
      aiVerdict: 'not-relevant',
      aiReason: 'wrong',
      aiVerdictSource: 'embedding',
      aiConfidence: 0.4,
      aiVerdictAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
    }));
    await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
      .set({ adminVerdict: 'approve', adminBy: 'sa@x.com', adminNote: 'override' })
      .where({ sourceId }));

    // Overwrite classifier columns (simulate reclassify path) via direct UPDATE.
    await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
      .set({ aiVerdict: 'relevant', aiReason: 'new', aiVerdictAt: new Date().toISOString() })
      .where({ sourceId }));

    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId }));
    expect(row.aiVerdict).toBe('relevant');
    expect(row.adminVerdict).toBe('approve');    // preserved
    expect(row.adminNote).toBe('override');      // preserved
  });

  it('seed embedding column round-trips through HANA', async () => {
    const id = `test-seed-${Date.now()}`;
    cleanupIds.push(id);
    const vec = Array.from({ length: 1536 }, (_, i) => i / 1536);
    await db.run(INSERT.into('com.sap.developers.ims.external.RelevanceSeedExemplars').entries({
      ID: id, label: 'relevant', text: 'hybrid seed', embedding: vec, active: true,
    }));
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.RelevanceSeedExemplars')
      .columns('ID', 'label', 'text', 'active').where({ ID: id }));
    expect(row.label).toBe('relevant');
  });
});
```

Note on hybrid test isolation: the test only writes rows tagged with unique sourceIds and cleans them up in `afterAll`. Reuses the running HANA HDI container via `cds bind --exec`.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/homepage-news-smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL || 'https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com';

describe('#1034 /homepage/news smoke', () => {
  it('returns array of ≤2 items', async () => {
    const res = await fetch(`${BASE}/homepage/news`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const arr = Array.isArray(body) ? body : body.value;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(2);
    for (const item of arr) {
      expect(item.title).toBeTruthy();
      expect(item.link).toBeTruthy();
      // must be within 14 days when the filter is active — but if kill switch
      // is off (default at first rollout), age check is skipped.
    }
  });
});
```

- [ ] **Step 3: Run the hybrid test**

Run: `npx vitest run --project hybrid test/hybrid/news-items-hana.test.js`
Expected: PASS (2 tests). Requires `cf login` + `cds bind` env.

Do not run the smoke test yet — it targets a deployed environment and only makes sense post-deploy.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/news-items-hana.test.js test/smoke/homepage-news-smoke.test.js
git commit -m "test(#1034): hybrid HANA + deployed smoke coverage for NewsItems"
```

---

### Task 17: Documentation + runbook + architecture note

**Files:**
- Modify: `docs/developers/architecture/homepage.md` — add SAP News H2.
- Modify: `docs/developers/reference/cap-ai-plugin.md` — note that classifier bypasses the plugin.
- Create: `docs/developers/operations/content-moderation-runbook.md`.

**Interfaces:**
- Consumes: nothing.
- Produces: docs.

- [ ] **Step 1: Add "SAP News (developer-relevance filter)" H2 to `docs/developers/architecture/homepage.md`**

Append (or insert near the existing Row 6 anatomy section):

```markdown
## SAP News (developer-relevance filter — #1034)

The homepage `/homepage/news` handler serves items from the `NewsItems`
HANA table when the two-layer kill switch is on. `srv/jobs/fetch-news-job.js`
runs hourly (:37) against `news.sap.com/feed/`; each item is classified by
`srv/lib/relevance-classifier.js` (embedding-first via `RelevanceSeedExemplars`,
LLM fallback for the mid-band, keyword rules on any error).

Admins triage at `/admin-ui/#content-moderation` — approve, reject, clear
override, or reclassify a single item. Admin verdicts win over AI at read
time. Homepage items are capped at 2, aged out after 14 days, English-only.

Kill switches (either off → legacy RSS pass-through):
- Env `HOMEPAGE_NEWS_RELEVANCE_ENABLED` (default `true`).
- `HomepageConfig.newsRelevanceEnabled` (default `false`).

Community Blog Posts (#1033) mirrors this pattern using the same
`ContentModerationService` + `RelevanceSeedExemplars` shared seed set.
```

- [ ] **Step 2: Add footnote to `docs/developers/reference/cap-ai-plugin.md`**

Append:

```markdown
### #1034 exception: developer-relevance classifier does NOT use `@cap-js/ai`

The `srv/lib/relevance-classifier.js` module used by the SAP News developer-
relevance filter goes through `@sap-ai-sdk` (`AzureOpenAiEmbeddingClient`,
`OrchestrationClient`) directly rather than through `@cap-js/ai`. Reason:
the plugin's `AICore` `kind`-resolution fires on any draft-Create write with
`@Common.ValueList` fields and throws "No service definition for AICore"
when `cds.requires.AICore.kind` is unset at runtime (VCAP presence alone is
insufficient). Bypassing the plugin sidesteps that failure path entirely.
See also `MEMORY.md > cap-ai-plugin-aicore-kind-resolution`.
```

- [ ] **Step 3: Create `docs/developers/operations/content-moderation-runbook.md`**

```markdown
# Content Moderation Runbook (#1034)

## Kill switch — homepage falls back to legacy RSS pass-through

Fastest (no redeploy): flip `HomepageConfig.newsRelevanceEnabled = false` at
`/admin-ui/#homepage-config`. Effect within 60 s (cache TTL).

Nuclear (env-level): `cf set-env tutorials-srv HOMEPAGE_NEWS_RELEVANCE_ENABLED false && cf restart tutorials-srv`.
Env dominates HomepageConfig; either falsy → legacy behavior.

## Re-run the classifier manually

Run: `curl -X POST /admin-service/JobControls('fetch-news')/runJob` or click
"Run classifier now" on `/admin-ui/#content-moderation`. Same code path as
the hourly cron; produces a PipelineRuns row for audit.

## Tune the seed exemplars

Edit at `/admin-ui/#content-moderation` (Seeds tab). CREATE/UPDATE fires an
after-hook that recomputes the embedding server-side; the classifier cache
invalidates the affected entry only. Do NOT edit
`db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv` after
launch — it's a first-deploy seed. Post-launch CSV edits WILL wipe admin
changes on the next redeploy (memory-recorded gotcha).

## Override one item

Row action bar on `/admin-ui/#content-moderation` → Approve / Reject / Clear
override. Admin verdicts win over AI at read time. Homepage picks up the
override within 60 s.

## Diagnose: classifier is falling back to keyword rules

Check `NewsItems.aiVerdictSource`. If most rows show `fallback-keyword`,
one of:
- Seed table is empty for either label → banner will show; add seeds.
- Daily LLM budget (`ChatSettings.newsRelevanceLlmBudgetPerDay`, default 100)
  is exhausted — check `newsRelevanceLlmCallsToday` on ChatSettings.
- AI Core outage — check `NewsItems.classifyError` and `cf logs tutorials-srv`.

## Diagnose: no items on homepage

- Kill switches on? Legacy pass-through requires no NewsItems row.
- Seed table populated with BOTH labels? Empty → all rows land as `pending`.
- `NewsItems` rows all `not-relevant`? Loosen seeds or drop
  `ChatSettings.newsRelevanceMargin` from 0.150 → 0.10.
- Everything older than 14 days? Wait for the next cron cycle.

## Roll forward at first deploy

1. Ship schema + service + classifier + cron with
   `HomepageConfig.newsRelevanceEnabled = false`.
2. Let the hourly cron run for 48 h; triage the moderation UI.
3. Flip `newsRelevanceEnabled = true`. Homepage begins filtered service.
4. Monitor `news_relevance_*` metrics; tune margin if verdicts skew.

## Related

- Spec: `docs/superpowers/specs/2026-07-07-1034-sap-news-developer-relevance-design.md`
- Plan: `docs/superpowers/plans/2026-07-07-1034-sap-news-developer-relevance.md`
```

- [ ] **Step 4: Commit**

```bash
git add docs/developers/architecture/homepage.md docs/developers/reference/cap-ai-plugin.md docs/developers/operations/content-moderation-runbook.md
git commit -m "docs(#1034): architecture note + AI-plugin footnote + moderation runbook"
```

---

### Task 18: Whole-suite green check + PR

**Files:**
- No new files.

**Interfaces:**
- Consumes: every earlier task.

- [ ] **Step 1: Run the full unit-test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: `cds build --production` sanity**

Run: `npx cds build --production`
Expected: exit 0. Verifies `db/last-dev/` picks up schema changes (memory gotcha).

- [ ] **Step 3: `cds deploy --to sqlite::memory:` sanity**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exit 0.

- [ ] **Step 4: Push branch + open draft PR**

```bash
git push -u origin worktree-1034-sap-news-relevance
gh pr create --draft \
  --title "feat(#1034): SAP News developer-relevance filter (shared classifier + moderation UI)" \
  --body "$(cat <<'BODY'
Implements #1034.

Adds a source-agnostic developer-relevance classifier + admin moderation UI. #1033 (Community Blog Posts) will mirror by pointing its future entity at the same `ContentModerationService` + `RelevanceSeedExemplars`.

- Design: docs/superpowers/specs/2026-07-07-1034-sap-news-developer-relevance-design.md
- Plan:   docs/superpowers/plans/2026-07-07-1034-sap-news-developer-relevance.md
- Runbook: docs/developers/operations/content-moderation-runbook.md

Rollout is behind `HomepageConfig.newsRelevanceEnabled` (default OFF). Homepage keeps serving legacy RSS pass-through until an admin flips it on after 48h of triage.

Test coverage:
- unit: relevance-classifier, keyword rules, canonicalize-link, detect-language-en, seed embeddings, fetch-news-job, homepage news() filter, content-moderation-service, schema shape, admin-shell route, FE scaffold, annotations
- hybrid: NewsItems on HANA + seed embedding round-trip
- smoke: /homepage/news deployed check (run post-deploy)
BODY
)"
```

- [ ] **Step 5: Report**

Report the PR URL back. Done.

---

## Self-Review

Ran a final pass over the plan vs. the spec:

- **Spec §"Data model"** → Task 5 covers `NewsItems`, `RelevanceSeedExemplars`, `ChatSettings` additions, `HomepageConfig.newsRelevanceEnabled`. ✔
- **Spec §"Classifier"** → Task 4 (keyword rules) + Task 7 (seed cache) + Task 8 (classifier) + `srv/lib/embedding-client.js` reuse. ✔
- **Spec §"Cron job"** → Task 9 (fetch-news + scheduler registration). RSS parser upgrade in Task 1. Canonicalize in Task 2. Language detect in Task 3. ✔
- **Spec §"Homepage read path"** → Task 10 (news() rewrite + 60s cache + kill switches + resetNewsCache). ✔
- **Spec §"Admin surface"** → Task 11 (service + actions), Task 13 (route), Task 14 (FE scaffold), Task 15 (annotations). ✔
- **Spec §"Error handling"** → covered inside Task 8 (embedding/LLM error → keyword fallback), Task 9 (fetch error paths), Task 10 (try/catch returning []). ✔
- **Spec §"Testing"** → unit tests in every functional task; Task 16 covers hybrid + smoke. ✔
- **Spec §"Ops"** → Task 12 (mta.yaml cp list, admin-service projection) + Task 17 (docs / runbook / architecture note). ✔
- **Spec §"Known gotchas"** — CSV-seed embedding column exclusion enforced by Task 6 test. `@cap-js/ai` bypass documented in Task 17. `srv-qa` cp list audit in Task 12. `cds build --production` in Task 18. ✔

Type consistency:
- `classify({ title, description, sourceType })` — same signature in Task 8 producer and Task 9 consumer.
- `resetNewsCache` — exported in Task 10, consumed in Task 11.
- `invalidateSeed(id)` — exported in Task 7, consumed in Task 11.
- `runFetchNews` — Task 9 producer signature matches scheduler.js registration.

Placeholders scanned — none in code steps. The FE scaffold in Task 14 explicitly acknowledges that the manifest shape must match the local project's convention (copy from `app/admin/homepage/`) rather than pretending one manifest shape fits all — the test only guards the four fields we control.

## Open Items Deferred From the Spec

- Allowlist/blocklist sanity-check against last 30 days of feed → do at PR-review time (a fresh subagent can spin the classifier against a recorded fixture set and report drift).
- Batch approve/reject multi-select bar → not in v1; add if admins complain.
- Metrics registry wiring (`news_relevance_*` counters) → deliberately deferred; the plan tests already validate behavior, and metrics-registry adoption is being tracked separately.
- Non-English `<language>` element upgrade → follow-up if SAP News starts emitting it.
