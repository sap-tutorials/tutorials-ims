# Cluster-Level Q&A in Joule (#1173) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `describeCommunity` Joule tool that answers "what's the AI cluster?" / "show me everything around RAP" by resolving a free-text topic to a labeled Louvain community and returning its label, rationale, and member tutorials.

**Architecture:** LLM-side matching — a new flag-gated prompt layer injects the (~18) labeled clusters into the learner's system prompt; the model picks the best-matching label and passes it to `describeCommunity`, which does deterministic case-insensitive exact-match → community fingerprint → live member tutorials. Member resolution is extracted into a shared helper reused by the existing `findCommunityPeers` tool. Rendering reuses the existing `community-peers-cards` SSE frame verbatim.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), Vitest (in-memory SQLite for unit, real HANA via `--project hybrid`), SAP AI SDK orchestration (already wired), server-sent events.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-15-1173-cluster-qa-joule-design.md` — the authority; this plan implements it.
- **No schema/migration change.** Reuse `KgCommunity`, `KgCommunityLabel`, `Tutorials`. Reuse the existing `communityPeersEnabled` flag on `ChatSettings`. No new `ChatSettings` column, no `.hdbmigrationtable` bump, no CSV.
- **No `hugo/static/js/joule.js` change** — reuse `community-peers-cards` frame + `renderCommunityPeersCards(items, label)`.
- **No `.deploy/mta.yaml` change** — verified 2026-07-15: srv-qa is content-only; it does not copy `chat-orchestrator.js`, `chat-context.js`, or any `joule-tool-*.js`. The chat path never boots there.
- **Slug hygiene:** every slug join `.toLowerCase()` (slugs are lowercase canonical). Tutorials with `status` ACTIVE **or NULL** are live; NULL is treated as ACTIVE. `IN (...)` does not match NULL — fetch `status` alongside and filter in JS.
- **Fail-open everywhere:** every handler/layer error path returns a safe empty shape and never throws into the SSE stream (never a 500). Log via `cds.log(...).warn(...)`.
- **Gating:** all new behavior is dark unless `settings.communityPeersEnabled` is true. Flag OFF ⇒ `buildSystemPrompt` output byte-identical to today; tool not registered.
- **Test runner:** unit = `npx vitest run <file>`; hybrid = `npx vitest run --project hybrid <file>` (bare `vitest <file>` silently skips hybrid setup). Do NOT add a setupFile that imports `@sap/cds`.
- **ESM:** project uses ES modules (`import`/`export`), Node 20+, native `fetch`. Match surrounding style.

---

## File Structure

**New files:**
- `srv/lib/kg/community-members.js` — `resolveCommunityMembers({db, fingerprint, limit, excludeSlug})` → `[{slug,title,url}]`. The single home for fingerprint → live-tutorial resolution.
- `srv/lib/kg/community-label-match.js` — pure `matchLabel({topic, matchedLabel, labels})` → `{fingerprint?, label?, reason?, candidates?}`. Deterministic exact-ci + token-overlap fallback + ambiguity margin. No DB, no I/O.
- `srv/lib/kg/joule-tool-describe-community.js` — `DESCRIBE_COMMUNITY_TOOL` descriptor + `describeCommunityHandler({db, args})`.

**Modified files:**
- `srv/lib/kg/joule-tool-community-peers.js` — refactor steps 2–3 to delegate to `resolveCommunityMembers` (behavior-preserving).
- `srv/lib/chat-context.js` — add `communityCatalogLayer(settings)`; `buildSystemPrompt(pageContext, user, settings=null)` gains 3rd arg + appends the layer on the learner path.
- `srv/server.js` — pass `settings` (already in scope) into `buildSystemPrompt`.
- `srv/lib/chat-orchestrator.js` — import tool, register under `communityPeersEnabled`, add dispatch case, add SSE branch, add to exports, add a `buildSystemPromptLines` guidance line (with clarifying comment).

**Test files:**
- `test/unit/kg/community-label-match.test.js` — new
- `test/unit/kg/community-members.test.js` — new
- `test/unit/kg/joule-tool-describe-community.test.js` — new
- `test/unit/kg/community-catalog-layer.test.js` — new
- `test/chat-orchestrator-community-peers.test.js` — extend (registry gating for `describeCommunity`)
- `test/hybrid/kg-community-peers.test.js` — extend (hybrid `describeCommunity` round-trip)
- `test/unit/kg/joule-tool-community-peers.test.js` — must stay green (regression guard on the refactor)

---

## Task 1: Extract `resolveCommunityMembers` shared helper

Extract the fingerprint → live-tutorial logic from `findCommunityPeers` into a reusable module, then make `findCommunityPeers` delegate to it. Behavior-preserving — the existing `joule-tool-community-peers` unit + hybrid tests are the regression guard.

**Files:**
- Create: `srv/lib/kg/community-members.js`
- Create: `test/unit/kg/community-members.test.js`
- Modify: `srv/lib/kg/joule-tool-community-peers.js`

**Interfaces:**
- Produces: `resolveCommunityMembers({ db, fingerprint, limit, excludeSlug }) → Promise<Array<{slug:string, title:string, url:string}>>`. Returns tutorials in `KgCommunity` sharing `fingerprint` (vertexType `tutorial`), resolved against live `Tutorials` (status ACTIVE or NULL), ordered by title, excluding `excludeSlug` (lowercased) when provided, capped at `limit`. Fail-open: returns `[]` on any error (caller decides the reason code).

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg/community-members.test.js`:

```javascript
// test/unit/kg/community-members.test.js
// Unit tests for resolveCommunityMembers (#1173). In-memory SQLite so
// cds.entities(NS) resolves against a real loaded model (same approach as
// joule-tool-community-peers.test.js).
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { resolveCommunityMembers } from '../../../srv/lib/kg/community-members.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP = 'c'.repeat(64);

