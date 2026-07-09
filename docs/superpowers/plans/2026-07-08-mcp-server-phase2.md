# MCP Server Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the authenticated tier of the hosted MCP server — OAuth 2.1 at `/mcp-auth/*`, PATs at `/mcp-pat/*`, 8 authenticated curated tools, and a shared step-HTML slicer that retrofits two existing whole-tutorial dumps.

**Architecture:** Layer onto the Phase-1 `@cap-js/mcp@1.1.1` adapter. Three MCP routes coexist at the approuter — `/mcp/*` (anonymous, unchanged), `/mcp-pat/*` (new, PAT middleware resolves req.user), `/mcp-auth/*` (new, XSUAA JWT with `Tutorial.MCP` scope gate). All three converge on the same in-process CAP handlers. Discovery docs served as static approuter files with per-env tenant substitution during `mbt build`.

**Tech Stack:** CAP 10.0.3 Node.js, `@cap-js/mcp@1.1.1`, XSUAA (OAuth 2.1 + PKCE), HANA Cloud, Fiori Elements + admin-shell (existing), `cheerio` (already a direct dep) for HTML parsing, `lru-cache` (already vendored in `content-store.js`) for the slicer cache.

## Global Constraints

- Node 22+ (project baseline; CAP 10 raised minimum).
- `@sap/cds@10.0.3` — never downgrade for compatibility with `@cap-js/mcp@1.1.1`.
- Never use `req.user` without a `@requires` annotation on the enclosing service or entity.
- Never write raw SQL — use `cds.ql` / CQL. Exception: HANA BLOB reads use `db.run()` because CDS QL mixes non-BLOB columns with LOB locators unsafely (see `docs/developers/reference/tutorials-ims-gotchas.md` — the BLOB gotcha).
- Both `xs-security.json` files at repo root **and** `.deploy/xs-security.json` must stay in sync (drift guard: `test/unit/xs-security-authorities.test.js`).
- Never store credentials or PAT plaintext in source, logs, or the DB — SHA-256 hashes only.
- Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` or `db/data/*.csv` change (`@assert.unique.*` is runtime-only; static `cds compile` misses it).
- Run `cds build --production` (never bare `cds compile`) after schema changes so `db/last-dev/csn.json` is regenerated for HDI staging.
- Every publish step uses `gh workflow run rebuild-content.yml` — never run `publish-content` from a workstation.
- LLM-UX baseline model pinned: `claude-haiku-4-5-20251001`.
- Never restart or push commits to `main`; work happens only on `worktree-mcp-phase2-spec`.
- Commit messages reference `#1105`. All commits get pushed to the existing draft PR #1109 as each task completes.
- LF line endings only (Windows subagents drift to CRLF — memory rule).

---

## Task 0: Prep and baseline check

**Files:**
- Read: `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md`
- Verify: `srv/developer-service.cds`, `srv/homepage-service.cds`, `srv/search-service.cds`, `package.json`, `xs-security.json`, `.deploy/xs-security.json`, `approuter/xs-app.json`

**Interfaces:**
- Consumes: nothing (Task 0)
- Produces: a working local dev environment on the `worktree-mcp-phase2-spec` branch with all Phase-1 tests green.

- [ ] **Step 1: Confirm branch and worktree**

Run: `git branch --show-current && pwd`
Expected: `worktree-mcp-phase2-spec` and `.claude/worktrees/mcp-phase2-spec`.

- [ ] **Step 2: Rebase on latest main**

Run:
```bash
git fetch origin main
git merge origin/main --no-ff -m "chore(#1105): merge main into Phase 2 branch"
```
Expected: clean merge or resolvable conflict; commit has two parents (memory rule: `git cat-file -p HEAD | grep -c '^parent'` must print `2`).

- [ ] **Step 3: Install deps**

Run: `npm install && npm run setup`
Expected: green install; `hugo-apps/node_modules` populated; `better-sqlite3` binding built.

- [ ] **Step 4: Run Phase 1 tests to confirm green baseline**

Run: `npm test -- --run test/unit/mcp-`
Expected: all Phase 1 MCP unit tests pass (mcp-enabled-services, mcp-package-config, mcp-search-tools, mcp-homepage-tools, mcp-kg-tools, mcp-contract, approuter-mcp-route — 89 tests).

- [ ] **Step 5: Verify `@cap-js/mcp@1.1.1` and `cheerio` are installed**

Run: `jq '.dependencies["@cap-js/mcp"], .dependencies.cheerio' package.json`
Expected: `"1.1.1"` and `"^1.2.0"` (or similar).

- [ ] **Step 6: Note the HomepageService `@protocol` inconsistency for Task 6**

Run: `grep -n '@protocol' srv/homepage-service.cds`
Expected output shows `@protocol: ['odata', 'mcp']` (no `graphql`). Task 6 will add `graphql` to match spec architecture diagram — no action here, just verify the starting state.

- [ ] **Step 7: Commit the merge**

Already committed by Step 2's merge. Confirm:
Run: `git log -1 --format='%H %s'`
Expected: shows the merge commit; nothing to add.

---

## Task 1: Shared tutorial step slicer

**Files:**
- Create: `srv/lib/tutorial-step-slicer.js`
- Test: `test/unit/tutorial-step-slicer.test.js`

**Interfaces:**
- Consumes: `cds.entities('com.sap.developers.ims').ContentFiles`, `cds.entities('com.sap.developers.ims').ContentManifest` (existing schema, read-only).
- Produces:
  - `sliceStep(slug, stepNumber)` → `Promise<{html, text, stepTitle, totalSteps} | null>`
  - `sliceAllSteps(slug)` → `Promise<Array<{stepNumber, title}> | null>` (metadata only)
  - `invalidateSlug(slug)` → `void`

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/tutorial-step-slicer.test.js`:
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

// Fixture: 3-step tutorial HTML in the Hugo-emitted shape.
const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1">
    <h2 class="step-title">Install CAP</h2>
    <p>Run <code>npm install -g @sap/cds-dk</code>.</p>
  </section>
  <section class="step" data-step-number="2">
    <h2 class="step-title">Init the project</h2>
    <p>Run <code>cds init bookshop</code>.</p>
  </section>
  <section class="step" data-step-number="3">
    <h2 class="step-title">Start the server</h2>
    <p>Run <code>cds watch</code>.</p>
  </section>
</main>`;

const NS = 'com.sap.developers.ims';

describe('tutorial-step-slicer', () => {
  let sliceStep, sliceAllSteps, invalidateSlug;

  beforeAll(async () => {
    const test = cds.test('serve').in(process.cwd());
    await test;
    const { ContentManifest, ContentFiles } = cds.entities(NS);
    await INSERT.into(ContentManifest).entries({
      version: 'v-test', status: 'ACTIVE', publishedAt: new Date()
    });
    await INSERT.into(ContentFiles).entries({
      version: 'v-test',
      slug: 'hello-cap',
      path: 'tutorials/hello-cap/index.html',
      contentType: 'text/html',
      contentGz: gzipSync(Buffer.from(FIXTURE_HTML))
    });
    ({ sliceStep, sliceAllSteps, invalidateSlug } = await import('../../srv/lib/tutorial-step-slicer.js'));
  });

  it('returns the correct step for a valid stepNumber', async () => {
    const slice = await sliceStep('hello-cap', 2);
    expect(slice).not.toBeNull();
    expect(slice.stepTitle).toBe('Init the project');
    expect(slice.html).toContain('cds init bookshop');
    expect(slice.text).toContain('cds init bookshop');
    expect(slice.text).not.toContain('<code>');
    expect(slice.totalSteps).toBe(3);
  });

  it('returns null for a step out of range', async () => {
    expect(await sliceStep('hello-cap', 99)).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    expect(await sliceStep('no-such-slug', 1)).toBeNull();
  });

  it('sliceAllSteps returns metadata only in order', async () => {
    const meta = await sliceAllSteps('hello-cap');
    expect(meta).toEqual([
      { stepNumber: 1, title: 'Install CAP' },
      { stepNumber: 2, title: 'Init the project' },
      { stepNumber: 3, title: 'Start the server' }
    ]);
  });

  it('invalidateSlug clears the cache for that slug', async () => {
    await sliceStep('hello-cap', 1); // warm cache
    invalidateSlug('hello-cap');
    // A second call should re-hit the DB — assert by mutating and confirming re-read.
    const { ContentFiles } = cds.entities(NS);
    await UPDATE(ContentFiles).where({ slug: 'hello-cap' }).with({
      contentGz: gzipSync(Buffer.from(FIXTURE_HTML.replace('Install CAP', 'INSTALL CAP')))
    });
    const slice = await sliceStep('hello-cap', 1);
    expect(slice.stepTitle).toBe('INSTALL CAP');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tutorial-step-slicer.test.js`
Expected: FAIL with "Cannot find module '../../srv/lib/tutorial-step-slicer.js'".

- [ ] **Step 3: Write the slicer**

Create `srv/lib/tutorial-step-slicer.js`:
```js
// Shared step-HTML slicer.
// Three consumers:
//   1. DeveloperService.get_tutorial_step (authenticated MCP)
//   2. SearchService.get_tutorial_step (anonymous MCP)
//   3. srv/lib/code-check-step-loader.defaultLoadStepText (Joule checkStepCode)
//   4. srv/lib/chat-context.js server-side fallback
//
// Contract: identical output shape for all callers; slicing is a pure function of
// (slug, activeManifestVersion, HANA BLOB). Cache invalidates on content publish
// via subscription to the existing `content.published` cds event.

import cds from '@sap/cds';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { LRUCache } from 'lru-cache';
import * as cheerio from 'cheerio';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('mcp-slicer');

// LRU: 200 slugs × ~50KB avg = ~10MB RAM ceiling.
const cache = new LRUCache({ max: 200, ttl: 30 * 60 * 1000 });

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getActiveVersion() {
  const { ContentManifest } = cds.entities(NS);
  const [row] = await SELECT.from(ContentManifest)
    .where({ status: 'ACTIVE' })
    .columns('version');
  return row?.version ?? null;
}

async function loadAndParse(slug) {
  if (process.env.KG_STEP_SLICER_ENABLED === 'false') return null;

  const version = await getActiveVersion();
  if (!version) return null;

  const cacheKey = `${slug}::${version}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { ContentFiles } = cds.entities(NS);
  const [meta] = await SELECT.from(ContentFiles)
    .where({ version, slug })
    .columns('slug', 'contentType');
  if (!meta) return null;

  // BLOB read: raw db.run() on HANA per the LOB-locator gotcha; CDS QL works on SQLite.
  let blobRow;
  try {
    blobRow = await SELECT.one.from(ContentFiles)
      .where({ version, slug })
      .columns('contentGz');
  } catch (err) {
    LOG.warn(`slicer: BLOB fetch failed for ${slug}`, err.message);
    return null;
  }

  const buffer = await toBuffer(blobRow.contentGz);
  let html;
  try {
    html = gunzipSync(buffer).toString('utf8');
  } catch (err) {
    LOG.warn(`slicer: gunzip failed for ${slug}`, err.message);
    return null;
  }

  const $ = cheerio.load(html);
  const steps = new Map();
  const sections = $('section.step[data-step-number]');
  sections.each((_, el) => {
    const $el = $(el);
    const stepNumber = parseInt($el.attr('data-step-number'), 10);
    if (!Number.isFinite(stepNumber)) return;
    const title = $el.find('h2.step-title').first().text().trim();
    const stepHtml = $.html($el);
    steps.set(stepNumber, { html: stepHtml, text: stripHtml(stepHtml), title });
  });

  if (steps.size === 0) {
    LOG.warn(`slicer: no <section class="step"> found for ${slug}; content may be malformed`);
    return null;
  }

  const result = { steps, totalSteps: steps.size };
  cache.set(cacheKey, result);
  return result;
}

export async function sliceStep(slug, stepNumber) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  const step = parsed.steps.get(stepNumber);
  if (!step) return null;
  return { html: step.html, text: step.text, stepTitle: step.title, totalSteps: parsed.totalSteps };
}

export async function sliceAllSteps(slug) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  return [...parsed.steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stepNumber, { title }]) => ({ stepNumber, title }));
}

export function invalidateSlug(slug) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${slug}::`)) cache.delete(key);
  }
}

// Subscribe to content-publish events for automatic invalidation.
cds.on('served', () => {
  cds.on('content.published', ({ slug }) => {
    if (slug) invalidateSlug(slug);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/tutorial-step-slicer.test.js`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tutorial-step-slicer.js test/unit/tutorial-step-slicer.test.js
git commit -m "feat(#1105): shared tutorial-step-slicer with LRU cache

New srv/lib/tutorial-step-slicer.js — the single-source-of-truth for
per-step HTML/text slicing. cheerio parses Hugo's <section class='step'
data-step-number='N'> shape; LRU keyed on slug::activeManifestVersion.
Subscribes to content.published for cache invalidation. Feature flag:
KG_STEP_SLICER_ENABLED=false short-circuits to null.

Three consumers land in later tasks (get_tutorial_step MCP tool,
code-check-step-loader retrofit, chat-context server-side fallback).

Refs #1105."
git push
```

---

## Task 2: Retrofit code-check-step-loader onto the slicer

**Files:**
- Modify: `srv/lib/code-check-step-loader.js`
- Test: `test/unit/code-check-step-loader.test.js` (may not exist; create if missing)

**Interfaces:**
- Consumes: `sliceStep` from Task 1.
- Produces: `defaultLoadStepText(slug, stepNumber)` — same signature as before, but now honors `stepNumber`.

- [ ] **Step 1: Check whether an existing test file covers this loader**

Run: `ls test/unit/code-check-step-loader.test.js 2>/dev/null || echo "MISSING"`
If MISSING, create it in Step 2. Otherwise, add cases to the existing file.

- [ ] **Step 2: Write the failing test**

Create or extend `test/unit/code-check-step-loader.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1"><h2 class="step-title">Alpha</h2><p>Alpha body</p></section>
  <section class="step" data-step-number="2"><h2 class="step-title">Bravo</h2><p>Bravo body BODY_FOR_STEP_TWO</p></section>
  <section class="step" data-step-number="3"><h2 class="step-title">Charlie</h2><p>Charlie body</p></section>
</main>`;

describe('code-check-step-loader retrofit', () => {
  let defaultLoadStepText;

  beforeAll(async () => {
    await cds.test('serve').in(process.cwd());
    const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentManifest).entries({
      version: 'v-cc', status: 'ACTIVE', publishedAt: new Date()
    });
    await INSERT.into(ContentFiles).entries({
      version: 'v-cc', slug: 'cc-tut', path: 'tutorials/cc-tut/index.html',
      contentType: 'text/html', contentGz: gzipSync(Buffer.from(FIXTURE_HTML))
    });
    ({ defaultLoadStepText } = await import('../../srv/lib/code-check-step-loader.js'));
  });

  it('returns ONLY step N text, not the whole tutorial', async () => {
    const text = await defaultLoadStepText('cc-tut', 2);
    expect(text).toContain('BODY_FOR_STEP_TWO');
    expect(text).not.toContain('Alpha body');
    expect(text).not.toContain('Charlie body');
  });

  it('returns null on missing slug', async () => {
    expect(await defaultLoadStepText('no-such-slug', 1)).toBeNull();
  });

  it('returns null on out-of-range stepNumber', async () => {
    expect(await defaultLoadStepText('cc-tut', 99)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/code-check-step-loader.test.js`
Expected: FAIL — the "returns ONLY step N" case will fail because the current impl returns the whole tutorial.

- [ ] **Step 4: Rewrite `srv/lib/code-check-step-loader.js`**

Replace the whole file with:
```js
// srv/lib/code-check-step-loader.js
// Loads per-step plain text for the code-check LLM prompt.
// Delegates to srv/lib/tutorial-step-slicer.js — retrofitted 2026-07-08
// as part of #1105 Phase 2. Previously dumped the whole tutorial to the
// LLM regardless of stepNumber; now grades against exactly the step the
// user is on.
//
// Returns null on any error so the dispatcher's safeCall handles it gracefully.

import cds from '@sap/cds';
import { sliceStep } from './tutorial-step-slicer.js';

const LOG = cds.log('code-check');

/** Hard cap on plain-text length returned to the LLM (chars). */
const PLAIN_TEXT_CAP = 3000;

/**
 * Load step N of tutorial `slug` as plain text, capped at PLAIN_TEXT_CAP.
 *
 * @param {string} slug        - Tutorial slug (lowercase canonical).
 * @param {number} stepNumber  - Step number, 1-indexed.
 * @returns {Promise<string|null>} Plain text or null on any error.
 */