const T = [
  { ID: 'CM26-0000-0000-0000-000000000001', slug: 'cm-self',   title: 'Self',   status: 'ACTIVE' },
  { ID: 'CM26-0000-0000-0000-000000000002', slug: 'cm-alpha',  title: 'Alpha',  status: 'ACTIVE' },
  { ID: 'CM26-0000-0000-0000-000000000003', slug: 'cm-bravo',  title: 'Bravo',  status: null },
  { ID: 'CM26-0000-0000-0000-000000000004', slug: 'cm-dead',   title: 'Dead',   status: 'INACTIVE' },
];
const KC = T.map((t) => ({
  communityId: 7001, vertexKey: `tutorial:${t.slug}`, vertexType: 'tutorial',
  slug: t.slug, detectedAt: new Date().toISOString(), communityFingerprint: FP,
}));

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunity, Tutorials } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunity).where({ communityId: 7001 }));
  await db.run(DELETE.from(Tutorials).where({ ID: { in: T.map((t) => t.ID) } }));
  await db.run(INSERT.into(Tutorials).entries(T));
  await db.run(INSERT.into(KgCommunity).entries(KC));
});

describe('resolveCommunityMembers', () => {
  it('returns live members ordered by title, excludes INACTIVE, keeps NULL-status', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 10 });
    const slugs = out.map((m) => m.slug);
    expect(slugs).toEqual(['cm-alpha', 'cm-bravo', 'cm-self']); // title ASC: Alpha, Bravo, Self
    expect(slugs).not.toContain('cm-dead');
    expect(out[0].url).toMatch(/\/tutorials\/cm-alpha\.html$/);
  });

  it('excludes the excludeSlug (lowercased)', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 10, excludeSlug: 'CM-SELF' });
    expect(out.map((m) => m.slug)).not.toContain('cm-self');
  });

  it('caps at limit', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 1 });
    expect(out).toHaveLength(1);
  });

  it('fails open to [] on db error', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); } };
    const out = await resolveCommunityMembers({ db: brokenDb, fingerprint: FP, limit: 5 });
    expect(out).toEqual([]);
  });

  it('returns [] for an unknown fingerprint', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: 'z'.repeat(64), limit: 5 });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-members.test.js`
Expected: FAIL — `resolveCommunityMembers` is not exported / module not found.

- [ ] **Step 3: Write the helper**

Create `srv/lib/kg/community-members.js`:

```javascript
// srv/lib/kg/community-members.js
// Shared member-resolution for KG-community Joule tools (#1173).
// Given a community fingerprint, returns its tutorial members resolved to live
// Tutorials (status ACTIVE or NULL — NULL treated as ACTIVE per
// knowledge-graph-service.js:477-486 and co-completion.js:18), ordered by
// title, optionally excluding one anchor slug, capped at `limit`.
// Fail-open: any error returns [] so callers never 500 into the chat stream.
import cds from '@sap/cds';

const LOG = cds.log('kg-community-members');
const NS = 'com.sap.developers.ims';
const HARD_SIBLING_CAP = 50; // communities are small; defensive bound on the .in([]) set

/**
 * @param {object} opts
 * @param {object} opts.db          - CDS db handle
 * @param {string} opts.fingerprint - communityFingerprint (String(64))
 * @param {number} opts.limit       - max members to return
 * @param {string} [opts.excludeSlug] - anchor slug to exclude (lowercased internally)
 * @returns {Promise<Array<{slug:string, title:string, url:string}>>}
 */
export async function resolveCommunityMembers({ db, fingerprint, limit, excludeSlug }) {
  if (!fingerprint) return [];
  const exclude = typeof excludeSlug === 'string' ? excludeSlug.toLowerCase() : null;
  const cap = Math.max(1, Number(limit) || 1);
  try {
    const { KgCommunity, Tutorials } = cds.entities(NS);

    const memberRows = await db.run(
      SELECT.from(KgCommunity).columns('slug')
        .where({ communityFingerprint: fingerprint, vertexType: 'tutorial' })
        .limit(HARD_SIBLING_CAP)
    );
    const slugs = [...new Set(memberRows.map((r) => r.slug?.toLowerCase()).filter(Boolean))]
      .filter((s) => s !== exclude);
    if (slugs.length === 0) return [];

    // Fetch status alongside slug/title and filter in JS — SQL IN(...) does not
    // match NULL, so we cannot filter status in the WHERE.
    const tutRows = await db.run(
      SELECT.from(Tutorials).columns('slug', 'title', 'status')
        .where({ slug: { in: slugs } })
        .orderBy('title asc')
    );
    return tutRows
      .filter((t) => !t.status || t.status === 'ACTIVE')
      .slice(0, cap)
      .map((t) => ({
        slug: t.slug,
        title: t.title,
        url: `https://developers.sap.com/tutorials/${t.slug}.html`,
      }));
  } catch (err) {
    LOG.warn('resolveCommunityMembers failed:', err.message);
    return [];
  }
}