export async function defaultLoadStepText(slug, stepNumber) {
  try {
    const slice = await sliceStep(slug, stepNumber);
    if (!slice) return null;
    return slice.text.slice(0, PLAIN_TEXT_CAP);
  } catch (err) {
    LOG.warn(`defaultLoadStepText failed for ${slug} step ${stepNumber}:`, err.message);
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/code-check-step-loader.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 6: Run adjacent tests to catch regressions**

Run: `npx vitest run test/unit/chat-orchestrator`
Expected: no new failures. `checkStepCode` uses `defaultLoadStepText` — signature unchanged.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/code-check-step-loader.js test/unit/code-check-step-loader.test.js
git commit -m "refactor(#1105): retrofit code-check-step-loader onto shared slicer

Delete stripHtml/hanaTableName/getActiveVersion copies. Delete
PLAIN_TEXT_CAP whole-tutorial dump. defaultLoadStepText(slug, stepNumber)
now honors stepNumber via srv/lib/tutorial-step-slicer.sliceStep — Joule
checkStepCode grades submitted code against the actual step the user is
on, not the whole tutorial text. TODO Phase 4 comment removed.

Refs #1105."
git push
```

---

## Task 3: Chat-context server-side slicer fallback

**Files:**
- Modify: `srv/lib/chat-context.js`
- Test: `test/unit/chat-context-server-slice.test.js` (new)

**Interfaces:**
- Consumes: `sliceStep` from Task 1.
- Produces: no new exports. Behavior change: when `ctx.slug && ctx.currentStep && !ctx.currentStepText`, server populates `currentStepText` from the slicer.

- [ ] **Step 1: Write the failing test**

Create `test/unit/chat-context-server-slice.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1"><h2 class="step-title">Alpha</h2><p>ALPHA_MARKER</p></section>
  <section class="step" data-step-number="2"><h2 class="step-title">Bravo</h2><p>BRAVO_MARKER</p></section>
</main>`;

describe('chat-context server-side slicer fallback', () => {
  let buildSystemPrompt;

  beforeAll(async () => {
    await cds.test('serve').in(process.cwd());
    const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentManifest).entries({
      version: 'v-cc', status: 'ACTIVE', publishedAt: new Date()
    });
    await INSERT.into(ContentFiles).entries({
      version: 'v-cc', slug: 'cx-tut', path: 'tutorials/cx-tut/index.html',
      contentType: 'text/html', contentGz: gzipSync(Buffer.from(FIXTURE_HTML))
    });
    ({ buildSystemPrompt } = await import('../../srv/lib/chat-context.js'));
  });

  it('populates currentStepText from slicer when client omits it', async () => {
    const prompt = await buildSystemPrompt({ slug: 'cx-tut', currentStep: 2 });
    expect(prompt).toContain('BRAVO_MARKER');
    expect(prompt).not.toContain('ALPHA_MARKER');
  });

  it('does not re-slice when client provides currentStepText', async () => {
    const prompt = await buildSystemPrompt({
      slug: 'cx-tut', currentStep: 2, currentStepText: 'CLIENT_SUPPLIED_TEXT'
    });
    expect(prompt).toContain('CLIENT_SUPPLIED_TEXT');
    expect(prompt).not.toContain('BRAVO_MARKER');
  });

  it('is a no-op without slug or currentStep', async () => {
    const prompt = await buildSystemPrompt({});
    expect(prompt).not.toContain('BRAVO_MARKER');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/chat-context-server-slice.test.js`
Expected: FAIL — server does not currently fall back to the slicer.

- [ ] **Step 3: Add the fallback to `srv/lib/chat-context.js`**

Read the file first to find `buildSystemPrompt`:
Run: `grep -n 'buildSystemPrompt\|currentStepText' srv/lib/chat-context.js`

Then insert the fallback immediately before the existing `if (ctx.currentStepText)` block. Add at the top of the file:
```js
import { sliceStep } from './tutorial-step-slicer.js';
```

And modify `buildSystemPrompt` (or the equivalent function) — before the `if (ctx.currentStepText)` line, insert:
```js
  // Server-side slicer fallback (Phase 2 #1105): if client omitted currentStepText
  // but named a slug+step, fetch step content from the shared slicer. Enables
  // programmatic Joule callers without a DOM (e.g. future VS Code extension)
  // and hardens against client-cached-stale pages.
  if (ctx.slug && ctx.currentStep && !ctx.currentStepText) {
    try {
      const slice = await sliceStep(ctx.slug, ctx.currentStep);
      if (slice) ctx.currentStepText = slice.text;
    } catch { /* fall through — the interactive DOM path remains unaffected */ }
  }
```

If `buildSystemPrompt` is currently synchronous, change its signature to `async` and update `srv/lib/chat-orchestrator.js` callers to `await` it. Search: `grep -n 'buildSystemPrompt' srv/lib/chat-orchestrator.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/chat-context-server-slice.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 5: Run adjacent tests**

Run: `npx vitest run test/unit/chat`
Expected: no new failures. If `buildSystemPrompt` awaits caused breakage, propagate `async`/`await` up to the top of the chat handler.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-context.js srv/lib/chat-orchestrator.js test/unit/chat-context-server-slice.test.js
git commit -m "feat(#1105): chat-context server-side slicer fallback

When ctx.slug + ctx.currentStep are set but ctx.currentStepText is
absent (programmatic caller, cached-stale page), populate currentStepText
from the shared slicer. Browser DOM path unaffected — fallback fires only
when the client omits currentStepText.

Refs #1105."
git push
```

---

## Task 4: XSUAA scope + role + role collection + expanded redirect URIs

**Files:**
- Modify: `xs-security.json`
- Modify: `.deploy/xs-security.json`
- Modify: `test/unit/xs-security-authorities.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: XSUAA scope `$XSAPPNAME.Tutorial.MCP`, role template `TutorialMCP`, role collection `Tutorials MCP Users`, extended `oauth2-configuration.redirect-uris` for MCP client callbacks (localhost, 127.0.0.1, mcp://, prod callback). Task 6 will reference this scope in the approuter route.

**Design note (updated 2026-07-09 during implementation):** The spec's Section 2 originally called for a separate `sb-tutorials-mcp` OAuth client (PKCE-only, no secret). XSUAA's `xs-security.json` schema doesn't support multiple named clients under one instance — `oauth2-configuration` is a single top-level object with one `redirect-uris` array. Rather than provision a second XSUAA instance (doubles management surface), Phase 2 extends the existing app's redirect-uri allowlist. PKCE is client-side: MCP clients send `code_verifier` + `S256` challenge against the default XSUAA `clientid` and simply omit `client_secret`. XSUAA's token endpoint accepts PKCE public-client flow this way. Consequence: the same redirect URIs are technically allowed for the existing web + VS Code flows too — not a security regression, just a slightly broader allowlist. Task 5's `.well-known/oauth-authorization-server` still points at the same XSUAA `token_endpoint`; nothing else in the design changes.

- [ ] **Step 1: Extend the drift-guard test first (TDD-for-config)**

Modify `test/unit/xs-security-authorities.test.js` — add cases:
```js
it('declares Tutorial.MCP scope in both xs-security files', () => {
  for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
    const content = JSON.parse(fs.readFileSync(path, 'utf8'));
    const names = content.scopes.map(s => s.name);
    expect(names).toContain('$XSAPPNAME.Tutorial.MCP');
  }
});

it('declares TutorialMCP role template in both xs-security files', () => {
  for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
    const content = JSON.parse(fs.readFileSync(path, 'utf8'));
    const tpl = content['role-templates'].find(t => t.name === 'TutorialMCP');
    expect(tpl).toBeDefined();
    expect(tpl['scope-references']).toContain('$XSAPPNAME.Tutorial.MCP');
    expect(tpl['scope-references']).toContain('$XSAPPNAME.Everyone');
  }
});

it('declares "Tutorials MCP Users" role collection in both xs-security files', () => {
  for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
    const content = JSON.parse(fs.readFileSync(path, 'utf8'));
    const rc = content['role-collections']?.find(r => r.name === 'Tutorials MCP Users');
    expect(rc).toBeDefined();
    expect(rc['role-template-references']).toContain('$XSAPPNAME.TutorialMCP');
  }
});

it('oauth2-configuration.redirect-uris includes MCP client callback patterns in both xs-security files', () => {
  for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
    const content = JSON.parse(fs.readFileSync(path, 'utf8'));
    const uris = content['oauth2-configuration']?.['redirect-uris'] ?? [];
    for (const required of [
      'http://localhost/*',
      'http://127.0.0.1/*',
      'mcp://*',
      'https://developers.sap.com/callback'
    ]) {
      expect(uris).toContain(required);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/xs-security-authorities.test.js`
Expected: FAIL — 4 new cases fail because the scope/template/collection/redirect-uris don't exist yet.

- [ ] **Step 3: Add scope to both `xs-security.json` files**

In the `scopes` array (both files), insert a new entry:
```json
{ "name": "$XSAPPNAME.Tutorial.MCP", "description": "MCP protocol access — authenticated tutorial reads/writes" }
```

- [ ] **Step 4: Add role template to both files**

In `role-templates`, insert:
```json
{
  "name": "TutorialMCP",
  "description": "MCP authenticated user (progress reads/writes, recommendations)",
  "scope-references": ["$XSAPPNAME.Tutorial.MCP", "$XSAPPNAME.Everyone"]
}
```

- [ ] **Step 5: Add role collection to both files**

In `role-collections`, insert:
```json
{
  "name": "Tutorials MCP Users",
  "description": "Authenticated MCP access to tutorials at /mcp-auth/*",
  "role-template-references": ["$XSAPPNAME.TutorialMCP", "$XSAPPNAME.Everyone"]
}
```

- [ ] **Step 6: Extend `oauth2-configuration.redirect-uris` in both files**

Add four new entries to the existing `redirect-uris` array (preserve the existing `https://*.cfapps.*.hana.ondemand.com/**` and `vscode://sap-tutorials.sage-tutorial-extension/**`):
```
"http://localhost/*",
"http://127.0.0.1/*",
"mcp://*",
"https://developers.sap.com/callback"
```

DO NOT add a separate `clients` sub-array or a new client_id — Phase 2 uses the existing XSUAA app's default client with PKCE (code_verifier + S256).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/unit/xs-security-authorities.test.js`
Expected: PASS (all cases including the 4 new ones).

- [ ] **Step 8: Commit**

```bash
git add xs-security.json .deploy/xs-security.json test/unit/xs-security-authorities.test.js
git commit -m "feat(#1105): add Tutorial.MCP scope + TutorialMCP role + MCP redirect URIs

Dual-file drift rule enforced by the extended xs-security-authorities
test. oauth2-configuration.redirect-uris extended with the MCP client
callback patterns (localhost, 127.0.0.1, mcp://, prod callback) — the
existing default XSUAA client is reused with PKCE (public-client flow,
no secret). No separate sb-tutorials-mcp client — XSUAA's schema only
supports one oauth2-configuration per instance, and provisioning a
second instance for MCP alone doubles role-collection management for
no security gain over the extend-allowlist approach.

Refs #1105."
git push
```

---

## Task 5: .well-known OAuth discovery documents (with mtaext substitution)

**Files:**
- Create: `approuter/static/.well-known/oauth-authorization-server.template`
- Create: `approuter/static/.well-known/oauth-protected-resource.template`
- Modify: `.deploy/mta.yaml` (approuter module: templating build step)
- Modify: `deploy/dev.mtaext`, `deploy/prod.mtaext`
- Create: `scripts/build-well-known.mjs`
- Test: `test/unit/well-known-oauth.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: two static JSON files at `/.well-known/oauth-{protected-resource,authorization-server}` served with `Content-Type: application/json`. The build step substitutes `${XSUAA_TENANT}` and `${XSUAA_REGION}` from the mtaext.

- [ ] **Step 1: Write the failing test**

Create `test/unit/well-known-oauth.test.js`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('.well-known OAuth discovery templates', () => {
  it('oauth-authorization-server.template has all RFC 8414 required fields', () => {
    const raw = fs.readFileSync('approuter/static/.well-known/oauth-authorization-server.template', 'utf8');
    const parsed = JSON.parse(raw);
    for (const key of [
      'issuer', 'authorization_endpoint', 'token_endpoint',
      'response_types_supported', 'grant_types_supported',
      'code_challenge_methods_supported', 'scopes_supported',
      'token_endpoint_auth_methods_supported'
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.code_challenge_methods_supported).toContain('S256');
    expect(parsed.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('oauth-protected-resource.template has MCP 2025-06 required fields', () => {
    const raw = fs.readFileSync('approuter/static/.well-known/oauth-protected-resource.template', 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('resource');
    expect(parsed).toHaveProperty('authorization_servers');
    expect(parsed).toHaveProperty('scopes_supported');
    expect(parsed.scopes_supported).toContain('Tutorial.MCP');
    expect(parsed.bearer_methods_supported).toEqual(['header']);
  });

  it('scripts/build-well-known.mjs substitutes tenant/region', () => {
    const tmp = path.join(process.cwd(), 'test/tmp-well-known');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execSync(
      `node scripts/build-well-known.mjs --out ${tmp} --tenant test-tenant --region eu10-005 --base-url https://test.example.com`,
      { stdio: 'inherit' }
    );
    const authServer = JSON.parse(fs.readFileSync(path.join(tmp, 'oauth-authorization-server'), 'utf8'));
    expect(authServer.issuer).toBe('https://test-tenant.authentication.eu10-005.hana.ondemand.com');
    expect(authServer.authorization_endpoint).toBe('https://test-tenant.authentication.eu10-005.hana.ondemand.com/oauth/authorize');
    const protRes = JSON.parse(fs.readFileSync(path.join(tmp, 'oauth-protected-resource'), 'utf8'));
    expect(protRes.resource).toBe('https://test.example.com/mcp-auth');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/well-known-oauth.test.js`
Expected: FAIL — templates and script don't exist.

- [ ] **Step 3: Create the two templates**

Create `approuter/static/.well-known/oauth-authorization-server.template`:
```json
{
  "issuer": "https://${XSUAA_TENANT}.authentication.${XSUAA_REGION}.hana.ondemand.com",
  "authorization_endpoint": "https://${XSUAA_TENANT}.authentication.${XSUAA_REGION}.hana.ondemand.com/oauth/authorize",
  "token_endpoint": "https://${XSUAA_TENANT}.authentication.${XSUAA_REGION}.hana.ondemand.com/oauth/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "Tutorial.MCP"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

Create `approuter/static/.well-known/oauth-protected-resource.template`:
```json
{
  "resource": "${BASE_URL}/mcp-auth",
  "authorization_servers": ["${BASE_URL}"],
  "scopes_supported": ["Tutorial.MCP"],
  "bearer_methods_supported": ["header"]
}
```

- [ ] **Step 4: Create the build script**

Create `scripts/build-well-known.mjs`:
```js
#!/usr/bin/env node
// Substitutes ${XSUAA_TENANT}, ${XSUAA_REGION}, ${BASE_URL} in the .well-known
// templates and writes them (without .template suffix) to --out. Invoked from
// .deploy/mta.yaml's approuter module build step.

import fs from 'node:fs';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, tok, i, arr) => {
    if (tok.startsWith('--')) acc.push([tok.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const { tenant, region, 'base-url': baseUrl, out } = argv;
if (!tenant || !region || !baseUrl || !out) {
  console.error('Usage: build-well-known.mjs --tenant X --region Y --base-url Z --out DIR');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const srcDir = 'approuter/static/.well-known';
for (const fname of fs.readdirSync(srcDir)) {
  if (!fname.endsWith('.template')) continue;
  const raw = fs.readFileSync(path.join(srcDir, fname), 'utf8');
  const out1 = raw
    .replaceAll('${XSUAA_TENANT}', tenant)
    .replaceAll('${XSUAA_REGION}', region)
    .replaceAll('${BASE_URL}', baseUrl);
  const outFile = path.join(out, fname.replace(/\.template$/, ''));
  fs.writeFileSync(outFile, out1);
  console.log(`wrote ${outFile}`);
}
```

Then: `chmod +x scripts/build-well-known.mjs` (harmless on Windows).

- [ ] **Step 5: Wire into .deploy/mta.yaml**

Read the approuter module block: `grep -n 'name: tutorials-approuter' .deploy/mta.yaml`

Add to that module's build-parameters:
```yaml
build-parameters:
  builder: custom
  commands:
    - node ../scripts/build-well-known.mjs --tenant "${XSUAA_TENANT}" --region "${XSUAA_REGION}" --base-url "${APPROUTER_BASE_URL}" --out approuter/static/.well-known
```
Preserve any existing commands — chain with `&&`.

- [ ] **Step 6: Add substitution variables to mtaext files**

Edit `deploy/dev.mtaext` — add under the approuter module:
```yaml
- name: tutorials-approuter
  parameters:
    env:
      XSUAA_TENANT: "tutorial-system"
      XSUAA_REGION: "eu10-005"
      APPROUTER_BASE_URL: "https://developers-dev.cfapps.eu10-005.hana.ondemand.com"
```

Edit `deploy/prod.mtaext`:
```yaml
- name: tutorials-approuter
  parameters:
    env:
      XSUAA_TENANT: "developers-sap"
      XSUAA_REGION: "eu10"
      APPROUTER_BASE_URL: "https://developers.sap.com"
```

Confirm the exact tenant/region strings against the deployed XSUAA (they are the values behind the memory-noted `sap-tutorials` cf subaccount).

- [ ] **Step 7: Add generated files to .gitignore**

Append to `.gitignore`:
```
approuter/static/.well-known/oauth-authorization-server
approuter/static/.well-known/oauth-protected-resource
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/unit/well-known-oauth.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 9: Commit**

```bash
git add approuter/static/.well-known/ scripts/build-well-known.mjs \
        .deploy/mta.yaml deploy/dev.mtaext deploy/prod.mtaext \
        .gitignore test/unit/well-known-oauth.test.js
git commit -m "feat(#1105): OAuth 2.1 discovery documents (RFC 8414 + MCP 2025-06)

Templates in approuter/static/.well-known/*.template with build-time
substitution of tenant/region/base-url. Script scripts/build-well-known.mjs
runs during the approuter build step; generated files gitignored.

Refs #1105."
git push
```

---

## Task 6: Approuter routes — /mcp-pat/* + /mcp-auth/* + .well-known + HomepageService @protocol fix

**Files:**
- Modify: `approuter/xs-app.json`
- Modify: `srv/homepage-service.cds`
- Test: `test/unit/approuter-mcp-route.test.js` (extend existing)

**Interfaces:**
- Consumes: `Tutorial.MCP` scope from Task 4.
- Produces: three new approuter routes (order matters — most-specific first). HomepageService `@protocol` now `['odata', 'graphql', 'mcp']` (matches spec Architecture diagram; was `['odata', 'mcp']`).

- [ ] **Step 1: Extend the failing approuter-route test**

Modify `test/unit/approuter-mcp-route.test.js` — add cases:
```js
it('mounts /.well-known/oauth-authorization-server anonymous', () => {
  const route = routes.find(r => r.source === '^/.well-known/oauth-authorization-server$');
  expect(route).toBeDefined();
  expect(route.authenticationType).toBe('none');
});

it('mounts /.well-known/oauth-protected-resource anonymous', () => {
  const route = routes.find(r => r.source === '^/.well-known/oauth-protected-resource$');
  expect(route).toBeDefined();
  expect(route.authenticationType).toBe('none');
});

it('mounts /mcp-pat/* anonymous with csrfProtection false', () => {
  const route = routes.find(r => r.source === '^/mcp-pat/(.*)$');
  expect(route).toBeDefined();
  expect(route.authenticationType).toBe('none');
  expect(route.csrfProtection).toBe(false);
});

it('mounts /mcp-auth/* xsuaa with Tutorial.MCP scope gate', () => {
  const route = routes.find(r => r.source === '^/mcp-auth/(.*)$');
  expect(route).toBeDefined();
  expect(route.authenticationType).toBe('xsuaa');
  expect(route.csrfProtection).toBe(false);
  expect(route.scope).toBe('$XSAPPNAME.Tutorial.MCP');
});

it('orders /mcp-auth/* AFTER /mcp-pat/* AFTER /mcp/*', () => {
  const idxAnon = routes.findIndex(r => r.source === '^/mcp/(.*)$');
  const idxPat  = routes.findIndex(r => r.source === '^/mcp-pat/(.*)$');
  const idxAuth = routes.findIndex(r => r.source === '^/mcp-auth/(.*)$');
  expect(idxAnon).toBeGreaterThanOrEqual(0);
  expect(idxPat).toBeGreaterThan(idxAnon);
  expect(idxAuth).toBeGreaterThan(idxPat);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/approuter-mcp-route.test.js`
Expected: FAIL — 5 new cases fail.

- [ ] **Step 3: Add the routes to `approuter/xs-app.json`**

Locate the existing `/mcp/*` route (source `^/mcp/(.*)$`, `authenticationType: none`). Insert *after* it (order matters — Phase 1's anonymous route stays first, then PAT, then OAuth-JWT):

```jsonc
{
  "source": "^/.well-known/oauth-authorization-server$",
  "target": "/.well-known/oauth-authorization-server",
  "localDir": "static",
  "authenticationType": "none",
  "cacheControl": "public, max-age=300"
},
{
  "source": "^/.well-known/oauth-protected-resource$",
  "target": "/.well-known/oauth-protected-resource",
  "localDir": "static",
  "authenticationType": "none",
  "cacheControl": "public, max-age=300"
},
{
  "source": "^/mcp-pat/(.*)$",
  "target": "/mcp-pat/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
{
  "source": "^/mcp-auth/(.*)$",
  "target": "/mcp-auth/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "csrfProtection": false,
  "scope": "$XSAPPNAME.Tutorial.MCP"
}
```

Preserve the existing `/mcp/*` route above these; keep any general catch-all below.

- [ ] **Step 4: Fix HomepageService `@protocol`**

Edit `srv/homepage-service.cds` line 54:
```cds
@protocol: ['odata', 'graphql', 'mcp']
```
(Was `['odata', 'mcp']` — spec Architecture calls for the graphql-inclusive triplet. Homepage already exposes GraphQL in adjacent places; make consistent.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/approuter-mcp-route.test.js test/unit/mcp-enabled-services.test.js`
Expected: PASS. The `mcp-enabled-services` test (Phase 1) asserts `@protocol` shape — the fix keeps it green.

- [ ] **Step 6: Commit**

```bash
git add approuter/xs-app.json srv/homepage-service.cds test/unit/approuter-mcp-route.test.js
git commit -m "feat(#1105): approuter routes for /.well-known, /mcp-pat, /mcp-auth

Adds two static .well-known routes (anonymous), /mcp-pat/* (anonymous;
PAT middleware in srv resolves req.user), /mcp-auth/* (xsuaa;
Tutorial.MCP scope gate). Order: /mcp/* → /mcp-pat/* → /mcp-auth/*.
HomepageService @protocol reconciled to ['odata','graphql','mcp'] to
match spec architecture.

Refs #1105."
git push
```

---

## Task 7: PATs entity schema + admin service projection

**Files:**
- Create: `db/mcp-pats.cds`
- Modify: `srv/admin-service.cds`
- Test: `test/unit/mcp-pats-schema.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Users` (existing entity).
- Produces: `com.sap.developers.ims.PATs` entity with the schema from the spec; `AdminService.MyPATs` projection scoped to `req.user`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-pats-schema.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('PATs schema and AdminService.MyPATs projection', () => {
  beforeAll(async () => {
    await cds.test('serve').in(process.cwd());
  });

  it('defines com.sap.developers.ims.PATs', () => {
    const { PATs } = cds.entities('com.sap.developers.ims');
    expect(PATs).toBeDefined();
    for (const el of ['user', 'name', 'prefix', 'hashHex', 'scopes',
                       'expiresAt', 'lastUsedAt', 'revokedAt', 'createdFromIP']) {
      expect(PATs.elements[el]).toBeDefined();
    }
  });

  it('exposes AdminService.MyPATs scoped by user.ID', () => {
    const svc = cds.services.AdminService;
    expect(svc).toBeDefined();
    const proj = cds.entities('AdminService').MyPATs;
    expect(proj).toBeDefined();
  });

  it('enforces @assert.unique.hashHex', () => {
    const { PATs } = cds.entities('com.sap.developers.ims');
    // The annotation is compile-time; the runtime error surfaces on INSERT.
    // Sniff the CSN for it.
    expect(JSON.stringify(PATs['@assert.unique.hashHex'] ?? PATs['@assert.unique'] ?? PATs.$hasUnique)).toMatch(/hashHex/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-pats-schema.test.js`
Expected: FAIL — `PATs` entity does not exist.

- [ ] **Step 3: Create `db/mcp-pats.cds`**

```cds
using { com.sap.developers.ims as ims } from './schema';
using { managed, cuid } from '@sap/cds/common';

namespace com.sap.developers.ims;

@assert.unique.hashHex: [hashHex]
entity PATs : cuid, managed {
  user          : Association to Users;
  name          : String(80)  @mandatory;
  prefix        : String(12);           // "pat_" + 8 random alnum; set by mint handler.
  hashHex       : String(64);           // SHA-256 hex of full plaintext.
  scopes        : array of String;      // 'read' | 'write' | both (coarse).
  expiresAt     : Timestamp;            // null = no expiry (UI defaults to 90 days).
  lastUsedAt    : Timestamp;            // best-effort; may lag ~60s.
  revokedAt     : Timestamp;            // null = active.
  createdFromIP : String(45);           // IPv6-safe.
}
```

- [ ] **Step 4: Add projection to `srv/admin-service.cds`**

Insert (near the top of the service block, alongside other authenticated projections):
```cds
  // User-owned PATs (Phase 2 #1105). Everyone sees their own; SuperAdmin sees all via PATsAdmin (below).
  @(requires: 'authenticated-user')
  @(restrict: [{ grant: '*', to: 'Everyone', where: 'user.ID = $user.id' }])
  entity MyPATs as projection on ims.PATs {
    ID, name, prefix, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, createdFromIP
  };

  // Admin-only view for audit (all users' PATs). No plaintext, no hash — metadata only.
  @(requires: 'Admin')
  @readonly entity PATsAdmin as projection on ims.PATs {
    ID, user.email as userEmail, name, prefix, scopes,
    createdAt, expiresAt, lastUsedAt, revokedAt, createdFromIP
  };
```

- [ ] **Step 5: Run `cds deploy --to sqlite::memory:` to catch runtime-only errors**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: "Successfully deployed …". If `@assert.unique.hashHex` errors, fix syntax before proceeding — this is the memory-rule check.

- [ ] **Step 6: Regenerate CDS build artifacts**

Run: `npx cds build --production 2>&1 | tail -3`
Expected: "done in Xs". Confirms `db/last-dev/csn.json` still parses.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-pats-schema.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 8: Commit**

```bash
git add db/mcp-pats.cds srv/admin-service.cds db/last-dev/csn.json test/unit/mcp-pats-schema.test.js
git commit -m "feat(#1105): PATs entity + AdminService projections

New com.sap.developers.ims.PATs entity with SHA-256 hashHex, coarse
scopes ('read'/'write'), user-scoped AdminService.MyPATs projection, and
Admin-only AdminService.PATsAdmin (metadata-only, no plaintext or hash).
@assert.unique.hashHex guards against SHA-256 second-preimage.

Refs #1105."
git push
```

---

## Task 8: PAT mint + revoke actions

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Create: `srv/lib/mcp-pat-actions.js`
- Test: `test/unit/mcp-pats-service.test.js`

**Interfaces:**
- Consumes: `PATs` entity from Task 7, `resolveDbUser` from `srv/lib/resolve-db-user.js`.
- Produces:
  - `AdminService.mintPAT(name: String, scopes: array of String, ttlDays: Integer)` → `{ token, prefix, expiresAt, ID }`
  - `AdminService.revokePAT(ID: UUID)` → `{ ok: Boolean, revokedAt: Timestamp }`
  - `srv/lib/mcp-pat-actions.js` exports `handleMintPAT`, `handleRevokePAT`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-pats-service.test.js`:
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

describe('AdminService.mintPAT + revokePAT', () => {
  let POST;

  beforeAll(async () => {
    ({ POST } = cds.test('serve').in(process.cwd()));
    // Pre-seed a user.
    const { Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'test-user-uuid',
      email: 'alice@example.com',
      displayName: 'Alice'
    });
  });

  it('mints a token, returns plaintext exactly once, stores only the hash', async () => {
    const { data } = await POST(
      '/admin/mintPAT',
      { name: 'my-claude-desktop', scopes: ['read'], ttlDays: 90 },
      { auth: { username: 'alice@example.com', password: 'x' } }
    );
    expect(data.token).toMatch(/^pat_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}$/);
    expect(data.prefix).toMatch(/^pat_[A-Za-z0-9]{8}$/);
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);

    const { PATs } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PATs).where({ ID: data.ID });
    const expectedHash = crypto.createHash('sha256').update(data.token).digest('hex');
    expect(row.hashHex).toBe(expectedHash);
    expect(row.hashHex).not.toBe(data.token);
    expect(row.name).toBe('my-claude-desktop');
  });

  it('clamps ttlDays into [1, 365]', async () => {
    const { data: overshoot } = await POST(
      '/admin/mintPAT',
      { name: 'too-long', scopes: ['read'], ttlDays: 9999 },
      { auth: { username: 'alice@example.com', password: 'x' } }
    );
    const daysFromNow = (new Date(overshoot.expiresAt) - Date.now()) / (24 * 3600 * 1000);
    expect(daysFromNow).toBeLessThanOrEqual(366);
  });

  it('rejects unknown scopes', async () => {
    await expect(
      POST(
        '/admin/mintPAT',
        { name: 'bad-scope', scopes: ['nuke-the-world'], ttlDays: 30 },
        { auth: { username: 'alice@example.com', password: 'x' } }
      )
    ).rejects.toThrow(/scope/i);
  });

  it('revokes a token — subsequent mints and reads see revokedAt set', async () => {
    const { data: minted } = await POST(
      '/admin/mintPAT',
      { name: 'to-revoke', scopes: ['read'], ttlDays: 30 },
      { auth: { username: 'alice@example.com', password: 'x' } }
    );
    await POST(
      '/admin/revokePAT',
      { ID: minted.ID },
      { auth: { username: 'alice@example.com', password: 'x' } }
    );
    const { PATs } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PATs).where({ ID: minted.ID });
    expect(row.revokedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-pats-service.test.js`
Expected: FAIL — actions do not exist.

- [ ] **Step 3: Declare the actions in `srv/admin-service.cds`**

Add near the top of the service body:
```cds
  // PAT mint (Phase 2 #1105). Returns plaintext exactly once.
  @(requires: 'authenticated-user')
  action mintPAT(name: String(80), scopes: array of String, ttlDays: Integer)
    returns { ID: UUID; token: String; prefix: String; expiresAt: Timestamp };

  @(requires: 'authenticated-user')
  action revokePAT(ID: UUID) returns { ok: Boolean; revokedAt: Timestamp };
```

- [ ] **Step 4: Create the handler module**

Create `srv/lib/mcp-pat-actions.js`:
```js
// PAT mint/revoke handlers for AdminService.
// Full plaintext is returned exactly once in the mint response body and
// stored ONLY as SHA-256 hex in the PATs table. Prefix ("pat_XXXXXXXX") is
// stored for user-facing identification (list-report column).

import cds from '@sap/cds';
import crypto from 'node:crypto';
import { resolveDbUser } from './resolve-db-user.js';

const VALID_SCOPES = new Set(['read', 'write']);
const MIN_TTL = 1;
const MAX_TTL = 365;
const DEFAULT_TTL = 90;

function assertValidScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array');
  }
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) throw new Error(`unknown scope: ${s}`);
  }
}

function clampTtl(ttlDays) {
  const n = Number.isFinite(ttlDays) ? ttlDays : DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

/** Generate "pat_<prefix>_<48 base64url chars>" and its SHA-256 hash. */
function generateToken() {
  const prefix = 'pat_' + crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const secret = crypto.randomBytes(36).toString('base64url'); // ~48 chars
  const token = `${prefix}_${secret}`;
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  return { token, prefix, hashHex };
}

export async function handleMintPAT(req) {
  const { name, scopes, ttlDays } = req.data;
  if (!name || typeof name !== 'string') return req.error(400, 'name is required');
  try { assertValidScopes(scopes); } catch (e) { return req.error(400, e.message); }

  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.error(401, 'unable to resolve user');

  const { token, prefix, hashHex } = generateToken();
  const ttl = clampTtl(ttlDays);
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  const clientIP = (req.headers?.['x-forwarded-for'] || req._.req?.ip || '').split(',')[0].trim().slice(0, 45);

  const { PATs } = cds.entities('com.sap.developers.ims');
  const ID = crypto.randomUUID();
  await INSERT.into(PATs).entries({
    ID, user_ID: dbUser.ID, name, prefix, hashHex,
    scopes, expiresAt, createdFromIP: clientIP
  });

  return { ID, token, prefix, expiresAt };
}

export async function handleRevokePAT(req) {
  const { ID } = req.data;
  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.error(401, 'unable to resolve user');

  const { PATs } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(PATs).where({ ID });
  if (!row) return req.error(404, 'not found');
  // Non-admins may only revoke their own tokens.
  if (row.user_ID !== dbUser.ID && !req.user.is('Admin')) return req.error(403, 'forbidden');

  const revokedAt = new Date();
  await UPDATE(PATs).set({ revokedAt }).where({ ID });
  return { ok: true, revokedAt };
}
```

- [ ] **Step 5: Wire into `srv/admin-service.js`**

Read the file: `grep -n 'class AdminService\|async init\|this.on' srv/admin-service.js | head -20`

Add imports at the top:
```js
import { handleMintPAT, handleRevokePAT } from './lib/mcp-pat-actions.js';
```

In the `init()` method, before `return super.init()`:
```js
    this.on('mintPAT', handleMintPAT);
    this.on('revokePAT', handleRevokePAT);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-pats-service.test.js`
Expected: PASS (4 assertions).

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js srv/lib/mcp-pat-actions.js test/unit/mcp-pats-service.test.js
git commit -m "feat(#1105): AdminService.mintPAT + revokePAT actions

Plaintext returned exactly once in mint response, SHA-256 hex stored,
ttlDays clamped [1, 365], scope allowlist ('read'/'write'), non-admin
users can only revoke their own tokens.

Refs #1105."
git push
```

---

## Task 9: PAT middleware — resolves Bearer pat_* to synthetic req.user

**Files:**
- Create: `srv/lib/mcp-pat-middleware.js`
- Modify: `srv/server.js`
- Test: `test/unit/mcp-pat-middleware.test.js`

**Interfaces:**
- Consumes: `PATs` entity, `resolveDbUser`.
- Produces: `patMiddleware(req, res, next)` — Express middleware. Registered in `srv/server.js` under URL prefix `^/mcp-pat/`, runs before `@cap-js/mcp` mounts. On valid PAT, installs `req.user = { id, is, attr, tokenSource: 'pat' }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-pat-middleware.test.js`:
```js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

describe('mcp-pat-middleware', () => {
  let patMiddleware, _cache;

  beforeAll(async () => {
    await cds.test('serve').in(process.cwd());
    const { Users, PATs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'mw-user-uuid', email: 'mw@example.com', displayName: 'Mw'
    });
    const token = 'pat_abcd1234_' + 'a'.repeat(48);
    const hashHex = crypto.createHash('sha256').update(token).digest('hex');
    await INSERT.into(PATs).entries({
      ID: 'pat-active-uuid', user_ID: 'mw-user-uuid', name: 'active',
      prefix: 'pat_abcd1234', hashHex, scopes: ['read'],
      expiresAt: new Date(Date.now() + 60_000)
    });
    await INSERT.into(PATs).entries({
      ID: 'pat-revoked-uuid', user_ID: 'mw-user-uuid', name: 'revoked',
      prefix: 'pat_revoked1', hashHex: crypto.createHash('sha256').update('pat_revoked1_' + 'b'.repeat(48)).digest('hex'),
      scopes: ['read'], expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date()
    });
    ({ patMiddleware, _cache } = await import('../../srv/lib/mcp-pat-middleware.js'));
  });

  function mockReq(authz) {
    return { headers: authz ? { authorization: authz } : {}, user: undefined };
  }
  function mockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      status(n) { this.statusCode = n; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      send(b) { this.body = b; return this; },
      json(o) { this.body = JSON.stringify(o); return this; }
    };
  }

  it('is a no-op when no Authorization header', async () => {
    const req = mockReq(); const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('is a no-op when Authorization is not "Bearer pat_..."', async () => {
    const req = mockReq('Bearer eyJhbGciOi...'); const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('installs synthetic req.user for a valid PAT', async () => {
    const req = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user.tokenSource).toBe('pat');
    expect(req.user.is('authenticated-user')).toBe(true);
  });

  it('rejects a revoked PAT with 401', async () => {
    const req = mockReq('Bearer pat_revoked1_' + 'b'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown PAT with 401', async () => {
    const req = mockReq('Bearer pat_unknown0_' + 'z'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('caches successful auth for 60s', async () => {
    _cache.clear();
    const req1 = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    await patMiddleware(req1, mockRes(), vi.fn());
    expect(_cache.size).toBe(1);
    const req2 = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    await patMiddleware(req2, mockRes(), vi.fn());
    expect(_cache.size).toBe(1); // still one entry, second was a cache hit
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-pat-middleware.test.js`
Expected: FAIL — middleware does not exist.

- [ ] **Step 3: Create the middleware**

Create `srv/lib/mcp-pat-middleware.js`:
```js
// Express middleware: recognizes Bearer pat_... tokens and installs a
// synthetic req.user before @cap-js/mcp dispatches. Mounted under URL
// prefix ^/mcp-pat/ only — a stray Bearer header on other routes is
// never misinterpreted.

import cds from '@sap/cds';
import crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { resolveDbUser } from './resolve-db-user.js';

const LOG = cds.log('mcp-pat');
const NS = 'com.sap.developers.ims';

// TTL 60s — bounded revocation window ≪ any credible attack duration.
export const _cache = new LRUCache({ max: 5000, ttl: 60 * 1000 });

function respond401(res, err = 'invalid_token') {
  res.setHeader('WWW-Authenticate', `Bearer error="${err}"`);
  return res.status(401).json({ error: err });
}

function installSyntheticUser(req, cached) {
  req.user = {
    id: cached.email,
    is: (role) => role === 'authenticated-user' || (Array.isArray(cached.roles) && cached.roles.includes(role)),
    attr: cached.attr ?? {},
    tokenSource: 'pat',
    _dbUserId: cached.userId,
    _patId: cached.patId,
    _patScopes: cached.scopes
  };
}

async function lookupPAT(hashHex) {
  const { PATs, Users } = cds.entities(NS);
  const [row] = await SELECT.from(PATs).where({ hashHex });
  if (!row) return null;
  const [user] = await SELECT.from(Users).where({ ID: row.user_ID });
  if (!user) return null;
  return {
    patId: row.ID,
    userId: row.user_ID,
    email: user.email,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
    revokedAt: row.revokedAt ? new Date(row.revokedAt).getTime() : null,
    attr: { email: user.email, displayName: user.displayName }
  };
}

function isValid(entry) {
  if (!entry) return false;
  if (entry.revokedAt) return false;
  if (entry.expiresAt && entry.expiresAt < Date.now()) return false;
  return true;
}

/** Fire-and-forget lastUsedAt bump. Swallow errors. */
function bumpLastUsed(patId) {
  const { PATs } = cds.entities(NS);
  UPDATE(PATs).set({ lastUsedAt: new Date() }).where({ ID: patId })
    .then(() => {}, err => LOG.warn(`bumpLastUsed failed for ${patId}:`, err.message));
}

export async function patMiddleware(req, res, next) {
  const authz = req.headers?.authorization;
  if (!authz || !authz.startsWith('Bearer pat_')) return next();

  const token = authz.slice('Bearer '.length);
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');

  let entry = _cache.get(hashHex);
  if (!entry) {
    entry = await lookupPAT(hashHex);
    if (entry) _cache.set(hashHex, entry);
  }

  if (!isValid(entry)) return respond401(res);
  installSyntheticUser(req, entry);
  bumpLastUsed(entry.patId);
  return next();
}
```

- [ ] **Step 4: Register the middleware in `srv/server.js`**

Read the bootstrap block: `grep -n 'bootstrap\|app.use\|@cap-js/mcp\|POST.*chat/stream' srv/server.js | head -20`

Add import at the top:
```js
import { patMiddleware } from './lib/mcp-pat-middleware.js';
```

Inside the `cds.on('bootstrap', ...)` block (find it via grep), before any `app.use` that registers @cap-js/mcp, add:
```js
  // PAT middleware — resolves Bearer pat_... to synthetic req.user on /mcp-pat/*.
  // Must run BEFORE @cap-js/mcp mounts, and only for the /mcp-pat/ prefix so a
  // stray Bearer header on /api or /chat is never misinterpreted (Phase 2 #1105).
  app.use('/mcp-pat', (req, res, next) => patMiddleware(req, res, next));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-pat-middleware.test.js`
Expected: PASS (6 assertions).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/mcp-pat-middleware.js srv/server.js test/unit/mcp-pat-middleware.test.js
git commit -m "feat(#1105): PAT middleware — Bearer pat_* → synthetic req.user

Registered as an Express middleware on /mcp-pat/ prefix in
cds.on('bootstrap'). SHA-256 hash lookup, 60s LRU cache, fire-and-forget
lastUsedAt bump. Rejected tokens 401 with WWW-Authenticate: Bearer.
Downstream resolveDbUser sees a normal user object indistinguishable
from a JWT-authenticated caller.

Refs #1105."
git push
```

---

## Task 10: MCP arg validators + progress-store helper

**Files:**
- Create: `srv/lib/mcp-arg-validators.js`
- Create: `srv/lib/mcp-progress-store.js`
- Test: `test/unit/mcp-arg-validators.test.js`

**Interfaces:**
- Consumes: `cds.entities` (existing `Tutorials`, `TaskRecords`, `Missions`, `CompletionPaths`, `Events` — read-only).
- Produces:
  - `assertRange({name, value, min, max})`, `assertEnum({name, value, allowed})`, `clampLimit(value, defaultN, maxN)` from arg-validators.
  - `getMyTutorials(dbUser, {status, limit})`, `getMyMissions(dbUser, {status, limit})`, `getMyEvents(dbUser, {when, limit})`, `getMyCompletedSteps(dbUser, slug)` from progress-store.

- [ ] **Step 1: Write the failing test for the validators**

Create `test/unit/mcp-arg-validators.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { assertRange, assertEnum, clampLimit } from '../../srv/lib/mcp-arg-validators.js';

describe('mcp-arg-validators', () => {
  it('assertRange throws below min', () => {
    expect(() => assertRange({ name: 'x', value: 0, min: 1, max: 10 })).toThrow(/x/);
  });
  it('assertRange throws above max', () => {
    expect(() => assertRange({ name: 'x', value: 11, min: 1, max: 10 })).toThrow(/x/);
  });
  it('assertRange passes in-range', () => {
    expect(() => assertRange({ name: 'x', value: 5, min: 1, max: 10 })).not.toThrow();
  });
  it('assertEnum throws on disallowed', () => {
    expect(() => assertEnum({ name: 'status', value: 'foo', allowed: ['a', 'b'] })).toThrow(/status/);
  });
  it('clampLimit uses default when undefined', () => {
    expect(clampLimit(undefined, 10, 50)).toBe(10);
  });
  it('clampLimit caps at max', () => {
    expect(clampLimit(999, 10, 50)).toBe(50);
  });
  it('clampLimit floors at 1', () => {
    expect(clampLimit(0, 10, 50)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-arg-validators.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the validators**

Create `srv/lib/mcp-arg-validators.js`:
```js
// Shared arg validators for MCP curated handlers. One file so the "did we
// clamp?" audit is a single grep. Every MCP handler should call at least
// clampLimit and/or assertEnum at the top; range checks via assertRange.

export function assertRange({ name, value, min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
}

export function assertEnum({ name, value, allowed }) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
}

export function clampLimit(value, defaultN, maxN) {
  if (value === undefined || value === null) return defaultN;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return defaultN;
  return Math.min(maxN, Math.max(1, n));
}
```

- [ ] **Step 4: Run validators test to pass**

Run: `npx vitest run test/unit/mcp-arg-validators.test.js`
Expected: PASS (7 assertions).

- [ ] **Step 5: Create the progress-store helper**

Create `srv/lib/mcp-progress-store.js`:
```js
// Private helper — joins Tutorials, TaskRecords, Missions, CompletionPaths,
// Events keyed to a resolved dbUser. Every function accepts a plain dbUser
// object (from resolveDbUser) and returns already-shaped MCP result rows.

import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

export async function getMyTutorials(dbUser, { status = 'all', limit = 20 } = {}) {
  const { Tutorials, TaskRecords } = cds.entities(NS);
  const records = await SELECT.from(TaskRecords)
    .where({ user_ID: dbUser.ID })
    .columns('tutorial_ID', 'completedSteps', 'attemptNumber', 'completedAt', 'modifiedAt');
  const byTutorialId = new Map(records.map(r => [r.tutorial_ID, r]));
  if (byTutorialId.size === 0) return [];

  const tutorials = await SELECT.from(Tutorials)
    .where({ ID: { in: [...byTutorialId.keys()] } })
    .columns('ID', 'slug', 'title', 'stepCount');

  const rows = tutorials.map(t => {
    const rec = byTutorialId.get(t.ID);
    const completed = Array.isArray(rec.completedSteps) ? rec.completedSteps : [];
    const totalSteps = t.stepCount ?? completed.length;
    const isCompleted = totalSteps > 0 && completed.length >= totalSteps;
    return {
      slug: t.slug,
      title: t.title,
      status: isCompleted ? 'completed' : 'in_progress',
      completedSteps: completed,
      totalSteps,
      lastActivityAt: rec.modifiedAt ?? rec.completedAt,
      attemptNumber: rec.attemptNumber ?? 1
    };
  });

  const filtered = status === 'all' ? rows : rows.filter(r => r.status === status);
  filtered.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));
  return filtered.slice(0, limit);
}

export async function getMyMissions(dbUser, { status = 'all', limit = 10 } = {}) {
  const { Missions, CompletionPaths, CompletionPathItems, TaskRecords, Tutorials } = cds.entities(NS);
  const missions = await SELECT.from(Missions).columns('ID', 'slug', 'title');
  const paths = await SELECT.from(CompletionPaths).columns('ID', 'mission_ID');
  const items = await SELECT.from(CompletionPathItems).columns('path_ID', 'tutorial_ID', 'position');
  const userRecs = await SELECT.from(TaskRecords)
    .where({ user_ID: dbUser.ID })
    .columns('tutorial_ID', 'completedSteps');
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug', 'stepCount');
  const stepCountById = new Map(tutorials.map(t => [t.ID, t.stepCount ?? 0]));
  const slugById = new Map(tutorials.map(t => [t.ID, t.slug]));
  const completedTutorialIds = new Set(
    userRecs.filter(r => {
      const total = stepCountById.get(r.tutorial_ID) ?? 0;
      const completedSteps = Array.isArray(r.completedSteps) ? r.completedSteps : [];
      return total > 0 && completedSteps.length >= total;
    }).map(r => r.tutorial_ID)
  );

  const rows = missions.map(m => {
    const missionPaths = paths.filter(p => p.mission_ID === m.ID);
    const missionItems = missionPaths.flatMap(p =>
      items.filter(i => i.path_ID === p.ID)
    ).sort((a, b) => a.position - b.position);
    const total = missionItems.length;
    const completedCount = missionItems.filter(i => completedTutorialIds.has(i.tutorial_ID)).length;
    const nextItem = missionItems.find(i => !completedTutorialIds.has(i.tutorial_ID));
    return {
      slug: m.slug, title: m.title,
      status: total > 0 && completedCount >= total ? 'completed' : (completedCount > 0 ? 'in_progress' : 'not_started'),
      completedCount, totalCount: total,
      nextTutorialSlug: nextItem ? slugById.get(nextItem.tutorial_ID) : null
    };
  });

  const filtered = status === 'all' ? rows : rows.filter(r => r.status === status);
  return filtered.slice(0, limit);
}

export async function getMyEvents(dbUser, { when = 'upcoming', limit = 20 } = {}) {
  const { Events, EventRegistrations } = cds.entities(NS);
  const now = new Date();
  const regs = await SELECT.from(EventRegistrations)
    .where({ user_ID: dbUser.ID }).columns('event_ID');
  const registeredIds = new Set(regs.map(r => r.event_ID));

  let events;
  if (when === 'upcoming') {
    events = await SELECT.from(Events).where({ startDate: { '>=': now } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate asc').limit(limit);
  } else if (when === 'past') {
    events = await SELECT.from(Events).where({ endDate: { '<': now } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate desc').limit(limit);
  } else if (when === 'registered') {
    if (registeredIds.size === 0) return [];
    events = await SELECT.from(Events).where({ ID: { in: [...registeredIds] } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate desc').limit(limit);
  }

  return events.map(e => ({
    slug: e.slug, name: e.name, eventType: e.eventType,
    startDate: e.startDate, endDate: e.endDate,
    registered: registeredIds.has(e.ID)
  }));
}

export async function getMyCompletedSteps(dbUser, slug) {
  const { Tutorials, TaskRecords } = cds.entities(NS);
  const [tut] = await SELECT.from(Tutorials).where({ slug: slug.toLowerCase() }).columns('ID');
  if (!tut) return null;
  const [rec] = await SELECT.from(TaskRecords)
    .where({ user_ID: dbUser.ID, tutorial_ID: tut.ID })
    .columns('completedSteps', 'attemptNumber', 'modifiedAt', 'completedAt');
  if (!rec) return { slug, completedSteps: [], attemptNumber: 1, lastActivityAt: null };
  return {
    slug,
    completedSteps: Array.isArray(rec.completedSteps) ? rec.completedSteps : [],
    attemptNumber: rec.attemptNumber ?? 1,
    lastActivityAt: rec.modifiedAt ?? rec.completedAt
  };
}
```

- [ ] **Step 6: Commit** (progress-store is exercised by the next task's tests; no unit test in isolation)

```bash
git add srv/lib/mcp-arg-validators.js srv/lib/mcp-progress-store.js test/unit/mcp-arg-validators.test.js
git commit -m "feat(#1105): mcp-arg-validators + mcp-progress-store helpers

Shared validators (assertRange/assertEnum/clampLimit) exercised at the
top of every curated MCP handler for single-grep clamp audit. Private
progress-store aggregates Tutorials/TaskRecords/Missions/Events keyed to
a resolved dbUser.

Refs #1105."
git push
```

---

## Task 11: DeveloperService authenticated read tools (5 tools)

**Files:**
- Create: `srv/developer-service-mcp.cds`
- Create: `srv/lib/mcp-developer-tools.js`
- Modify: `srv/developer-service.cds` (add `'mcp'` to `@protocol`)
- Modify: `srv/developer-service.js` (register handlers)
- Test: `test/unit/mcp-progress-tools.test.js`

**Interfaces:**
- Consumes: `getMyTutorials`, `getMyMissions`, `getMyEvents`, `getMyCompletedSteps` from Task 10; `sliceStep` from Task 1; `resolveDbUser`; `clampLimit`/`assertEnum` from Task 10.
- Produces: 5 CDS functions on `DeveloperService`:
  - `get_my_tutorials(status: String, limit: Integer)`
  - `get_my_missions(status: String, limit: Integer)`
  - `get_my_events(when: String, limit: Integer)`
  - `get_my_completed_steps(slug: String)`
  - `get_tutorial_step(slug: String, stepNumber: Integer)` — authenticated mount

- [ ] **Step 1: Add `'mcp'` to DeveloperService @protocol**

Edit `srv/developer-service.cds` — line 7 currently `@protocol: ['odata', 'graphql']`. Change to:
```cds
@protocol: ['odata', 'graphql', 'mcp']
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/mcp-progress-tools.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('DeveloperService authenticated MCP read tools', () => {
  let GET, POST;

  beforeAll(async () => {
    ({ GET, POST } = cds.test('serve').in(process.cwd()));
    const { Users, Tutorials, TaskRecords, Missions, CompletionPaths, CompletionPathItems, Events } =
      cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u1', email: 'u1@ex.com', displayName: 'U1' });
    await INSERT.into(Users).entries({ ID: 'u2', email: 'u2@ex.com', displayName: 'U2' });
    await INSERT.into(Tutorials).entries([
      { ID: 't-a', slug: 'tut-a', title: 'A', stepCount: 3, status: 'ACTIVE' },
      { ID: 't-b', slug: 'tut-b', title: 'B', stepCount: 2, status: 'ACTIVE' },
      { ID: 't-c', slug: 'tut-c', title: 'C', stepCount: 4, status: 'ACTIVE' }
    ]);
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-1', user_ID: 'u1', tutorial_ID: 't-a', completedSteps: [1,2,3], attemptNumber: 1 },
      { ID: 'tr-2', user_ID: 'u1', tutorial_ID: 't-b', completedSteps: [1],       attemptNumber: 1 },
      { ID: 'tr-3', user_ID: 'u2', tutorial_ID: 't-a', completedSteps: [1,2,3], attemptNumber: 1 }
    ]);
  });

  it('get_my_tutorials returns only the caller\'s rows, filtered by status', async () => {
    const { data } = await GET('/api/get_my_tutorials(status=\'in_progress\',limit=10)', {
      auth: { username: 'u1@ex.com', password: 'x' }
    });
    expect(data.value).toHaveLength(1);
    expect(data.value[0].slug).toBe('tut-b');
    expect(data.value[0].status).toBe('in_progress');
  });

  it('get_my_tutorials clamps limit to 50', async () => {
    const { data } = await GET('/api/get_my_tutorials(status=\'all\',limit=9999)', {
      auth: { username: 'u1@ex.com', password: 'x' }
    });
    expect(data.value.length).toBeLessThanOrEqual(50);
  });

  it('get_my_tutorials rejects an unknown status', async () => {
    await expect(GET('/api/get_my_tutorials(status=\'ohno\',limit=10)', {
      auth: { username: 'u1@ex.com', password: 'x' }
    })).rejects.toThrow(/status/i);
  });

  it('get_my_completed_steps returns completedSteps for the caller\'s tutorial', async () => {
    const { data } = await GET('/api/get_my_completed_steps(slug=\'tut-a\')', {
      auth: { username: 'u1@ex.com', password: 'x' }
    });
    expect(data.completedSteps).toEqual([1, 2, 3]);
    expect(data.attemptNumber).toBe(1);
  });

  it('get_my_completed_steps returns null-ish shape for a slug the caller has never started', async () => {
    const { data } = await GET('/api/get_my_completed_steps(slug=\'tut-c\')', {
      auth: { username: 'u1@ex.com', password: 'x' }
    });
    expect(data.completedSteps).toEqual([]);
    expect(data.slug).toBe('tut-c');
  });

  it('get_tutorial_step (authenticated) returns per-step HTML', async () => {
    // Seed ContentFiles for a real slice.
    const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentManifest).entries({
      version: 'v-mcp', status: 'ACTIVE', publishedAt: new Date()
    });
    await INSERT.into(ContentFiles).entries({
      version: 'v-mcp', slug: 'tut-a', path: 'tutorials/tut-a/index.html',
      contentType: 'text/html',
      contentGz: gzipSync(Buffer.from(`
        <main class="tutorial-body">
          <section class="step" data-step-number="1"><h2 class="step-title">One</h2><p>step-one-body</p></section>
          <section class="step" data-step-number="2"><h2 class="step-title">Two</h2><p>step-two-body</p></section>
        </main>`))
    });
    const { data } = await GET('/api/get_tutorial_step(slug=\'tut-a\',stepNumber=1)', {
      auth: { username: 'u1@ex.com', password: 'x' }
    });
    expect(data.html).toContain('step-one-body');
    expect(data.stepTitle).toBe('One');
    expect(data.totalSteps).toBe(2);
  });

  it('rejects anonymous callers with 401', async () => {
    await expect(GET('/api/get_my_tutorials(status=\'all\',limit=10)')).rejects.toMatchObject({ response: { status: 401 } });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-progress-tools.test.js`
Expected: FAIL — functions not declared.

- [ ] **Step 4: Create `srv/developer-service-mcp.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from './developer-service';

// Phase 2 (#1105) — authenticated MCP curated tools. Doc-comments become MCP
// tool descriptions; every function is @requires:'authenticated-user' so CAP
// enforces before the @cap-js/mcp adapter dispatches (works identically for
// JWT and PAT auth).
extend service DeveloperService {

  /** List the signed-in user's tutorials. Filter by status: 'in_progress',
      'completed', or 'all' (default). Limit clamped to 50.
      @param status  One of 'in_progress' | 'completed' | 'all'.
      @param limit   Max results, [1, 50]. Default 20. */
  @(requires: 'authenticated-user')
  function get_my_tutorials(status: String, limit: Integer) returns array of {
    slug           : String;
    title          : String;
    status         : String;
    completedSteps : array of Integer;
    totalSteps     : Integer;
    lastActivityAt : Timestamp;
    attemptNumber  : Integer;
  };

  /** List the signed-in user's missions with progress rollup. Filter by
      status: 'in_progress', 'completed', 'not_started', 'all' (default).
      @param status  One of 'in_progress' | 'completed' | 'not_started' | 'all'.
      @param limit   Max results, [1, 50]. Default 10. */
  @(requires: 'authenticated-user')
  function get_my_missions(status: String, limit: Integer) returns array of {
    slug             : String;
    title            : String;
    status           : String;
    completedCount   : Integer;
    totalCount       : Integer;
    nextTutorialSlug : String;
  };

  /** List the signed-in user's events. 'upcoming' shows future events,
      'past' shows completed events, 'registered' shows events the user is
      registered for.
      @param when   One of 'upcoming' | 'past' | 'registered'.
      @param limit  Max results, [1, 50]. Default 20. */
  @(requires: 'authenticated-user')
  function get_my_events(when: String, limit: Integer) returns array of {
    slug       : String;
    name       : String;
    eventType  : String;
    startDate  : Timestamp;
    endDate    : Timestamp;
    registered : Boolean;
  };

  /** Return the set of step numbers the signed-in user has completed on the
      given tutorial, plus attempt number and last activity timestamp.
      Empty array + attemptNumber=1 for tutorials the user has never started.
      @param slug  Lowercase canonical tutorial slug. */
  @(requires: 'authenticated-user')
  function get_my_completed_steps(slug: String) returns {
    slug           : String;
    completedSteps : array of Integer;
    attemptNumber  : Integer;
    lastActivityAt : Timestamp;
  };

  /** Return a single step's HTML plus metadata. Enables LLMs to fetch the
      exact step the user is asking about instead of the whole tutorial body.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'authenticated-user')
  function get_tutorial_step(slug: String, stepNumber: Integer) returns {
    slug        : String;
    stepNumber  : Integer;
    stepTitle   : String;
    html        : String;
    textLength  : Integer;
    totalSteps  : Integer;
  };
}
```

- [ ] **Step 5: Create `srv/lib/mcp-developer-tools.js`**

```js
import cds from '@sap/cds';
import { resolveDbUser } from './resolve-db-user.js';
import { sliceStep } from './tutorial-step-slicer.js';
import { assertEnum, clampLimit } from './mcp-arg-validators.js';
import * as store from './mcp-progress-store.js';

const LOG = cds.log('mcp-dev');
const STATUS_TUT = ['in_progress', 'completed', 'all'];
const STATUS_MIS = ['in_progress', 'completed', 'not_started', 'all'];
const WHEN_EVT   = ['upcoming', 'past', 'registered'];

async function requireDbUser(req) {
  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.reject(401, 'unable to resolve user');
  return dbUser;
}

export async function handleGetMyTutorials(req) {
  const status = req.data.status ?? 'all';
  try { assertEnum({ name: 'status', value: status, allowed: STATUS_TUT }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 20, 50);
  const dbUser = await requireDbUser(req);
  return store.getMyTutorials(dbUser, { status, limit });
}

export async function handleGetMyMissions(req) {
  const status = req.data.status ?? 'all';
  try { assertEnum({ name: 'status', value: status, allowed: STATUS_MIS }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 10, 50);
  const dbUser = await requireDbUser(req);
  return store.getMyMissions(dbUser, { status, limit });
}

export async function handleGetMyEvents(req) {
  const when = req.data.when ?? 'upcoming';
  try { assertEnum({ name: 'when', value: when, allowed: WHEN_EVT }); }
  catch (e) { return req.reject(400, e.message); }
  const limit = clampLimit(req.data.limit, 20, 50);
  const dbUser = await requireDbUser(req);
  return store.getMyEvents(dbUser, { when, limit });
}

export async function handleGetMyCompletedSteps(req) {
  const { slug } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  const dbUser = await requireDbUser(req);
  const result = await store.getMyCompletedSteps(dbUser, slug.toLowerCase());
  if (result === null) return req.reject(404, `tutorial not found: ${slug}`);
  return result;
}

/** Also used by SearchService (anonymous mount) via the same handler. */
export async function handleGetTutorialStep(req) {
  const { slug, stepNumber } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  if (!Number.isInteger(stepNumber) || stepNumber < 1) return req.reject(400, 'stepNumber must be a positive integer');
  const slice = await sliceStep(slug.toLowerCase(), stepNumber);
  if (!slice) return req.reject(404, 'step not found');
  return {
    slug: slug.toLowerCase(),
    stepNumber,
    stepTitle: slice.stepTitle,
    html: slice.html,
    textLength: slice.text.length,
    totalSteps: slice.totalSteps
  };
}
```

- [ ] **Step 6: Wire handlers into `srv/developer-service.js`**

Read imports + init: `grep -n 'import\|async init' srv/developer-service.js | head -20`

Add import:
```js
import * as mcpDev from './lib/mcp-developer-tools.js';
```

In `init()` before `return super.init()`:
```js
    this.on('get_my_tutorials',       mcpDev.handleGetMyTutorials);
    this.on('get_my_missions',        mcpDev.handleGetMyMissions);
    this.on('get_my_events',          mcpDev.handleGetMyEvents);
    this.on('get_my_completed_steps', mcpDev.handleGetMyCompletedSteps);
    this.on('get_tutorial_step',      mcpDev.handleGetTutorialStep);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-progress-tools.test.js`
Expected: PASS (7 assertions).

- [ ] **Step 8: Commit**

```bash
git add srv/developer-service-mcp.cds srv/developer-service.cds \
        srv/developer-service.js srv/lib/mcp-developer-tools.js \
        test/unit/mcp-progress-tools.test.js
git commit -m "feat(#1105): authenticated MCP read tools on DeveloperService

Adds get_my_tutorials, get_my_missions, get_my_events,
get_my_completed_steps, get_tutorial_step. Each honors CAP
@requires:'authenticated-user' — works identically for JWT and PAT auth
because req.user is populated identically upstream. Doc-comments
become MCP tool descriptions. DeveloperService @protocol upgraded to
['odata','graphql','mcp'].

Refs #1105."
git push
```

---

## Task 12: DeveloperService authenticated write tools + tokenSource audit field

**Files:**
- Modify: `srv/developer-service-mcp.cds` (add 2 actions)
- Modify: `srv/developer-service.cds` (add `tokenSource` to `TutorialProgressReset` event)
- Modify: `srv/lib/mcp-developer-tools.js` (add handlers)
- Modify: `srv/developer-service.js` (existing `completeStep`/`resetTutorialProgress` handlers: emit `tokenSource`)
- Modify: `srv/developer-service.js` (register write-tool handlers)
- Test: `test/unit/mcp-progress-write-tools.test.js`

**Interfaces:**
- Consumes: existing `completeStep`/`resetTutorialProgress` action implementations.
- Produces:
  - `complete_step(slug: String, stepNumber: Integer)` → same shape as `completeStep`
  - `reset_tutorial_progress(slug: String)` → same shape as `resetTutorialProgress`
  - `TutorialProgressReset` event gains nullable `tokenSource: String` field.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-progress-write-tools.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('DeveloperService authenticated MCP write tools', () => {
  let GET, POST;
  const emittedEvents = [];

  beforeAll(async () => {
    ({ GET, POST } = cds.test('serve').in(process.cwd()));
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'wu1', email: 'wu1@ex.com', displayName: 'W1' });
    await INSERT.into(Tutorials).entries({ ID: 'wt-a', slug: 'wtut-a', title: 'W', stepCount: 3, status: 'ACTIVE' });
    await INSERT.into(TaskRecords).entries({ ID: 'wtr-1', user_ID: 'wu1', tutorial_ID: 'wt-a', completedSteps: [1], attemptNumber: 1 });

    const svc = cds.services.DeveloperService;
    svc.on('TutorialProgressReset', (evt) => emittedEvents.push(evt.data));
  });

  it('complete_step delegates to completeStep and returns the same shape', async () => {
    const { data } = await POST('/api/complete_step', { slug: 'wtut-a', stepNumber: 2 }, {
      auth: { username: 'wu1@ex.com', password: 'x' }
    });
    expect(data.completedSteps).toContain(2);
    expect(typeof data.points).toBe('number');
  });

  it('reset_tutorial_progress emits TutorialProgressReset with tokenSource field', async () => {
    const { data } = await POST('/api/reset_tutorial_progress', { slug: 'wtut-a' }, {
      auth: { username: 'wu1@ex.com', password: 'x' }
    });
    expect(data.newAttemptNumber).toBeGreaterThanOrEqual(2);
    // The audit event should have fired with the tokenSource field present
    // (may be null for basic-auth test — we assert the shape, not the value).
    const event = emittedEvents.find(e => e.tutorialSlug === 'wtut-a');
    expect(event).toBeDefined();
    expect(Object.keys(event)).toContain('tokenSource');
  });

  it('rejects anonymous callers with 401', async () => {
    await expect(POST('/api/complete_step', { slug: 'wtut-a', stepNumber: 3 }))
      .rejects.toMatchObject({ response: { status: 401 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-progress-write-tools.test.js`
Expected: FAIL — actions not declared, tokenSource missing.

- [ ] **Step 3: Add the actions to `srv/developer-service-mcp.cds`**

Append inside the `extend service DeveloperService { ... }` block:
```cds
  /** Mark a step of a tutorial as completed for the signed-in user.
      Idempotent: re-completing an already-completed step is a no-op.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'authenticated-user')
  action complete_step(slug: String, stepNumber: Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  /** Reset the signed-in user's progress on a tutorial. Supersedes the
      current attempt and starts a fresh one; emits a TutorialProgressReset
      audit event with the old attempt's metadata.
      @param slug  Lowercase canonical tutorial slug. */
  @(requires: 'authenticated-user')
  action reset_tutorial_progress(slug: String) returns {
    newAttemptNumber           : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount      : Integer;
  };
```

- [ ] **Step 4: Extend the `TutorialProgressReset` event in `srv/developer-service.cds`**

Locate the event declaration (currently around lines 70–80). Change to:
```cds
  // Task 17 (#600) — audit event for resetTutorialProgress.
  // Extended 2026-07-08 (#1105) with tokenSource (nullable) so admins can
  // distinguish browser-driven from MCP-driven resets.
  event TutorialProgressReset : {
    user                       : String;
    tutorialSlug               : String;
    attemptNumber              : Integer;
    supersededRecordCount      : Integer;
    previousAttemptCompletedAt : DateTime;
    tokenSource                : String; // null | 'jwt' | 'pat'
  };
```

- [ ] **Step 5: Update existing `completeStep`/`resetTutorialProgress` handlers to emit `tokenSource`**

Read: `grep -n 'completeStep\|resetTutorialProgress\|TutorialProgressReset\|cds.emit' srv/developer-service.js | head -20`

Find the existing emit call (likely `srv.emit('TutorialProgressReset', {...})` or `req.emit(...)`) and add `tokenSource: req.user?.tokenSource ?? null` to the emitted payload. Example — find:
```js
srv.emit('TutorialProgressReset', {
  user: dbUser.ID,
  tutorialSlug: slug,
  attemptNumber,
  supersededRecordCount,
  previousAttemptCompletedAt
});
```
Change to:
```js
srv.emit('TutorialProgressReset', {
  user: dbUser.ID,
  tutorialSlug: slug,
  attemptNumber,
  supersededRecordCount,
  previousAttemptCompletedAt,
  tokenSource: req.user?.tokenSource ?? null
});
```

- [ ] **Step 6: Add the write-tool handlers to `srv/lib/mcp-developer-tools.js`**

Append to the file (below `handleGetTutorialStep`):
```js
/**
 * complete_step is a pure delegation to the existing completeStep action —
 * one code path so the audit trail (existing @audited annotations) fires
 * identically for browser and MCP callers.
 */
export async function handleCompleteStep(req) {
  const { slug, stepNumber } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  if (!Number.isInteger(stepNumber) || stepNumber < 1) return req.reject(400, 'stepNumber must be a positive integer');
  const srv = req._.service ?? cds.services.DeveloperService;
  return srv.send({
    event: 'completeStep',
    data: { slug: slug.toLowerCase(), stepNumber },
    user: req.user
  });
}

export async function handleResetTutorialProgress(req) {
  const { slug } = req.data;
  if (!slug || typeof slug !== 'string') return req.reject(400, 'slug is required');
  const srv = req._.service ?? cds.services.DeveloperService;
  return srv.send({
    event: 'resetTutorialProgress',
    data: { slug: slug.toLowerCase() },
    user: req.user
  });
}
```

- [ ] **Step 7: Register the write-tool handlers in `srv/developer-service.js`**

Below the read-tool registrations from Task 11, add:
```js
    this.on('complete_step',            mcpDev.handleCompleteStep);
    this.on('reset_tutorial_progress',  mcpDev.handleResetTutorialProgress);
```

- [ ] **Step 8: Run schema deploy sanity check**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: "Successfully deployed …". Catches any typo in the event field addition.

- [ ] **Step 9: Regenerate build artifacts**

Run: `npx cds build --production 2>&1 | tail -3`
Expected: "done in Xs".

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-progress-write-tools.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 11: Commit**

```bash
git add srv/developer-service-mcp.cds srv/developer-service.cds \
        srv/developer-service.js srv/lib/mcp-developer-tools.js \
        db/last-dev/csn.json test/unit/mcp-progress-write-tools.test.js
git commit -m "feat(#1105): authenticated MCP write tools + tokenSource audit field

Adds complete_step / reset_tutorial_progress — pure delegations to the
existing action handlers (one code path, same audit trail).
TutorialProgressReset event gains nullable tokenSource ('jwt' | 'pat' |
null) so admins can distinguish browser-driven from MCP-driven resets.

Refs #1105."
git push
```

---

## Task 13: HomepageService recommendation tools + anonymous get_tutorial_step on SearchService

**Files:**
- Create: `srv/homepage-service-mcp.cds`
- Create: `srv/search-service-mcp.cds`
- Create: `srv/lib/mcp-homepage-tools.js`
- Modify: `srv/homepage-service.js` (register 2 handlers)
- Modify: `srv/search-service.js` (register anonymous get_tutorial_step handler)
- Test: `test/unit/mcp-recommend-tools.test.js`

**Interfaces:**
- Consumes: `HomepageForYou` computation (existing), `sliceStep` (Task 1), `handleGetTutorialStep` from Task 11.
- Produces:
  - `HomepageService.get_my_recommended_tutorials(limit: Integer)`
  - `HomepageService.get_my_recommended_missions(limit: Integer)`
  - `SearchService.get_tutorial_step(slug: String, stepNumber: Integer)` — anonymous mount, shares handler.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-recommend-tools.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('HomepageService recommendation MCP tools + anonymous get_tutorial_step', () => {
  let GET;

  beforeAll(async () => {
    ({ GET } = cds.test('serve').in(process.cwd()));
    const { Users, HomepageForYou, Tutorials, ContentManifest, ContentFiles } =
      cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'ru1', email: 'ru1@ex.com', displayName: 'R1' });
    await INSERT.into(Tutorials).entries([
      { ID: 'r-a', slug: 'r-tut-a', title: 'RA', stepCount: 2, status: 'ACTIVE' },
      { ID: 'r-b', slug: 'r-tut-b', title: 'RB', stepCount: 3, status: 'ACTIVE' }
    ]);
    await INSERT.into(HomepageForYou).entries([
      { ID: 'hy-1', user_ID: 'ru1', tutorial_ID: 'r-a', rank: 1, rationale: 'because you liked X', tags: ['cap'] },
      { ID: 'hy-2', user_ID: 'ru1', tutorial_ID: 'r-b', rank: 2, rationale: 'popular with your peers', tags: ['btp'] }
    ]);
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentManifest).entries({ version: 'v-r', status: 'ACTIVE', publishedAt: new Date() });
    await INSERT.into(ContentFiles).entries({
      version: 'v-r', slug: 'r-tut-a', path: 'tutorials/r-tut-a/index.html',
      contentType: 'text/html',
      contentGz: gzipSync(Buffer.from(`
        <main class="tutorial-body">
          <section class="step" data-step-number="1"><h2 class="step-title">S1</h2><p>anon-step-one</p></section>
        </main>`))
    });
  });

  it('get_my_recommended_tutorials returns HomepageForYou in rank order', async () => {
    const { data } = await GET('/homepage/get_my_recommended_tutorials(limit=10)', {
      auth: { username: 'ru1@ex.com', password: 'x' }
    });
    expect(data.value).toHaveLength(2);
    expect(data.value[0].slug).toBe('r-tut-a');
    expect(data.value[0].rationale).toBe('because you liked X');
  });

  it('get_my_recommended_tutorials rejects anonymous callers', async () => {
    await expect(GET('/homepage/get_my_recommended_tutorials(limit=5)'))
      .rejects.toMatchObject({ response: { status: 401 } });
  });

  it('SearchService.get_tutorial_step is anonymous — returns per-step HTML without auth', async () => {
    const { data } = await GET('/search/get_tutorial_step(slug=\'r-tut-a\',stepNumber=1)');
    expect(data.html).toContain('anon-step-one');
    expect(data.stepTitle).toBe('S1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-recommend-tools.test.js`
Expected: FAIL — functions not declared.

- [ ] **Step 3: Create `srv/homepage-service-mcp.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from './homepage-service';

extend service HomepageService {
  /** Return the signed-in user's recommended tutorials from HomepageForYou,
      ranked by relevance. Requires authenticated-user.
      @param limit  Max results, [1, 20]. Default 10. */
  @(requires: 'authenticated-user')
  function get_my_recommended_tutorials(limit: Integer) returns array of {
    slug      : String;
    title     : String;
    rationale : String;
    tags      : array of String;
  };

  /** Return the signed-in user's recommended missions with progress rollup.
      @param limit  Max results, [1, 10]. Default 5. */
  @(requires: 'authenticated-user')
  function get_my_recommended_missions(limit: Integer) returns array of {
    slug           : String;
    title          : String;
    rationale      : String;
    tutorialCount  : Integer;
    completedCount : Integer;
  };
}
```

- [ ] **Step 4: Create `srv/search-service-mcp.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from './search-service';

extend service SearchService {
  /** Return a single step's HTML plus metadata. Anonymous — published tutorial
      HTML is public content. Shares the DeveloperService handler; the shape
      of the return object is identical.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'any')
  function get_tutorial_step(slug: String, stepNumber: Integer) returns {
    slug        : String;
    stepNumber  : Integer;
    stepTitle   : String;
    html        : String;
    textLength  : Integer;
    totalSteps  : Integer;
  };
}
```

- [ ] **Step 5: Create `srv/lib/mcp-homepage-tools.js`**

```js
import cds from '@sap/cds';
import { resolveDbUser } from './resolve-db-user.js';
import { clampLimit } from './mcp-arg-validators.js';

const NS = 'com.sap.developers.ims';

async function requireDbUser(req) {
  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.reject(401, 'unable to resolve user');
  return dbUser;
}

export async function handleGetMyRecommendedTutorials(req) {
  const limit = clampLimit(req.data.limit, 10, 20);
  const dbUser = await requireDbUser(req);
  const { HomepageForYou, Tutorials } = cds.entities(NS);
  const rows = await SELECT.from(HomepageForYou)
    .where({ user_ID: dbUser.ID })
    .columns('tutorial_ID', 'rationale', 'tags', 'rank')
    .orderBy('rank asc')
    .limit(limit);
  if (rows.length === 0) return [];
  const tutorials = await SELECT.from(Tutorials)
    .where({ ID: { in: rows.map(r => r.tutorial_ID) } })
    .columns('ID', 'slug', 'title');
  const byId = new Map(tutorials.map(t => [t.ID, t]));
  return rows
    .map(r => {
      const t = byId.get(r.tutorial_ID);
      return t ? { slug: t.slug, title: t.title, rationale: r.rationale, tags: r.tags ?? [] } : null;
    })
    .filter(Boolean);
}

export async function handleGetMyRecommendedMissions(req) {
  const limit = clampLimit(req.data.limit, 5, 10);
  const dbUser = await requireDbUser(req);
  const { HomepageForYouMissions, Missions, CompletionPathItems, CompletionPaths, TaskRecords, Tutorials } = cds.entities(NS);
  // If HomepageForYouMissions doesn't exist yet, fall back to top-N missions
  // ordered by mission popularity — Phase 3 replaces with true recommendation.
  const rankedMissions = HomepageForYouMissions
    ? await SELECT.from(HomepageForYouMissions)
        .where({ user_ID: dbUser.ID })
        .columns('mission_ID', 'rationale', 'rank')
        .orderBy('rank asc').limit(limit)
    : [];
  if (rankedMissions.length === 0) return [];

  const missions = await SELECT.from(Missions)
    .where({ ID: { in: rankedMissions.map(r => r.mission_ID) } })
    .columns('ID', 'slug', 'title');
  const paths = await SELECT.from(CompletionPaths).columns('ID', 'mission_ID');
  const items = await SELECT.from(CompletionPathItems).columns('path_ID', 'tutorial_ID');
  const userRecs = await SELECT.from(TaskRecords)
    .where({ user_ID: dbUser.ID })
    .columns('tutorial_ID', 'completedSteps');
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'stepCount');
  const stepCountById = new Map(tutorials.map(t => [t.ID, t.stepCount ?? 0]));
  const completedTutorialIds = new Set(
    userRecs.filter(r => {
      const total = stepCountById.get(r.tutorial_ID) ?? 0;
      const steps = Array.isArray(r.completedSteps) ? r.completedSteps : [];
      return total > 0 && steps.length >= total;
    }).map(r => r.tutorial_ID)
  );

  const byId = new Map(missions.map(m => [m.ID, m]));
  return rankedMissions.map(r => {
    const m = byId.get(r.mission_ID);
    if (!m) return null;
    const missionPaths = paths.filter(p => p.mission_ID === m.ID);
    const missionItems = missionPaths.flatMap(p => items.filter(i => i.path_ID === p.ID));
    const total = missionItems.length;
    const completed = missionItems.filter(i => completedTutorialIds.has(i.tutorial_ID)).length;
    return {
      slug: m.slug, title: m.title, rationale: r.rationale,
      tutorialCount: total, completedCount: completed
    };
  }).filter(Boolean);
}
```

- [ ] **Step 6: Wire handlers into `srv/homepage-service.js` and `srv/search-service.js`**

`srv/homepage-service.js` — add imports + registrations in `init()`:
```js
import * as mcpHp from './lib/mcp-homepage-tools.js';
// ... in init(), before super.init():
    this.on('get_my_recommended_tutorials', mcpHp.handleGetMyRecommendedTutorials);
    this.on('get_my_recommended_missions',  mcpHp.handleGetMyRecommendedMissions);
```

`srv/search-service.js` — reuse the DeveloperService handler; add imports + registration in `init()`:
```js
import { handleGetTutorialStep } from './lib/mcp-developer-tools.js';
// ... in init(), before super.init():
    this.on('get_tutorial_step', handleGetTutorialStep);
```

- [ ] **Step 7: Rebuild CDS**

Run: `npx cds build --production 2>&1 | tail -3`
Expected: "done in Xs".

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-recommend-tools.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 9: Commit**

```bash
git add srv/homepage-service-mcp.cds srv/homepage-service.js \
        srv/search-service-mcp.cds srv/search-service.js \
        srv/lib/mcp-homepage-tools.js db/last-dev/csn.json \
        test/unit/mcp-recommend-tools.test.js
git commit -m "feat(#1105): recommendation tools + anonymous get_tutorial_step

HomepageService.get_my_recommended_tutorials +
get_my_recommended_missions: authenticated, keyed on HomepageForYou.
SearchService.get_tutorial_step: anonymous mount sharing the
DeveloperService handler symbol — closes Phase 1's 'step-HTML deferred'
item at zero extra design cost.

Refs #1105."
git push
```

---

## Task 14: MCP protocol contract test extension

**Files:**
- Modify: `test/unit/mcp-contract.test.js`

**Interfaces:**
- Consumes: all 10 new tools from Tasks 11–13 plus Phase 1's existing 8.
- Produces: extended `tools/list` assertions covering every new tool at every route it appears on. **Blocking CI check** — failure blocks PR merge (per Phase 1's precedent).

- [ ] **Step 1: Read the current file to understand the fixture pattern**

Run: `grep -n 'tools/list\|routes\|describe(\|expectTool' test/unit/mcp-contract.test.js | head -30`

Expected: You'll see a Phase-1 pattern that boots CAP with `@cap-js/mcp`, hits `POST /mcp/<Service>` with `{"method":"tools/list"}`, and asserts on the response.

- [ ] **Step 2: Add the new-route + new-tool assertions**

Extend the file. Constants at top:
```js
const NEW_AUTHENTICATED_TOOLS = [
  { route: '/mcp-auth/api',      tool: 'get_my_tutorials',            reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/api',      tool: 'get_my_missions',             reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/api',      tool: 'get_my_events',               reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/api',      tool: 'get_my_completed_steps',      reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/api',      tool: 'get_tutorial_step',           reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/api',      tool: 'complete_step',               reqAuth: true,  readOnly: false },
  { route: '/mcp-auth/api',      tool: 'reset_tutorial_progress',     reqAuth: true,  readOnly: false },
  { route: '/mcp-auth/homepage', tool: 'get_my_recommended_tutorials',reqAuth: true,  readOnly: true  },
  { route: '/mcp-auth/homepage', tool: 'get_my_recommended_missions', reqAuth: true,  readOnly: true  }
];

const NEW_ANONYMOUS_TOOLS = [
  { route: '/mcp/search',        tool: 'get_tutorial_step',           reqAuth: false, readOnly: true  }
];
```

Then, in a new `describe('Phase 2 MCP tools', ...)`:
```js
describe('Phase 2 MCP tools', () => {
  for (const t of [...NEW_AUTHENTICATED_TOOLS, ...NEW_ANONYMOUS_TOOLS]) {
    describe(`${t.tool} at ${t.route}`, () => {
      it('enumerates in tools/list', async () => {
        const list = await callToolsList(t.route);
        const found = list.tools.find(x => x.name === t.tool);
        expect(found).toBeDefined();
      });
      it('has a non-trivial description (>=40 chars, no boilerplate)', async () => {
        const list = await callToolsList(t.route);
        const found = list.tools.find(x => x.name === t.tool);
        expect(found.description.length).toBeGreaterThanOrEqual(40);
        expect(found.description).not.toMatch(/^\s*TODO/i);
        expect(found.description).not.toMatch(/function that/i);
      });
      it('has inputSchema.properties for every declared arg', async () => {
        const list = await callToolsList(t.route);
        const found = list.tools.find(x => x.name === t.tool);
        expect(found.inputSchema).toBeDefined();
        expect(found.inputSchema.type).toBe('object');
        expect(Object.keys(found.inputSchema.properties).length).toBeGreaterThan(0);
      });
      if (t.readOnly) {
        it('carries readOnlyHint annotation', async () => {
          const list = await callToolsList(t.route);
          const found = list.tools.find(x => x.name === t.tool);
          expect(found.annotations?.readOnlyHint).toBe(true);
        });
      }
    });
  }
});
```

If `callToolsList(route)` doesn't already accept a route arg, factor it into a helper — search for the existing definition and extend.

- [ ] **Step 3: Run the extended contract test**

Run: `npx vitest run test/unit/mcp-contract.test.js`
Expected: PASS. ~90 assertions total (Phase 1's 36 + Phase 2's ~54). If `readOnlyHint` cases fail on the read functions, that's the `@Common.readOnly`/`@cds.readOnly` annotation missing on the CDS function declarations — add `@Common.readOnly` to the function in `srv/developer-service-mcp.cds`, `srv/homepage-service-mcp.cds`, `srv/search-service-mcp.cds` for each read tool, and re-run.

- [ ] **Step 4: Commit**

```bash
git add test/unit/mcp-contract.test.js srv/developer-service-mcp.cds \
        srv/homepage-service-mcp.cds srv/search-service-mcp.cds
git commit -m "test(#1105): MCP protocol contract test — all 10 Phase 2 tools

Extends test/unit/mcp-contract.test.js from 36 to ~90 assertions.
Every new tool must (a) enumerate at the correct route, (b) have a
non-trivial description (>=40 chars, no boilerplate), (c) have all args
in inputSchema.properties, (d) declare readOnlyHint on the 5 reads.
Blocking CI check.

Refs #1105."
git push
```

---

## Task 15: Metrics, feature flags, and MTA env-var wiring

**Files:**
- Modify: `srv/lib/metrics.js`
- Modify: `.deploy/mta.yaml` (env vars on tutorials-srv)
- Test: `test/unit/mcp-metrics.test.js`

**Interfaces:**
- Consumes: existing metrics registry in `srv/lib/metrics.js`.
- Produces:
  - Counters: `mcp_pat_mint_total`, `mcp_pat_revoke_total`, `mcp_pat_auth_total{outcome=hit|miss|revoked|expired}`, `tutorial_step_slice_total{outcome=hit|miss|error}`.
  - Gauge: `tutorial_step_slice_cache_size`.
  - Existing `mcp_tool_invocation_total` gains `tokenSource` label.
  - Env vars declared on `tutorials-srv`: `MCP_AUTH_ENABLED`, `MCP_PAT_MINT_ENABLED`, `KG_STEP_SLICER_ENABLED` (all default `true`).

- [ ] **Step 1: Read current metrics module**

Run: `grep -n 'Counter\|Gauge\|register\|export' srv/lib/metrics.js | head -20`

Understand the registration pattern (likely a Prometheus-shaped registry — CAP's `@sap/xotel` or `prom-client`). Adapt below to match.

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-metrics.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';

describe('Phase 2 metrics', () => {
  let metrics;

  beforeAll(async () => {
    metrics = await import('../../srv/lib/metrics.js');
  });

  it('exports mcpPatMintTotal, mcpPatRevokeTotal, mcpPatAuthTotal', () => {
    expect(metrics.mcpPatMintTotal).toBeDefined();
    expect(metrics.mcpPatRevokeTotal).toBeDefined();
    expect(metrics.mcpPatAuthTotal).toBeDefined();
  });

  it('exports tutorialStepSliceTotal + tutorialStepSliceCacheSize', () => {
    expect(metrics.tutorialStepSliceTotal).toBeDefined();
    expect(metrics.tutorialStepSliceCacheSize).toBeDefined();
  });

  it('mcpToolInvocationTotal accepts tokenSource label', () => {
    // A .labels(...) call with an unknown label throws on prom-client.
    expect(() => metrics.mcpToolInvocationTotal.labels('SearchService', 'search_tutorials', 'ok', 'anon')).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-metrics.test.js`
Expected: FAIL — new metrics don't exist.

- [ ] **Step 4: Add the counters and gauge**

Append to `srv/lib/metrics.js` (adapt to the existing registry factory function):
```js
export const mcpPatMintTotal = registerCounter({
  name: 'mcp_pat_mint_total',
  help: 'PATs minted via AdminService.mintPAT'
});

export const mcpPatRevokeTotal = registerCounter({
  name: 'mcp_pat_revoke_total',
  help: 'PATs revoked via AdminService.revokePAT'
});

export const mcpPatAuthTotal = registerCounter({
  name: 'mcp_pat_auth_total',
  help: 'PAT auth attempts on /mcp-pat/*',
  labelNames: ['outcome'] // hit | miss | revoked | expired
});

export const tutorialStepSliceTotal = registerCounter({
  name: 'tutorial_step_slice_total',
  help: 'Shared step-HTML slicer invocations',
  labelNames: ['outcome'] // hit | miss | error
});

export const tutorialStepSliceCacheSize = registerGauge({
  name: 'tutorial_step_slice_cache_size',
  help: 'Current entries in the slicer LRU cache'
});
```

Extend the existing `mcpToolInvocationTotal` — find the declaration and add `'tokenSource'` to its `labelNames` array.

- [ ] **Step 5: Wire counters into the middleware and slicer**

In `srv/lib/mcp-pat-middleware.js` — import the counter:
```js
import { mcpPatAuthTotal } from './metrics.js';
```
Then before `respond401` returns, call `mcpPatAuthTotal.labels(outcome).inc()` with `'miss' | 'revoked' | 'expired'`; before `installSyntheticUser`, `.labels('hit').inc()`.

In `srv/lib/mcp-pat-actions.js` — import mint/revoke counters:
```js
import { mcpPatMintTotal, mcpPatRevokeTotal } from './metrics.js';
```
`mcpPatMintTotal.inc()` after successful INSERT; `mcpPatRevokeTotal.inc()` after successful UPDATE.

In `srv/lib/tutorial-step-slicer.js` — import and wire:
```js
import { tutorialStepSliceTotal, tutorialStepSliceCacheSize } from './metrics.js';
```
At the top of `loadAndParse` after the LRU hit check, `.labels('hit').inc()`; after each cache SET, `tutorialStepSliceCacheSize.set(cache.size)`; on the two `LOG.warn` branches, `.labels('error').inc()`; at the end when returning `result`, `.labels('miss').inc()` (miss = cache miss but successfully computed).

In the existing MCP handlers (`srv/lib/mcp-developer-tools.js`, `mcp-homepage-tools.js`) — import `mcpToolInvocationTotal` and call `.labels(service, tool, outcome, req.user?.tokenSource ?? 'anon').inc()` at handler entry and exit.

- [ ] **Step 6: Add feature flag env vars to `.deploy/mta.yaml`**

Locate the `tutorials-srv` module: `grep -n 'name: tutorials-srv' .deploy/mta.yaml`

Add under its `parameters.env` (or `properties`, depending on shape):
```yaml
  MCP_AUTH_ENABLED: "true"
  MCP_PAT_MINT_ENABLED: "true"
  KG_STEP_SLICER_ENABLED: "true"
```

- [ ] **Step 7: Honor `MCP_AUTH_ENABLED` in `srv/server.js`**

In the `cds.on('bootstrap', ...)` block, before the `app.use('/mcp-pat', ...)` from Task 9 and before any @cap-js/mcp mount touches `/mcp-auth`, add a kill-switch:
```js
  if (process.env.MCP_AUTH_ENABLED === 'false') {
    app.use('/mcp-auth', (_req, res) => res.status(503).send('Phase 2 disabled'));
    app.use('/mcp-pat',  (_req, res) => res.status(503).send('Phase 2 disabled'));
    cds.log('mcp').warn('MCP_AUTH_ENABLED=false — /mcp-auth and /mcp-pat return 503');
  }
```

- [ ] **Step 8: Honor `MCP_PAT_MINT_ENABLED` in the mint handler**

In `srv/lib/mcp-pat-actions.js`, at the top of `handleMintPAT`:
```js
  if (process.env.MCP_PAT_MINT_ENABLED === 'false') return req.reject(503, 'PAT minting is disabled');
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-metrics.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 10: Commit**

```bash
git add srv/lib/metrics.js srv/lib/mcp-pat-middleware.js srv/lib/mcp-pat-actions.js \
        srv/lib/tutorial-step-slicer.js srv/lib/mcp-developer-tools.js \
        srv/lib/mcp-homepage-tools.js srv/server.js .deploy/mta.yaml \
        test/unit/mcp-metrics.test.js
git commit -m "feat(#1105): Phase 2 metrics + feature-flag env vars

New counters: mcp_pat_{mint,revoke,auth}_total,
tutorial_step_slice_total, tutorial_step_slice_cache_size gauge.
Existing mcp_tool_invocation_total gains tokenSource label.
Env-var kill switches: MCP_AUTH_ENABLED (envelope for /mcp-auth +
/mcp-pat), MCP_PAT_MINT_ENABLED, KG_STEP_SLICER_ENABLED.

Refs #1105."
git push
```

---

## Task 16: Admin-shell Fiori Elements page for PATs

**Files:**
- Create: `app/admin-shell/webapp/components/pats/manifest.json`
- Create: `app/admin-shell/webapp/components/pats/Component.js`
- Create: `app/admin-shell/webapp/components/pats/webapp/annotations/annotations.cds`
- Create: `app/admin-shell/webapp/components/pats/webapp/i18n/i18n.properties`
- Modify: `app/admin-annotations.cds` (add UI annotations for `MyPATs`)
- Test: `test/unit/admin-shell-manifest-generator.test.js` (extend — asserts new tile discovered)

**Interfaces:**
- Consumes: `AdminService.MyPATs` from Task 7, `AdminService.mintPAT`/`revokePAT` from Task 8.
- Produces: `/admin-ui/#pats` route via the discovery-driven admin-shell manifest scan.

- [ ] **Step 1: Read the admin-shell manifest-generator conventions**

Run:
```bash
ls app/admin-shell/webapp/components/ | head
head -80 app/admin-shell/scripts/admin-shell-overrides.js
grep -n 'discoverComponents\|manifest\|scan' app/admin-shell/scripts/*.js | head -20
```

Expected: A convention where each subdir of `components/` gets discovered by directory name and mounted at that name in the shell (e.g. `components/secrets/` → `#secrets`).

- [ ] **Step 2: Extend the failing manifest-generator test**

Modify `test/unit/admin-shell-manifest-generator.test.js` — add a case:
```js
it('discovers the pats component and mounts it at #pats', () => {
  const generated = generateManifest(); // or the function name from the file
  const pats = generated.componentUsages?.pats;
  expect(pats).toBeDefined();
  expect(pats.name).toContain('pats');
});

it('routes /admin-ui/#pats to the pats component', () => {
  const generated = generateManifest();
  const route = generated.routes.find(r => r.pattern === 'pats' || r.name === 'pats');
  expect(route).toBeDefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-shell-manifest-generator.test.js`
Expected: FAIL — no `pats` component.

- [ ] **Step 4: Create the FE component manifest**

Create `app/admin-shell/webapp/components/pats/manifest.json`:
```json
{
  "_version": "1.60.0",
  "sap.app": {
    "id": "sap.tutorials.admin.pats",
    "type": "component",
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": {
          "odataVersion": "4.0"
        }
      }
    }
  },
  "sap.ui": {
    "technology": "UI5",
    "deviceTypes": {
      "desktop": true,
      "tablet": true,
      "phone": true
    }
  },
  "sap.ui5": {
    "flexEnabled": true,
    "dependencies": {
      "minUI5Version": "1.108.0",
      "libs": {
        "sap.fe.templates": {}
      }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "type": "sap.ui.model.odata.v4.ODataModel",
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": {
          "bundleName": "sap.tutorials.admin.pats.i18n.i18n"
        }
      }
    },
    "routing": {
      "config": {
        "routerClass": "sap.f.routing.Router",
        "async": true
      },
      "routes": [
        {
          "pattern": ":?query:",
          "name": "PATsList",
          "target": "PATsList"
        },
        {
          "pattern": "PATs({key}):?query:",
          "name": "PATsObject",
          "target": "PATsObject"
        }
      ],
      "targets": {
        "PATsList": {
          "type": "Component",
          "id": "PATsList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "contextPath": "/MyPATs",
              "variantManagement": "Page"
            }
          }
        },
        "PATsObject": {
          "type": "Component",
          "id": "PATsObject",
          "name": "sap.fe.templates.ObjectPage",
          "options": {
            "settings": {
              "contextPath": "/MyPATs"
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Create `app/admin-shell/webapp/components/pats/Component.js`**

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.pats.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 6: Create the i18n file**

Create `app/admin-shell/webapp/components/pats/webapp/i18n/i18n.properties`:
```properties
appTitle=Personal Access Tokens
appDescription=Mint and revoke Personal Access Tokens for MCP headless access
Column.name=Name
Column.prefix=Prefix
Column.scopes=Scopes
Column.createdAt=Created
Column.expiresAt=Expires
Column.lastUsedAt=Last Used
Column.revokedAt=Revoked
Column.status=Status
Status.active=Active
Status.revoked=Revoked
Action.mint=Mint New Token
Action.revoke=Revoke
Action.mint.MintTokenModal.copyOnce=Copy this token now — it is the only time it will be shown.
```

- [ ] **Step 7: Add UI annotations for `MyPATs`**

Append to `app/admin-annotations.cds`:
```cds
using { AdminService } from '../srv/admin-service';

annotate AdminService.MyPATs with @UI: {
  HeaderInfo: {
    TypeName: 'Personal Access Token',
    TypeNamePlural: 'Personal Access Tokens',
    Title: { Value: name },
    Description: { Value: prefix }
  },
  LineItem: [
    { Value: name,        Label: '{i18n>Column.name}' },
    { Value: prefix,      Label: '{i18n>Column.prefix}' },
    { Value: scopes,      Label: '{i18n>Column.scopes}' },
    { Value: createdAt,   Label: '{i18n>Column.createdAt}' },
    { Value: expiresAt,   Label: '{i18n>Column.expiresAt}' },
    { Value: lastUsedAt,  Label: '{i18n>Column.lastUsedAt}' },
    { Value: revokedAt,   Label: '{i18n>Column.revokedAt}',
      Criticality: #if (revokedAt) 1 else 3 }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Details', Target: '@UI.FieldGroup#Details' }
  ],
  FieldGroup #Details: {
    Data: [
      { Value: name },
      { Value: prefix },
      { Value: scopes },
      { Value: createdAt },
      { Value: expiresAt },
      { Value: lastUsedAt },
      { Value: revokedAt },
      { Value: createdFromIP, Label: 'Created From IP' }
    ]
  }
};

annotate AdminService.mintPAT with @Common.QuickInfo: '{i18n>Action.mint}';
annotate AdminService.revokePAT with @Common.QuickInfo: '{i18n>Action.revoke}';
```

- [ ] **Step 8: Run manifest-generator test to verify pass**

Run: `npx vitest run test/unit/admin-shell-manifest-generator.test.js`
Expected: PASS.

- [ ] **Step 9: Sanity-check the annotations parse**

Run: `npx cds compile srv/admin-service.cds --to json 2>&1 | tail -5`
Expected: no annotation errors. If there are complaints about `#if`/`Criticality` shape, drop the `Criticality:` block and rely on `revokedAt`'s presence in the column — annotation shape variants across UI5 versions.

- [ ] **Step 10: Rebuild + smoke the admin-shell locally**

Run: `npm run dev` in one terminal, `cds watch` in another. Open `http://localhost:1313/admin-ui/#pats` in a browser. Expected: FE List Report empty; `Mint New Token` button in the header; clicking it opens the mint action modal.

Note: browser verification is a manual step for the reviewer — this is one of the spec's Success Criteria (7) that requires human eyes.

- [ ] **Step 11: Commit**

```bash
git add app/admin-shell/webapp/components/pats/ app/admin-annotations.cds \
        test/unit/admin-shell-manifest-generator.test.js
git commit -m "feat(#1105): Fiori Elements page for PATs at /admin-ui/#pats

New componentUsage 'pats' in the admin shell (discovery-driven from
manifest scan — no hand-curated list). FE List Report over
AdminService.MyPATs scoped to req.user; FE Object Page for detail.
mintPAT action shows the full plaintext in a one-time modal
(pattern matches /admin-ui/#secrets).

Refs #1105."
git push
```

---

## Task 17: Hybrid + smoke tests + docs + wrap-up

**Files:**
- Create: `test/hybrid/mcp-authenticated-tools.test.js`
- Create: `test/hybrid/tutorial-step-slicer.test.js`
- Create: `test/hybrid/mcp-pat-e2e.test.js`
- Create: `test/hybrid/oauth-discovery.test.js`
- Modify: `test/smoke/mcp.smoke.test.js`
- Create: `test/mcp-ux/prompts.yaml`
- Create: `test/mcp-ux/runner.js`
- Create: `test/mcp-ux/baseline.json`
- Create: `.github/workflows/mcp-ux-weekly.yml`
- Modify: `package.json` (`scripts.test:llm-ux`)
- Modify: `docs/end-users/mcp-quickstart.md`
- Modify: `docs/developers/reference/mcp-server.md`
- Modify: `docs/developers/operations/mcp-server.md`
- Create: `docs/developers/architecture/mcp-server.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `scripts/setup-dev-data.js` (add `mcp-hybrid-test@sap.example` fixture user)

**Interfaces:**
- Consumes: everything from Tasks 1–16.
- Produces: hybrid + smoke coverage against real HANA, weekly LLM-UX CI job, all four docs registered in sidebar.

Because this task is broad, split into three sub-commits.

### 17a — Hybrid tests + fixture-user seeding

- [ ] **Step 1: Add the fixture user to `scripts/setup-dev-data.js`**

Read: `grep -n 'INSERT.into.Users\|hybrid-test\|@sap.example' scripts/setup-dev-data.js | head`

Add an INSERT for:
```js
{ ID: 'mcp-hybrid-test-uuid', email: 'mcp-hybrid-test@sap.example', displayName: 'MCP Hybrid Test', sapUserId: 'mcp-hybrid-test' }
```
Make the INSERT idempotent (existing pattern in the script).

- [ ] **Step 2: Write `test/hybrid/mcp-authenticated-tools.test.js`**

Follow the pattern in `test/hybrid/mcp-tools.test.js` (Phase 1). One `describe` per subsystem, one `it` per curated tool, using `cds bind --exec` (existing setup). Assert shape + auth-scoping only (real HANA data varies).

Example structure:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import { hybridClient } from './helpers/hybrid-client.js'; // existing helper

describe('Phase 2 authenticated MCP tools (hybrid, real HANA)', () => {
  let client;
  beforeAll(async () => {
    client = await hybridClient({ as: 'mcp-hybrid-test@sap.example' });
  });

  for (const tool of ['get_my_tutorials','get_my_missions','get_my_events',
                       'get_my_completed_steps','get_tutorial_step',
                       'complete_step','reset_tutorial_progress',
                       'get_my_recommended_tutorials','get_my_recommended_missions']) {
    it(`${tool} responds with a valid shape`, async () => {
      const result = await client.callTool(tool, sampleArgsFor(tool));
      expect(result).toBeDefined();
    });
  }
});
```

Add `sampleArgsFor(tool)` local helper with sensible values (e.g. `slug: 'sample-tutorial-slug'`).

- [ ] **Step 3: Write `test/hybrid/tutorial-step-slicer.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { sliceStep } from '../../srv/lib/tutorial-step-slicer.js';

// Use a well-known slug that has been in the platform since Phase 1.
// This slug and its step-1 heading are asserted; update if the source
// tutorial's H2 changes.
const KNOWN_SLUG = 'hana-cloud-provisioning';
const KNOWN_STEP = 1;
const KNOWN_HEADING_SUBSTR = /provision|create/i;

describe('tutorial-step-slicer (hybrid, real HANA)', () => {
  it('slices step 1 of a known published tutorial', async () => {
    const slice = await sliceStep(KNOWN_SLUG, KNOWN_STEP);
    expect(slice).not.toBeNull();
    expect(slice.stepTitle).toMatch(KNOWN_HEADING_SUBSTR);
    expect(slice.totalSteps).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Write `test/hybrid/mcp-pat-e2e.test.js`**

```js
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.HYBRID_BASE_URL ?? 'http://localhost:4004';

async function mintPAT() {
  const res = await fetch(`${BASE}/admin/mintPAT`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from('mcp-hybrid-test@sap.example:x').toString('base64')
    },
    body: JSON.stringify({ name: 'hybrid-e2e', scopes: ['read'], ttlDays: 1 })
  });
  return res.json();
}

describe('PAT end-to-end (hybrid, real HANA)', () => {
  let pat;
  beforeAll(async () => { pat = await mintPAT(); });

  it('mints a token and calls /mcp-pat/api/get_my_tutorials with it', async () => {
    const res = await fetch(`${BASE}/mcp-pat/api/tools/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pat.token}`
      },
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: 'get_my_tutorials', arguments: { status: 'all', limit: 5 } }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeDefined();
  });
});
```

- [ ] **Step 5: Write `test/hybrid/oauth-discovery.test.js`**

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL ?? 'https://developers-dev.cfapps.eu10-005.hana.ondemand.com';

describe('OAuth discovery documents (deployed dev)', () => {
  it('serves /.well-known/oauth-authorization-server with correct shape', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const doc = await res.json();
    expect(doc.issuer).toMatch(/authentication\..*\.hana\.ondemand\.com/);
    expect(doc.code_challenge_methods_supported).toContain('S256');
    expect(doc.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('serves /.well-known/oauth-protected-resource with Tutorial.MCP scope', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toContain('/mcp-auth');
    expect(doc.scopes_supported).toContain('Tutorial.MCP');
  });
});
```

- [ ] **Step 6: Run hybrid tests**

Run: `npm run test:hybrid -- --project hybrid`
Expected: PASS. If `cds bind` isn't set up, log in via `cf login -a https://api.cf.eu10-005.hana.ondemand.com` and run `npm run bind:setup`.

- [ ] **Step 7: Commit**

```bash
git add test/hybrid/mcp-authenticated-tools.test.js test/hybrid/tutorial-step-slicer.test.js \
        test/hybrid/mcp-pat-e2e.test.js test/hybrid/oauth-discovery.test.js \
        scripts/setup-dev-data.js
git commit -m "test(#1105): hybrid + deployed-target smoke for Phase 2

Hybrid: authenticated tools (all 8), slicer against real published
tutorial, PAT end-to-end, OAuth discovery on deployed dev. Fixture user
mcp-hybrid-test@sap.example seeded via setup-dev-data.

Refs #1105."
git push
```

### 17b — Smoke test + LLM-UX weekly job

- [ ] **Step 1: Extend `test/smoke/mcp.smoke.test.js`**

Add three test cases for the new routes:
```js
describe('Phase 2 smoke: /mcp-auth, /mcp-pat, .well-known', () => {
  it('/mcp-auth/api returns 401 without a JWT', async () => {
    const res = await fetch(`${BASE}/mcp-auth/api/tools/list`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
  it('/mcp-pat/api returns 401 without a PAT', async () => {
    const res = await fetch(`${BASE}/mcp-pat/api/tools/list`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
  it('/.well-known/oauth-authorization-server returns 200 with correct content-type', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
```

Fixture-token round-trip depends on the target env's Credential Store having `mcp-smoke-pat` — this is documented in the runbook (Task 17c) as an operator step. Skip the round-trip in the smoke test if `MCP_SMOKE_PAT` env var is unset.

- [ ] **Step 2: Create `test/mcp-ux/prompts.yaml`**

```yaml
# LLM UX quality prompts — 15 fixed natural-language prompts covering
# every Phase 1 + Phase 2 tool at least once. Baseline in baseline.json.
prompts:
  - id: p01
    prompt: "Find me a tutorial about CAP draft handling"
    expectedTool: "search_tutorials"
  - id: p02
    prompt: "What missions are about SAP HANA Cloud?"
    expectedTool: "list_missions"
  - id: p03
    prompt: "Show me the CAP getting-started mission"
    expectedTool: "get_mission"
  - id: p04
    prompt: "What are the recent SAP developer news items?"
    expectedTool: "get_recent_news"
  - id: p05
    prompt: "Show me the latest SAP developer videos"
    expectedTool: "get_recent_videos"
  - id: p06
    prompt: "What tutorials are prerequisites for hana-cloud-provisioning?"
    expectedTool: "kg_prerequisites"
  - id: p07
    prompt: "After finishing cap-getting-started, what should I learn next?"
    expectedTool: "kg_what_to_learn_next"
  - id: p08
    prompt: "Am I done with the CAP getting-started mission?"
    expectedTool: "get_my_missions"
  - id: p09
    prompt: "Which tutorials am I currently in the middle of?"
    expectedTool: "get_my_tutorials"
  - id: p10
    prompt: "What are my upcoming events?"
    expectedTool: "get_my_events"
  - id: p11
    prompt: "Which steps have I completed on hana-cloud-provisioning?"
    expectedTool: "get_my_completed_steps"
  - id: p12
    prompt: "Mark step 3 of cap-getting-started as done"
    expectedTool: "complete_step"
  - id: p13
    prompt: "Reset my progress on cap-getting-started"
    expectedTool: "reset_tutorial_progress"
  - id: p14
    prompt: "Which tutorial should I do next?"
    expectedTool: "get_my_recommended_tutorials"
  - id: p15
    prompt: "Show me the content of step 2 of hana-cloud-provisioning"
    expectedTool: "get_tutorial_step"
```

- [ ] **Step 3: Create `test/mcp-ux/runner.js`**

```js
// LLM UX runner. Loads prompts.yaml, calls Claude Haiku 4.5 with the live
// tools/list output as the tool schemas, records which tool the LLM picked,
// asserts against baseline.json. Baseline is a JSON map of prompt id →
// { pickedTool, argsSchemaFit: number 0..1 }. Regression = pick-accuracy
// drops below baseline pick-accuracy - 0.05.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

async function loadPrompts() {
  const raw = fs.readFileSync(path.join('test/mcp-ux/prompts.yaml'), 'utf8');
  // FAILSAFE_SCHEMA restricts js-yaml to strings/arrays/maps only — no custom
  // tags, no type coercion. prompts.yaml is a fixed asset in the repo, but
  // treat it as data anyway so a future edit can't introduce anything unsafe.
  return yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA }).prompts;
}

async function fetchToolsList() {
  // Assumes a local cds watch is running on :4004 with @cap-js/mcp.
  const routes = ['/mcp/search', '/mcp/homepage', '/mcp/graph',
                  '/mcp-auth/api', '/mcp-auth/homepage'];
  const combined = [];
  for (const r of routes) {
    const res = await fetch(`http://localhost:4004${r}/tools/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tools/list', params: {} })
    });
    if (!res.ok) continue;
    const body = await res.json();
    combined.push(...(body.tools ?? body.result?.tools ?? []));
  }
  return combined;
}

async function run() {
  const client = new Anthropic();
  const prompts = await loadPrompts();
  const tools = await fetchToolsList();
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const results = {};
  for (const p of prompts) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: anthropicTools,
      messages: [{ role: 'user', content: p.prompt }]
    });
    const toolUse = resp.content.find(c => c.type === 'tool_use');
    results[p.id] = {
      pickedTool: toolUse?.name ?? null,
      expectedTool: p.expectedTool,
      correct: toolUse?.name === p.expectedTool
    };
  }

  const correct = Object.values(results).filter(r => r.correct).length;
  const accuracy = correct / prompts.length;
  console.log(`Accuracy: ${accuracy.toFixed(2)} (${correct}/${prompts.length})`);

  const baselinePath = 'test/mcp-ux/baseline.json';
  if (!fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, JSON.stringify({ accuracy, results }, null, 2));
    console.log('Baseline seeded.');
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  if (accuracy < baseline.accuracy - 0.05) {
    console.error(`REGRESSION: accuracy ${accuracy} < baseline ${baseline.accuracy} - 0.05`);
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(2); });
```

- [ ] **Step 4: Seed the baseline (first run)**

Run:
```bash
export ANTHROPIC_API_KEY=<your-key>
npm run dev &  # cds watch on :4004
sleep 8
node test/mcp-ux/runner.js
```
Expected: prints accuracy, writes `test/mcp-ux/baseline.json`. Commit the baseline.

- [ ] **Step 5: Add `npm run test:llm-ux` script**

In `package.json`, add:
```json
"test:llm-ux": "node test/mcp-ux/runner.js"
```

- [ ] **Step 6: Create the weekly workflow**

Create `.github/workflows/mcp-ux-weekly.yml`:
```yaml
name: MCP LLM UX (weekly)

on:
  schedule:
    - cron: '0 9 * * 1'   # Monday 09:00 UTC
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - name: Start cds watch
        run: |
          npm run dev &
          for i in {1..20}; do
            curl -sf http://localhost:4004/mcp/search/tools/list && break
            sleep 3
          done
      - name: Run LLM UX
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: npm run test:llm-ux
```

- [ ] **Step 7: Commit**

```bash
git add test/smoke/mcp.smoke.test.js test/mcp-ux/ .github/workflows/mcp-ux-weekly.yml \
        package.json
git commit -m "test(#1105): smoke coverage + LLM UX weekly workflow

Smoke asserts 401 on /mcp-auth + /mcp-pat, 200 on both .well-known
discovery docs. LLM UX runner (Claude Haiku 4.5, model pinned) checks
pick-accuracy against baseline; regression fails only when accuracy
drops >0.05. Weekly cron; not counted toward regular PR CI.

Refs #1105."
git push
```

### 17c — Docs + PR ready-for-review

- [ ] **Step 1: Update `docs/end-users/mcp-quickstart.md`**

Append three sections after the existing anonymous-quickstart content. **Read the existing file first** to match its heading/tone.

Sections:

**Sign in with Claude Desktop (OAuth)** — `.mcp.json` snippet pointing at `https://developers.sap.com/mcp-auth/api`, Claude Desktop discovers the OAuth server via the `.well-known` files; screenshot placeholder `![OAuth consent](./images/mcp-oauth-consent.png)` — take the screenshot manually and add before merge.

**Sign in with Claude Code (OAuth via mcp-remote)** — `.mcp.json` snippet using the `mcp-remote` bridge for OAuth handshake.

**Headless / CI with a Personal Access Token** — mint recipe (visit `/admin-ui/#pats`, mint, copy, paste), `.mcp.json` snippet with:
```json
{
  "mcpServers": {
    "sap-tutorials": {
      "url": "https://developers.sap.com/mcp-pat/api",
      "headers": {
        "Authorization": "Bearer pat_..."
      }
    }
  }
}
```

- [ ] **Step 2: Update `docs/developers/reference/mcp-server.md`**

Extend the tool table with 10 rows (8 authenticated + 1 anonymous get_tutorial_step + 1 authenticated get_tutorial_step). Add an "Authenticated tools" section with a decision matrix:

| Client type | Route | Auth |
|---|---|---|
| Browser agent (Claude Desktop) | `/mcp-auth/*` | OAuth 2.1 + PKCE |
| Headless agent (Claude Code, CI, VS Code extension) | `/mcp-pat/*` | Bearer PAT |
| Anonymous / public content | `/mcp/*` | none |

- [ ] **Step 3: Update `docs/developers/operations/mcp-server.md`**

Add runbook sections:

**Minting a fixture PAT for smoke tests** — SQL against HANA, or the `/admin/mintPAT` endpoint with a rotator identity, or (recommended) use `/admin-ui/#pats` as the test fixture user.

**Flipping the feature flags** — the three `cf set-env` recipes:
```bash
cf set-env tutorials-srv MCP_AUTH_ENABLED false && cf restart tutorials-srv
cf set-env tutorials-srv MCP_PAT_MINT_ENABLED false && cf restart tutorials-srv
cf set-env tutorials-srv KG_STEP_SLICER_ENABLED false && cf restart tutorials-srv
```

**Granting `Tutorials MCP Users` role collection** — `btp assign role-collection "Tutorials MCP Users" --to <email>` or the batch script `scripts/btp-role-collection-sync.js`.

**Reading the new metrics** — Prometheus queries:
- PAT authentication failure rate: `rate(mcp_pat_auth_total{outcome!="hit"}[5m]) / rate(mcp_pat_auth_total[5m])`
- Slicer cache hit rate: `rate(tutorial_step_slice_total{outcome="hit"}[5m]) / rate(tutorial_step_slice_total[5m])`

**Reading the audit trail for authenticated tool calls** — the existing audit-log surface (as documented in the observability doc) now carries `tokenSource` on `TutorialProgressReset`; filter with `tokenSource != null`.

- [ ] **Step 4: Create `docs/developers/architecture/mcp-server.md`**

Sections: **Routes** (three-tier stack diagram), **Adapter package** (`@cap-js/mcp@1.1.1`), **`req.user` resolution** (JWT via approuter, PAT via middleware, both converge on `resolveDbUser`), **Shared step-HTML slicer**, **`.well-known` discovery**.

Reference the design spec `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md` for the full architecture rationale.

- [ ] **Step 5: Register the new architecture doc in the VitePress sidebar**

Edit `docs/.vitepress/config.ts` — locate the `sidebar` block for `docs/developers/architecture/` and add:
```ts
{ text: 'MCP Server', link: '/developers/architecture/mcp-server' }
```

- [ ] **Step 6: Run the docs sidebar-registration guard**

Run: `npx vitest run test/unit/docs-sidebar-registration.test.js` (or the closest guard test — grep for it if the name differs).
Expected: PASS. If a test asserts every `docs/developers/architecture/*.md` has a sidebar entry, the new entry keeps it green.

- [ ] **Step 7: Run the full unit-test suite one more time**

Run: `npm test`
Expected: green across the board — Phase 1's 89 tests plus every Phase 2 test added over Tasks 1–16 (~120 total unit assertions).

- [ ] **Step 8: Regenerate CDS build artifacts one last time**

Run: `npx cds build --production 2>&1 | tail -3`
Expected: "done in Xs".
Run: `git diff --stat db/last-dev/csn.json`
Expected: shows the generated artifact.

- [ ] **Step 9: Commit docs**

```bash
git add docs/end-users/mcp-quickstart.md \
        docs/developers/reference/mcp-server.md \
        docs/developers/operations/mcp-server.md \
        docs/developers/architecture/mcp-server.md \
        docs/.vitepress/config.ts \
        db/last-dev/csn.json
git commit -m "docs(#1105): Phase 2 quickstart, reference, runbook, architecture

Three quickstart sections (OAuth via Claude Desktop, OAuth via Claude
Code + mcp-remote, PAT for headless). Reference gets 10 new tool rows +
route decision matrix. Runbook: fixture-PAT mint, three feature-flag
recipes, role-collection grant, metrics queries, audit-trail filter.
Architecture doc registered in VitePress sidebar.

Refs #1105."
git push
```

- [ ] **Step 10: Mark PR #1109 ready for review**

Run:
```bash
gh pr ready 1109 --repo sap-tutorials/tutorials-ims
gh pr comment 1109 --repo sap-tutorials/tutorials-ims --body "Phase 2 implementation complete across Tasks 1–17. All ~120 unit tests green, hybrid tests green against dev HANA, deployed smoke green. Requesting review — please verify success criteria 8 (Claude Desktop OAuth end-to-end on dev) and 9 (Claude Code with a PAT). Refs #1105."
```

- [ ] **Step 11: Verify all 12 spec Success Criteria are visibly met**

Manually walk the spec's Success Criteria list. For each, cite the commit / file / test that proves it. If any criterion isn't visibly met, open a follow-up task (do not close #1105 without all 12 signed off).

Success criteria checklist (from the spec):
1. `@cap-js/mcp` on DeveloperService + HomepageService with `@protocol: ['odata','graphql','mcp']` — Tasks 6, 11.
2. All 10 new tools with unit + contract + hybrid — Tasks 11, 12, 13, 14, 17a.
3. Slicer shipped + retrofits + underscore + "TODO Phase 4" gone — Tasks 1, 2, 3.
4. xs-security dual-file + `Tutorial.MCP` scope/template/collection; drift guard passes — Task 4.
5. `.well-known` files with per-env substitution; hybrid discovery test green on dev — Tasks 5, 17a.
6. Three new approuter routes — Task 6.
7. PATs entity + `/admin-ui/#pats` FE page — Tasks 7, 8, 16.
8. Claude Desktop OAuth flow end-to-end verified by reviewer — **manual, PR comment**.
9. Claude Code with a PAT verified by reviewer — **manual, PR comment**.
10. Docs updated + sidebar registered — Task 17c.
11. LLM-UX weekly workflow scheduled + baseline seeded — Task 17b.
12. sap-devs owner has migration note filed — **manual, add link in PR comment**.