export default { resolveCommunityMembers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-members.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor `findCommunityPeers` to delegate**

In `srv/lib/kg/joule-tool-community-peers.js`, add the import at the top (after the `import cds` line):

```javascript
import { resolveCommunityMembers } from './community-members.js';
```

Replace steps 2 & 3 of `findCommunityPeersHandler` (the sibling-fetch + Tutorials-resolve blocks, from `// 2. Sibling tutorial slugs...` through the `if (peers.length === 0) return ...` line) with:

```javascript
    // 2-3. Resolve sibling tutorials sharing the fingerprint (exclude self),
    // via the shared helper. Live status (ACTIVE/NULL), ordered by title, capped.
    const peers = await resolveCommunityMembers({ db, fingerprint: fp, limit, excludeSlug: slug });
    if (peers.length === 0) return { peers: [], reason: 'no-peers' };
```

Remove the now-unused `HARD_SIBLING_CAP` constant from this file (it lives in `community-members.js` now). Leave `SLUG_RE`, `DEFAULT_LIMIT`, `MAX_LIMIT`, the descriptor, the fingerprint resolve (step 1), and the label attach (step 4) unchanged.

> Note: the pre-refactor code returned reason `'singleton'` / `'no-published-peers'` for the empty case; both collapse to `'no-peers'` here. These reason strings are internal (the LLM narrates from `peers`), so the existing unit test — which only asserts `peers` contents on the populated path and never asserts these two reason strings — stays green. Verify in Step 6.

- [ ] **Step 6: Run the existing community-peers tests to confirm no regression**

Run: `npx vitest run test/unit/kg/joule-tool-community-peers.test.js`
Expected: PASS (all existing tests). If any test asserts `reason: 'singleton'` or `'no-published-peers'`, update that assertion to `'no-peers'` — but per the current file (read it) none do.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/kg/community-members.js test/unit/kg/community-members.test.js srv/lib/kg/joule-tool-community-peers.js
git commit -m "refactor(#1173): extract resolveCommunityMembers shared helper"
```

---

## Task 2: Pure label matcher `matchLabel`

Deterministic topic→label resolution: exact case-insensitive match on the model-supplied label, token-overlap fallback on the raw topic, ambiguity detection. No DB — pure function, fully unit-testable (satisfies the "unit coverage for topic→community resolution" acceptance criterion).

**Files:**
- Create: `srv/lib/kg/community-label-match.js`
- Create: `test/unit/kg/community-label-match.test.js`

**Interfaces:**
- Produces: `matchLabel({ topic, matchedLabel, labels }) → { fingerprint?, label?, rationale?, reason?, candidates? }` where `labels` is `Array<{communityFingerprint, label, rationale}>`. Outcomes:
  - exact-ci hit on `matchedLabel` → `{ fingerprint, label, rationale }`
  - else token-overlap on `topic`: single clear winner → `{ fingerprint, label, rationale }`
  - top-2 within `AMBIGUITY_MARGIN` and both non-trivial → `{ reason:'ambiguous', candidates:[{label},{label}] }`
  - nothing scores → `{ reason:'no-match' }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg/community-label-match.test.js`:

```javascript
// test/unit/kg/community-label-match.test.js
// Pure-function tests for matchLabel (#1173). No DB.
import { describe, it, expect } from 'vitest';
import { matchLabel } from '../../../srv/lib/kg/community-label-match.js';

const LABELS = [
  { communityFingerprint: 'fp-ai',  label: 'SAP AI & Machine Learning', rationale: 'ai stuff' },
  { communityFingerprint: 'fp-rap', label: 'SAP RAP & Fiori Elements',  rationale: 'rap stuff' },
  { communityFingerprint: 'fp-cap', label: 'CAP & Node.js Services',    rationale: 'cap stuff' },
];

describe('matchLabel', () => {
  it('exact case-insensitive match on matchedLabel wins', () => {
    const out = matchLabel({ topic: 'whatever', matchedLabel: 'sap rap & fiori elements', labels: LABELS });
    expect(out.fingerprint).toBe('fp-rap');
    expect(out.label).toBe('SAP RAP & Fiori Elements');
    expect(out.rationale).toBe('rap stuff');
  });

  it('falls back to token overlap on topic when matchedLabel absent', () => {
    const out = matchLabel({ topic: 'show me everything around RAP and fiori', labels: LABELS });
    expect(out.fingerprint).toBe('fp-rap');
  });

  it('falls back to topic when matchedLabel does not exact-match', () => {
    // model hallucinated a label not in the set → ignore it, use topic tokens
    const out = matchLabel({ topic: 'machine learning', matchedLabel: 'Nonexistent Cluster', labels: LABELS });
    expect(out.fingerprint).toBe('fp-ai');
  });

  it('returns ambiguous when top-2 are within margin', () => {
    // "sap" alone overlaps both AI and RAP labels equally (1 token each)
    const out = matchLabel({ topic: 'sap', labels: LABELS });
    expect(out.reason).toBe('ambiguous');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.map((c) => c.label).sort()).toEqual(
      ['SAP AI & Machine Learning', 'SAP RAP & Fiori Elements'].sort()
    );
  });

  it('returns no-match when nothing overlaps', () => {
    const out = matchLabel({ topic: 'quantum knitting', labels: LABELS });
    expect(out.reason).toBe('no-match');
  });

  it('returns no-match on empty labels', () => {
    const out = matchLabel({ topic: 'ai', matchedLabel: 'SAP AI & Machine Learning', labels: [] });
    expect(out.reason).toBe('no-match');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-label-match.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the matcher**

Create `srv/lib/kg/community-label-match.js`:

```javascript
// srv/lib/kg/community-label-match.js
// Pure, deterministic topic → community-label resolution (#1173).
// Primary path: the LLM picks a label from the injected catalog and passes it
// as matchedLabel → we exact-match (case-insensitive). Fallback: token-overlap
// scoring on the learner's raw topic against label+rationale, used when the
// model forgot to echo the label or the catalog layer was omitted.
// No DB, no I/O — unit-testable in isolation.

const AMBIGUITY_MARGIN = 0.0; // top-2 tie (equal score) → ambiguous; widen if needed
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'sap', 'with']);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

/**
 * @param {object} inp
 * @param {string} inp.topic          - learner's raw phrasing
 * @param {string} [inp.matchedLabel] - label the LLM picked from the catalog
 * @param {Array<{communityFingerprint:string,label:string,rationale?:string}>} inp.labels
 * @returns {{fingerprint?:string,label?:string,rationale?:string,reason?:string,candidates?:Array<{label:string}>}}
 */
export function matchLabel({ topic, matchedLabel, labels }) {
  const rows = Array.isArray(labels) ? labels.filter((r) => r && r.label && r.communityFingerprint) : [];
  if (rows.length === 0) return { reason: 'no-match' };

  // 1. Exact case-insensitive match on the model-supplied label.
  if (typeof matchedLabel === 'string' && matchedLabel.trim()) {
    const want = matchedLabel.trim().toLowerCase();
    const hit = rows.find((r) => r.label.toLowerCase() === want);
    if (hit) return { fingerprint: hit.communityFingerprint, label: hit.label, rationale: hit.rationale };
  }

  // 2. Token-overlap fallback on the raw topic vs each label (+ rationale).
  const topicTokens = new Set(tokenize(topic));
  if (topicTokens.size === 0) return { reason: 'no-match' };

  const scored = rows
    .map((r) => {
      const labelTokens = new Set([...tokenize(r.label), ...tokenize(r.rationale)]);
      let overlap = 0;
      for (const t of topicTokens) if (labelTokens.has(t)) overlap++;
      return { row: r, score: overlap };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { reason: 'no-match' };
  if (scored.length === 1 || scored[0].score - scored[1].score > AMBIGUITY_MARGIN) {
    const r = scored[0].row;
    return { fingerprint: r.communityFingerprint, label: r.label, rationale: r.rationale };
  }
  // Tie within margin → ambiguous.
  return {
    reason: 'ambiguous',
    candidates: [{ label: scored[0].row.label }, { label: scored[1].row.label }],
  };
}

export default { matchLabel };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-label-match.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/community-label-match.js test/unit/kg/community-label-match.test.js
git commit -m "feat(#1173): add pure matchLabel topic→community resolver"
```

---

## Task 3: `describeCommunity` tool descriptor + handler

Wire the matcher and member helper into a Joule tool. Loads labeled clusters, resolves the topic, fetches members, returns `{label, rationale, members, reason?}`.

**Files:**
- Create: `srv/lib/kg/joule-tool-describe-community.js`
- Create: `test/unit/kg/joule-tool-describe-community.test.js`

**Interfaces:**
- Consumes: `matchLabel` (Task 2), `resolveCommunityMembers` (Task 1).
- Produces:
  - `DESCRIBE_COMMUNITY_TOOL` — OpenAI-style function descriptor, `function.name === 'describeCommunity'`, required `['topic']`.
  - `describeCommunityHandler({ db, args }) → Promise<{label?:string, rationale?:string, members:Array<{slug,title,url}>, reason?:string}>`. `args = { topic, matched_label?, limit? }`. Fail-open: any error → `{ members: [], reason: 'error' }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg/joule-tool-describe-community.test.js`:

```javascript
// test/unit/kg/joule-tool-describe-community.test.js
// Unit tests for describeCommunity Joule tool (#1173). In-memory SQLite so
// cds.entities(NS) resolves (same approach as joule-tool-community-peers.test.js).
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler } from '../../../srv/lib/kg/joule-tool-describe-community.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP_AI = 'd'.repeat(64);
const FP_EMPTY = 'e'.repeat(64); // labeled but no live members

const T = [
  { ID: 'DC26-0000-0000-0000-000000000001', slug: 'dc-ml-basics', title: 'ML Basics',   status: 'ACTIVE' },
  { ID: 'DC26-0000-0000-0000-000000000002', slug: 'dc-ml-adv',    title: 'ML Advanced',  status: null },
  { ID: 'DC26-0000-0000-0000-000000000003', slug: 'dc-ml-dead',   title: 'ML Retired',   status: 'INACTIVE' },
];
const KC = [
  ...T.map((t) => ({ communityId: 8001, vertexKey: `tutorial:${t.slug}`, vertexType: 'tutorial', slug: t.slug, detectedAt: new Date().toISOString(), communityFingerprint: FP_AI })),
  // FP_EMPTY member points at a slug with no matching (live) Tutorials row
  { communityId: 8002, vertexKey: 'tutorial:dc-ghost', vertexType: 'tutorial', slug: 'dc-ghost', detectedAt: new Date().toISOString(), communityFingerprint: FP_EMPTY },
];
const LABELS = [
  { communityFingerprint: FP_AI,    label: 'SAP AI & Machine Learning', rationale: 'ai and ml', memberSlugsHash: '0'.repeat(64) },
  { communityFingerprint: FP_EMPTY, label: 'Empty Cluster',             rationale: 'nothing live', memberSlugsHash: '1'.repeat(64) },
];

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunity).where({ communityId: { in: [8001, 8002] } }));
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: { in: [FP_AI, FP_EMPTY] } }));
  await db.run(DELETE.from(Tutorials).where({ ID: { in: T.map((t) => t.ID) } }));
  await db.run(INSERT.into(Tutorials).entries(T));
  await db.run(INSERT.into(KgCommunity).entries(KC));
  await db.run(INSERT.into(KgCommunityLabel).entries(LABELS));
});

describe('DESCRIBE_COMMUNITY_TOOL descriptor', () => {
  it('is named describeCommunity and requires topic', () => {
    expect(DESCRIBE_COMMUNITY_TOOL.function.name).toBe('describeCommunity');
    expect(DESCRIBE_COMMUNITY_TOOL.function.parameters.required).toContain('topic');
  });
});

describe('describeCommunityHandler', () => {
  it('resolves via matched_label exact match and returns live members', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'the AI area', matched_label: 'SAP AI & Machine Learning' } });
    expect(out.label).toBe('SAP AI & Machine Learning');
    expect(out.rationale).toBe('ai and ml');
    const slugs = out.members.map((m) => m.slug);
    expect(slugs).toContain('dc-ml-basics');
    expect(slugs).toContain('dc-ml-adv');   // NULL status = live
    expect(slugs).not.toContain('dc-ml-dead'); // INACTIVE excluded
  });

  it('resolves via topic token overlap when matched_label absent', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'machine learning' } });
    expect(out.label).toBe('SAP AI & Machine Learning');
    expect(out.members.length).toBeGreaterThan(0);
  });

  it('returns no-match for an unresolvable topic', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'quantum knitting' } });
    expect(out.reason).toBe('no-match');
    expect(out.members).toEqual([]);
  });

  it('returns no-live-members when the label resolves but no tutorials are live', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'empty', matched_label: 'Empty Cluster' } });
    expect(out.label).toBe('Empty Cluster');
    expect(out.members).toEqual([]);
    expect(out.reason).toBe('no-live-members');
  });

  it('caps members to limit', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'ai', matched_label: 'SAP AI & Machine Learning', limit: 1 } });
    expect(out.members).toHaveLength(1);
  });

  it('fails open to empty members on db error', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); } };
    const out = await describeCommunityHandler({ db: brokenDb, args: { topic: 'ai' } });
    expect(out.members).toEqual([]);
    expect(out.reason).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/joule-tool-describe-community.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `srv/lib/kg/joule-tool-describe-community.js`:

```javascript
// srv/lib/kg/joule-tool-describe-community.js
// Joule chat tool: describeCommunity (#1173). Answers questions ABOUT a topic
// cluster as a whole ("what's the AI cluster?", "show me everything around
// RAP") by resolving a free-text topic to a labeled Louvain community and
// returning its label, rationale, and member tutorials.
//
// Matching is LLM-side: the learner prompt injects the labeled-cluster catalog
// (see communityCatalogLayer in chat-context.js); the model picks the best
// label and passes it as matched_label. The server exact-matches that against
// KgCommunityLabel (deterministic + testable) with a token-overlap fallback on
// the raw topic. Fail-open: every error path returns empty members.
import cds from '@sap/cds';
import { matchLabel } from './community-label-match.js';
import { resolveCommunityMembers } from './community-members.js';

const LOG = cds.log('kg-describe-community');
const NS = 'com.sap.developers.ims';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const MAX_LABELS = 200; // bound the catalog read; ~18 today

export const DESCRIBE_COMMUNITY_TOOL = {
  type: 'function',
  function: {
    name: 'describeCommunity',
    description: [
      'Answer a question ABOUT a topic cluster/area as a whole (e.g. "what\'s the',
      'AI cluster", "show me everything around RAP"). Returns the cluster label, a',
      'one-line rationale, and its member tutorials. Pass the cluster label that',
      'best matches the learner\'s topic as matched_label — prefer an exact label',
      'from the known-clusters list in your context. Use when the learner names a',
      'TOPIC AREA rather than a specific tutorial.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: "The learner's topic phrasing, e.g. \"the AI cluster\"." },
        matched_label: { type: 'string', description: 'The exact cluster label you picked from the known-clusters list, if any.' },
        limit: { type: 'integer', description: 'Max member tutorials to return. 1-12, default 8.' },
      },
      required: ['topic'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { topic, matched_label?, limit? }
 * @returns {Promise<{label?:string, rationale?:string, members:Array<{slug,title,url}>, reason?:string, candidates?:Array<{label:string}>}>}
 */
export async function describeCommunityHandler({ db, args }) {
  const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
  const matchedLabel = typeof args?.matched_label === 'string' ? args.matched_label.trim() : '';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args?.limit) || DEFAULT_LIMIT));
  if (!topic && !matchedLabel) return { members: [], reason: 'no-match' };

  try {
    const { KgCommunityLabel } = cds.entities(NS);
    const labels = await db.run(
      SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label', 'rationale').limit(MAX_LABELS)
    );

    const m = matchLabel({ topic, matchedLabel, labels });
    if (m.reason) return { members: [], reason: m.reason, ...(m.candidates ? { candidates: m.candidates } : {}) };

    const members = await resolveCommunityMembers({ db, fingerprint: m.fingerprint, limit });
    const out = { label: m.label, members };
    if (m.rationale) out.rationale = m.rationale;
    if (members.length === 0) out.reason = 'no-live-members';
    return out;
  } catch (err) {
    LOG.warn('describeCommunity dispatch failed:', err.message);
    return { members: [], reason: 'error' };
  }
}

export default { DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/joule-tool-describe-community.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/joule-tool-describe-community.js test/unit/kg/joule-tool-describe-community.test.js
git commit -m "feat(#1173): add describeCommunity Joule tool"
```

---

## Task 4: `communityCatalogLayer` prompt layer + thread `settings`

Inject the labeled-cluster catalog into the learner system prompt when the flag is on. This is the runtime path that makes LLM-side matching work (the existing `buildSystemPromptLines` is dead at runtime — see spec).

**Files:**
- Modify: `srv/lib/chat-context.js`
- Modify: `srv/server.js:1263`
- Create: `test/unit/kg/community-catalog-layer.test.js`

**Interfaces:**
- Produces: `communityCatalogLayer(settings) → Promise<string>` (exported). `''` when flag off, labels empty, or read errors. Otherwise a catalog block + one guidance line.
- Changes: `buildSystemPrompt(pageContext, user, settings = null)` — 3rd arg optional; appends `communityCatalogLayer` on the learner path only.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg/community-catalog-layer.test.js`:

```javascript
// test/unit/kg/community-catalog-layer.test.js
// Unit tests for communityCatalogLayer (#1173). Uses in-memory SQLite to seed
// KgCommunityLabel; asserts flag gating + fail-open.
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { communityCatalogLayer } from '../../../srv/lib/chat-context.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP1 = 'f'.repeat(64);
const FP2 = '9'.repeat(64);

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunityLabel } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: { in: [FP1, FP2] } }));
  await db.run(INSERT.into(KgCommunityLabel).entries([
    { communityFingerprint: FP1, label: 'SAP RAP & Fiori Elements', rationale: 'r', memberSlugsHash: '0'.repeat(64) },
    { communityFingerprint: FP2, label: 'CAP & Node.js Services',   rationale: 'r', memberSlugsHash: '1'.repeat(64) },
  ]));
});

describe('communityCatalogLayer', () => {
  it('returns empty string when flag is off', async () => {
    expect(await communityCatalogLayer({ communityPeersEnabled: false })).toBe('');
    expect(await communityCatalogLayer(null)).toBe('');
  });

  it('lists labels and guidance when flag on', async () => {
    const out = await communityCatalogLayer({ communityPeersEnabled: true });
    expect(out).toContain('SAP RAP & Fiori Elements');
    expect(out).toContain('CAP & Node.js Services');
    expect(out).toMatch(/describeCommunity/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-catalog-layer.test.js`
Expected: FAIL — `communityCatalogLayer` not exported.

- [ ] **Step 3: Add the layer + wire it into `buildSystemPrompt`**

In `srv/lib/chat-context.js`, add the import at the very top (after the existing `import { sliceStep }` line):

```javascript
import cds from '@sap/cds';
```

Add the exported layer function (place it just above `export async function buildSystemPrompt`):

```javascript
const NS_IMS = 'com.sap.developers.ims';
const MAX_CATALOG_LABELS = 40; // cap the injected list; ~18 today
let _catalogCache = { at: 0, block: '' };
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Learner-prompt layer (#1173): inject the labeled Louvain-cluster catalog so
 * the LLM can map "the AI cluster" → an exact label and call describeCommunity.
 * Gated on communityPeersEnabled. Fail-open: any read error → '' (the tool
 * still works via its topic-token fallback / clarify path).
 * Cached in-process ~5 min so we don't read KgCommunityLabel every chat turn.
 * @param {object|null} settings - ChatSettings row (or subset)
 * @returns {Promise<string>}
 */
export async function communityCatalogLayer(settings) {
  if (!settings?.communityPeersEnabled) return '';
  const now = Date.now();
  if (_catalogCache.block && now - _catalogCache.at < CATALOG_TTL_MS) return _catalogCache.block;
  try {
    const db = await cds.connect.to('db');
    const { KgCommunityLabel } = cds.entities(NS_IMS);
    const rows = await db.run(
      SELECT.from(KgCommunityLabel).columns('label').orderBy('label asc').limit(MAX_CATALOG_LABELS)
    );
    const labels = rows.map((r) => r.label).filter(Boolean);
    if (labels.length === 0) { _catalogCache = { at: now, block: '' }; return ''; }
    const block = [
      'Known topic clusters (use for "what\'s the X cluster / area as a whole" questions —',
      'pass the EXACT label below to describeCommunity as matched_label):',
      ...labels.map((l) => `- ${l}`),
      '',
      'When the learner asks about a topic area/cluster as a whole, call describeCommunity',
      'with the best-matching label above. If none clearly matches, say there is no matching',
      'cluster; if two are close, ask which they mean.',
    ].join('\n');
    _catalogCache = { at: now, block };
    return block;
  } catch (err) {
    cds.log('chat-context').warn('communityCatalogLayer failed:', err.message);
    return '';
  }
}
```

Change the `buildSystemPrompt` signature and learner-path assembly. Replace:

```javascript
export async function buildSystemPrompt(pageContext, user) {
```

with:

```javascript
export async function buildSystemPrompt(pageContext, user, settings = null) {
```

Then, in the layer-assembly block, after the `PROGRESS_GUIDANCE` push and before `layers.push(await pageLayer(...))`, add the catalog on the learner path only (learner = not admin/devtoberfest/advocates — same guard as `PROGRESS_GUIDANCE`):

```javascript
  if (!isAdmin && !isDevtoberfest && !isAdvocates) {
    const catalog = await communityCatalogLayer(settings);
    if (catalog) layers.push(catalog);
  }
```

Leave everything else in the function unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-catalog-layer.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Thread `settings` through the server caller**

In `srv/server.js`, at the `buildSystemPrompt` call (~line 1263), add the third arg. Replace:

```javascript
      const system = await buildSystemPrompt(effectivePageContext, {
        firstName: user.attr?.given_name || user.attr?.givenName || '',
        lastName:  user.attr?.family_name || user.attr?.familyName || ''
      });
```

with:

```javascript
      const system = await buildSystemPrompt(effectivePageContext, {
        firstName: user.attr?.given_name || user.attr?.givenName || '',
        lastName:  user.attr?.family_name || user.attr?.familyName || ''
      }, settings);
```

(`settings` is the ChatSettings row already read at server.js:1215 for the kill-switch, in scope in the same `businessHandler`.)

- [ ] **Step 6: Confirm no regression in existing chat-context / prompt tests**

Run: `npx vitest run test/ -t "buildSystemPrompt"` and `npx vitest run test/chat-orchestrator-search-expansion.test.js`
Expected: PASS. (Flag defaults off / `settings` defaults null ⇒ prompt output unchanged.)

- [ ] **Step 7: Commit**

```bash
git add srv/lib/chat-context.js srv/server.js test/unit/kg/community-catalog-layer.test.js
git commit -m "feat(#1173): inject labeled-cluster catalog into learner prompt"
```

---

## Task 5: Orchestrator wiring (registry, dispatch, SSE)

Register `describeCommunity` under `communityPeersEnabled`, dispatch it, and emit its results on the reused `community-peers-cards` SSE frame.

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`
- Modify: `test/chat-orchestrator-community-peers.test.js`

**Interfaces:**
- Consumes: `DESCRIBE_COMMUNITY_TOOL`, `describeCommunityHandler` (Task 3).

- [ ] **Step 1: Extend the registry test (failing)**

In `test/chat-orchestrator-community-peers.test.js`, add inside the existing `describe('findCommunityPeers registry gating (#1126)', ...)` block (or a new sibling `describe`):

```javascript
  it('registers describeCommunity when communityPeersEnabled is true (#1173)', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: true } }).map((t) => t.function.name);
    expect(names).toContain('describeCommunity');
  });
  it('omits describeCommunity when communityPeersEnabled is false (#1173)', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: false } }).map((t) => t.function.name);
    expect(names).not.toContain('describeCommunity');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat-orchestrator-community-peers.test.js`
Expected: FAIL — `describeCommunity` not in the registry.

- [ ] **Step 3: Wire the orchestrator**

In `srv/lib/chat-orchestrator.js`:

(a) Add the import after the existing community-peers import (line 8):

```javascript
import { DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler } from './kg/joule-tool-describe-community.js';
```

(b) In `buildToolRegistry`, extend the `communityPeersEnabled` block to register both tools:

```javascript
  if (settings?.communityPeersEnabled) {
    tools.push(FIND_COMMUNITY_PEERS_TOOL);
    tools.push(DESCRIBE_COMMUNITY_TOOL);
  }
```

(c) In `buildSystemPromptLines`, inside the existing `if (settings?.communityPeersEnabled)` block, after the current push, add (with the clarifying comment):

```javascript
    // NOTE: This line is retained for symmetry + the existing test pattern, but
    // the LIVE describeCommunity guidance + cluster catalog ship via
    // communityCatalogLayer in chat-context.js — buildSystemPromptLines is not
    // consumed by the runtime prompt builder (buildSystemPrompt). See #1173 spec.
    lines.push(
      "When the learner asks about a whole topic area or cluster (\"what's the AI cluster\", \"everything around RAP\"), call `describeCommunity` with the best-matching cluster label."
    );
```

(d) In `dispatchTool`, after the `findCommunityPeers` case (ends ~line 698), add:

```javascript
  if (name === 'describeCommunity') {
    try {
      const db = await cds.connect.to('db');
      return await describeCommunityHandler({ db, args });
    } catch (err) {
      LOG.warn('describeCommunity dispatch failed:', err.message);
      return { members: [], reason: 'dispatch_failed' };
    }
  }
```

(e) In `streamChat`'s dispatch loop, after the `findCommunityPeers` SSE branch (~line 833-835), add:

```javascript
        } else if (tc.name === 'describeCommunity' && result && Array.isArray(result.members) && result.members.length > 0) {
          sse(res, { type: 'community-peers-cards', label: result.label, items: result.members });
```

(f) Add `DESCRIBE_COMMUNITY_TOOL` to the bottom `export { … }` list (after `FIND_COMMUNITY_PEERS_TOOL`).

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `npx vitest run test/chat-orchestrator-community-peers.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Run the full unit suite for the touched areas**

Run: `npx vitest run test/chat-orchestrator-search-expansion.test.js test/unit/kg/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-community-peers.test.js
git commit -m "feat(#1173): wire describeCommunity into chat orchestrator + SSE"
```

---

## Task 6: Hybrid coverage (real HANA)

Prove the HANA path — labeled community → `describeCommunityHandler` → members + label round-trip.

**Files:**
- Modify: `test/hybrid/kg-community-peers.test.js`

**Interfaces:**
- Consumes: `describeCommunityHandler` (Task 3).

- [ ] **Step 1: Add the hybrid test**

In `test/hybrid/kg-community-peers.test.js`, add the import at the top with the existing import:

```javascript
import { describeCommunityHandler } from '../../srv/lib/kg/joule-tool-describe-community.js';
```

The `beforeAll` already seeds a `KgCommunity` (2 tutorial members: `slugA`, `slugB` under fingerprint `FP`) and a `KgCommunityLabel` (`label: 'Test Cluster'`). Add a new `describe` block after the existing one:

```javascript
describe('describeCommunity on real HANA (#1173)', () => {
  it('resolves via matched_label and returns members + label', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'the test area', matched_label: 'Test Cluster' } });
    expect(out.label).toBe('Test Cluster');
    const slugs = out.members.map((m) => m.slug);
    expect(slugs).toContain(slugA);
    expect(slugs).toContain(slugB);
  });

  it('returns no-match for an unresolvable topic', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'zzz-nonexistent-topic-xyz-1173' } });
    // Either no-match, or (if a real labeled community happens to token-overlap)
    // it must still be a well-formed fail-open shape — never a throw.
    expect(Array.isArray(out.members)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the hybrid test**

Requires `cf login` + hybrid binding. Run: `npx vitest run --project hybrid test/hybrid/kg-community-peers.test.js`
Expected: PASS (existing 2 + new 2). If HANA is unbound, the file's guard throws — bind via `npm run bind:setup` / `cds bind` first.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-community-peers.test.js
git commit -m "test(#1173): hybrid coverage for describeCommunity on HANA"
```

---

## Task 7: Full verification + deploy sanity + docs

Final gates: full unit suite, in-memory deploy sanity, and a CLAUDE.md gotcha line.

**Files:**
- Modify: `CLAUDE.md` (Top Gotchas — one line)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (no regressions). If a pre-existing unrelated failure appears, note it but do not fix out of scope.

- [ ] **Step 2: Deploy sanity (in-memory)**

Run: `npx cds deploy --to sqlite::memory:`
Expected: deploys clean (no schema change, but confirms the model + new SELECTs are valid). No errors.

- [ ] **Step 3: Add the CLAUDE.md gotcha line**

In `CLAUDE.md`, under "## Top Gotchas", after the `KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD` (#1172) bullet, add:

```markdown
- **Cluster-level Q&A in Joule (issue #1173)** — `describeCommunity` Joule tool (`srv/lib/kg/joule-tool-describe-community.js`) answers "what's the AI cluster?" / "everything around RAP" by resolving a free-text topic to a labeled Louvain community. **LLM-side matching:** `communityCatalogLayer` in `srv/lib/chat-context.js` injects the labeled-cluster catalog (from `KgCommunityLabel`, cached ~5min, cap 40) into the learner system prompt **only when `communityPeersEnabled` is true**; the model passes the chosen label as `matched_label`, and `matchLabel` (`srv/lib/kg/community-label-match.js`, pure) does case-insensitive exact match + token-overlap fallback + ambiguity detection. Reuses the existing `communityPeersEnabled` flag (NO new flag/schema), the `community-peers-cards` SSE frame + `renderCommunityPeersCards` render path, and the extracted `resolveCommunityMembers` helper (`srv/lib/kg/community-members.js`, also used by `findCommunityPeers`). Fail-open throughout (never 500). **Gotcha:** `buildSystemPromptLines` in `chat-orchestrator.js` is DEAD at runtime — `buildSystemPrompt` (chat-context.js) never calls it; the live guidance ships via `communityCatalogLayer`. DEV-only until PROD Louvain data verifies (same posture as #1126).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#1173): document cluster-level Q&A gotcha in CLAUDE.md"
```

- [ ] **Step 5: Push branch + open PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(#1173): KG communities — cluster-level Q&A in Joule" --body "Implements #1173 (#1126 follow-on 4/4). Adds describeCommunity Joule tool with LLM-side cluster matching. Spec: docs/superpowers/specs/2026-07-15-1173-cluster-qa-joule-design.md"
```

---

## Self-Review

**Spec coverage:**
- Acceptance: "what's the AI cluster / everything around RAP resolves to labeled community + members + rationale" → Tasks 2/3/4 (matcher + tool + catalog injection). ✅
- "Ambiguous/unmatched degrade gracefully, never 500 (fail-open)" → `matchLabel` ambiguous/no-match + handler fail-open (Task 2/3); prompt guidance narrates (Task 4). ✅
- "Reuses `community-peers-cards` render path; no duplicate frame" → Task 5 step 3(e). ✅
- "Slug joins `.toLowerCase()`; only ACTIVE/published members" → `resolveCommunityMembers` (Task 1). ✅
- "Unit coverage for topic→community resolution; hybrid for HANA path" → Tasks 2/3 unit + Task 6 hybrid. ✅
- Gating reuses `communityPeersEnabled` → Tasks 4/5. ✅
- Critical finding (dead `buildSystemPromptLines`) handled via new prompt layer → Task 4; documented Task 5(c) + Task 7. ✅
- No schema/mta/joule.js change → Global Constraints + File Structure. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. ✅

**Type consistency:** `resolveCommunityMembers({db,fingerprint,limit,excludeSlug})→[{slug,title,url}]` consistent across Tasks 1/3. `matchLabel({topic,matchedLabel,labels})→{fingerprint?,label?,rationale?,reason?,candidates?}` consistent Tasks 2/3. `describeCommunityHandler({db,args})→{label?,rationale?,members,reason?}` consistent Tasks 3/5/6. Tool arg is `matched_label` (snake, LLM-facing) mapped to `matchedLabel` (camel, internal) at the handler boundary — consistent. SSE maps `members`→`items` (Task 5 matches render helper's `(items, label)` from Task 0 recon). ✅
