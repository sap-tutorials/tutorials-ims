# Server-side Catalog Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/tutorials/group-*` and `/tutorials/mission-*` rendering from the GitHub-fetch → Hugo build → publish-content pipeline into the CAP backend so admin edits show up immediately, with chrome byte-identical to today's Hugo output.

**Architecture:** A new CAP-side renderer (`catalog-renderer.js`) composes a Hugo-emitted chrome shell (uploaded as the `__shell__` ContentFiles slug) around DB-rendered body markup. The existing LRU cache holds rendered HTML keyed by `render:<slug>`, invalidated by both publish (existing) and AdminService writes (new piggyback on the existing navigator-cache invalidator).

**Tech Stack:** Node.js + CAP (`@sap/cds`), Vitest, Hugo 0.147.7, vanilla TS for the breadcrumb island (no Vue runtime needed), HANA Cloud / SQLite.

**Spec:** [docs/superpowers/specs/2026-05-28-server-side-catalog-rendering-design.md](../specs/2026-05-28-server-side-catalog-rendering-design.md)
**Issue:** [sap-tutorials/tutorials-ims#91](https://github.com/sap-tutorials/tutorials-ims/issues/91)
**Branch:** `feature/server-side-catalog-rendering` (already created)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `srv/lib/catalog-data.js` | NEW | Pure DB access: `loadGroupContext(slug)`, `loadMissionContext(slug)`. No HTML, no HTTP. |
| `srv/lib/catalog-renderer.js` | NEW | Pure body rendering: `renderGroupBody(ctx)`, `renderMissionBody(ctx)`, `renderCatalogPage(slug, deps)`. Replaces `render-catalog-page.js`. |
| `srv/lib/chrome-shell.js` | NEW | Loads `__shell__` BLOB, parses on `<!-- MAIN -->`, caches by manifest version, composes full HTML. |
| `srv/lib/render-catalog-page.js` | DELETE | Today's stripped fallback. Removed in step 4. |
| `srv/lib/content-store.js` | MODIFY | Add `cache.invalidateByPrefix()`. Replace `renderCatalogPage` import. New serveHandler branch wires through new renderer. |
| `srv/server.js` | MODIFY | Piggyback render-cache invalidation onto the existing `admin.after(...)` hook (line ~228). Mount `/build/breadcrumb-context`. |
| `srv/lib/breadcrumb-context.js` | NEW | Handler for `GET /build/breadcrumb-context?tutorial=<slug>`. |
| `scripts/publish-content.ts` | MODIFY | After existing `__nav__`/`__404__` injection, read `hugo/public/_shell/index.html`, slice `<main>...</main>`, upload as `__shell__`. |
| `scripts/fetch-tutorials.ts` | MODIFY | Phase 4: keep mission/group title+slug lookups for tutorial-frontmatter breadcrumb data; delete `writeMissionPage`/`writeGroupPage` and all surrounding aggregations. |
| `hugo/layouts/_shell/single.html` | NEW | Minimal layout that renders `baseof.html` chrome around `<!-- MAIN -->`. |
| `hugo/content/_shell/_index.md` | NEW | Stub content file so Hugo materializes `public/_shell/index.html`. |
| `hugo/layouts/groups/single.html` | DELETE | Replaced by `catalog-renderer.js` body output. |
| `hugo/layouts/missions/single.html` | DELETE | Replaced by `catalog-renderer.js` body output. |
| `hugo/layouts/partials/breadcrumbs.html` | MODIFY | Add `data-bc-role="mission"`, `data-bc-role="group"`, `data-bc-role-link` attrs. |
| `hugo-apps/src/tutorial-breadcrumbs/main.ts` | NEW | Vanilla TS island, fetches `/build/breadcrumb-context`, overwrites parent `<li>` text + href. |
| `hugo-apps/vite.config.ts` | MODIFY | Add `tutorial-breadcrumbs` rollup input. |
| `hugo/layouts/_default/baseof.html` | MODIFY | Add `<script>` tag for `tutorial-breadcrumbs.js` (only when page-kind=tutorial). |
| `test/catalog-renderer.test.js` | NEW | Unit: body markup parity, NEW badge, escaping, empty-tutorials. |
| `test/chrome-shell.test.js` | NEW | Unit: parse, compose, marker validation, escape. |
| `test/catalog-data.test.js` | NEW | Unit using `cds.test('serve', ..., '--in-memory')`: query shape, ordering, published/status filters. |
| `test/render-catalog-page.test.js` | DELETE | Tests the file being deleted. Replaced by tests above. |
| `test/hybrid/catalog-renderer-hana.test.js` | NEW | Hybrid: real HANA, real `__shell__` BLOB, validates LOB locator handling. |
| `test/smoke/catalog-pages.test.js` | NEW | Smoke: `/tutorials/group-test-two` returns full chrome + body, `X-Content-Source: rendered`. |
| `scripts/parity-check.js` | NEW (TEMP) | One-time DEV before/after structural diff. Deleted before merge. |

---

## Task 1: catalog-data.js — pure DB access

**Files:**
- Create: `srv/lib/catalog-data.js`
- Create: `test/catalog-data.test.js`

The renderer needs the same fields the Hugo template reads, so both group/mission body output can match `hugo/layouts/groups/single.html` and `hugo/layouts/missions/single.html` parity targets. This file owns *all* DB lookups; the renderer never touches `cds.entities`.

- [ ] **Step 1: Write the failing test**

Mirror the `cds.test('serve', '--project', '.', '--in-memory')` pattern from [test/admin-slug-history.test.js](../../test/admin-slug-history.test.js). Test fixtures should be `__TEST__`-prefixed per the project hybrid-write convention.

```js
// test/catalog-data.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { loadGroupContext, loadMissionContext } from '../srv/lib/catalog-data.js';

cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-cd00-0000-0000-000000000001';
const GROUP_ID = 'bbbbbbbb-cd00-0000-0000-000000000001';
const MISSION_ID = 'dddddddd-cd00-0000-0000-000000000001';
const PATH_ID = 'eeeeeeee-cd00-0000-0000-000000000001';
const TUT1_ID = 'cccccccc-cd00-0000-0000-000000000001';
const TUT2_ID = 'cccccccc-cd00-0000-0000-000000000002';

describe('catalog-data', () => {
  beforeAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, Missions,
            CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99001, name: '__TEST__ tag' });
    await INSERT.into(Tutorials).entries([
      { ID: TUT1_ID, slug: '__test__-cd-tut-1', title: '__TEST__ Tut 1',
        description: 'd1', experienceTag: 'beginner', averageTimeToComplete: 10,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 3 },
      { ID: TUT2_ID, slug: '__test__-cd-tut-2', title: '__TEST__ Tut 2',
        description: 'd2', experienceTag: 'advanced', averageTimeToComplete: 30,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 5 },
    ]);
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 99101, slug: '__test__-cd-group',
      title: '__TEST__ Group', description: 'g-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries([
      { group_ID: GROUP_ID, tutorial_ID: TUT1_ID, itemOrder: 1 },
      { group_ID: GROUP_ID, tutorial_ID: TUT2_ID, itemOrder: 2 },
    ]);
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99201, slug: '__test__-cd-mission',
      title: '__TEST__ Mission', description: 'm-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, mission_ID: MISSION_ID, name: 'p1', legacyId: 99301,
    });
    await INSERT.into(CompletionPathItems).entries({
      path_ID: PATH_ID, group_ID: GROUP_ID, taskType: 'GROUP', itemOrder: 1,
    });
  });

  it('loadGroupContext returns null for missing slug', async () => {
    expect(await loadGroupContext('does-not-exist')).toBeNull();
  });

  it('loadGroupContext returns group + ordered tutorials with level/time/stepCount', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx).not.toBeNull();
    expect(ctx.group.title).toBe('__TEST__ Group');
    expect(ctx.tutorials).toHaveLength(2);
    expect(ctx.tutorials[0].slug).toBe('__test__-cd-tut-1');
    expect(ctx.tutorials[0].level).toBe('beginner');
    expect(ctx.tutorials[0].time).toBe(10);
    expect(ctx.tutorials[0].stepCount).toBe(3);
    expect(ctx.tutorials[1].slug).toBe('__test__-cd-tut-2');
  });

  it('loadGroupContext returns null when published=false', async () => {
    const { Groups } = cds.entities('com.sap.developers.ims');
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ published: false });
    expect(await loadGroupContext('__test__-cd-group')).toBeNull();
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ published: true });
  });

  it('loadGroupContext returns null when status=INACTIVE', async () => {
    const { Groups } = cds.entities('com.sap.developers.ims');
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ status: 'INACTIVE' });
    expect(await loadGroupContext('__test__-cd-group')).toBeNull();
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ status: 'ACTIVE' });
  });

  it('loadMissionContext returns mission + nested groups with tutorials', async () => {
    const ctx = await loadMissionContext('__test__-cd-mission');
    expect(ctx).not.toBeNull();
    expect(ctx.mission.title).toBe('__TEST__ Mission');
    expect(ctx.groups).toHaveLength(1);
    expect(ctx.groups[0].slug).toBe('__test__-cd-group');
    expect(ctx.groups[0].tutorials).toHaveLength(2);
  });

  it('group context aggregates totalTime and tutorialCount', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx.totalTime).toBe(40);   // 10 + 30
    expect(ctx.tutorialCount).toBe(2);
  });

  it('group context computes level as max severity (advanced > beginner)', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx.level).toBe('advanced');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/projects/tutorials-poc && npx vitest run test/catalog-data.test.js
```

Expected: FAIL with "Cannot find module '../srv/lib/catalog-data.js'".

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/catalog-data.js
//
// Pure DB access for /tutorials/group-* and /tutorials/mission-* server-side
// rendering. Returns shaped contexts the catalog-renderer can consume without
// any further DB awareness. No HTML, no HTTP, no caching.
//
// Field mapping mirrors what scripts/fetch-tutorials.ts (Phase 4, pre-cutover)
// passed into Hugo frontmatter, so the rendered output stays parity-equivalent
// to hugo/layouts/groups/single.html and hugo/layouts/missions/single.html.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

// Mirrors fetch-tutorials.ts level-aggregation: any 'advanced' wins, else any
// 'intermediate', else 'beginner'. Keeps the displayed level bound to the
// hardest tutorial in the set, not the average.
function aggregateLevel(levels) {
  if (levels.includes('advanced')) return 'advanced';
  if (levels.includes('intermediate')) return 'intermediate';
  return 'beginner';
}

// Humanize a primary tag for the timeline-card-tag chip. Matches what
// fetch-tutorials.ts > humanizeTag does at build time, simplified to the
// shapes the data actually has after the tag importer runs.
function humanizeTag(raw) {
  if (!raw) return '';
  const last = raw.split('>').pop();
  return last.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function projectTutorial(t) {
  return {
    ID: t.ID,
    slug: t.slug,
    title: t.title,
    description: t.description ?? '',
    level: t.experienceTag ?? 'beginner',
    time: t.averageTimeToComplete ?? 0,
    stepCount: t.stepCount ?? 0,
    primaryTag: humanizeTag(t.primaryTag ?? ''),
    createdAt: t.createdAt ?? null,
  };
}

export async function loadGroupContext(slug) {
  const { Groups, GroupPathItems, Tutorials } = cds.entities(NAMESPACE);

  const [group] = await SELECT.from(Groups)
    .where({ slug })
    .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
  if (!group) return null;
  if (group.published === false) return null;
  if (group.status && group.status !== 'ACTIVE') return null;

  const items = await SELECT.from(GroupPathItems)
    .where({ group_ID: group.ID })
    .columns('tutorial_ID', 'itemOrder')
    .orderBy('itemOrder');

  const tutorialIds = items.map(i => i.tutorial_ID).filter(Boolean);
  const tutorials = tutorialIds.length
    ? await SELECT.from(Tutorials)
        .where({ ID: { in: tutorialIds }, status: { '!=': 'INACTIVE' } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag',
                 'averageTimeToComplete', 'stepCount', 'primaryTag', 'createdAt')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const orderedTutorials = items
    .map(i => tutById.get(i.tutorial_ID))
    .filter(Boolean)
    .map(projectTutorial);

  const totalTime = orderedTutorials.reduce((s, t) => s + (t.time || 0), 0);
  const level = aggregateLevel(orderedTutorials.map(t => t.level));

  return {
    group,
    tutorials: orderedTutorials,
    tutorialCount: orderedTutorials.length,
    totalTime,
    level,
  };
}

export async function loadMissionContext(slug) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials,
          Groups, GroupPathItems } = cds.entities(NAMESPACE);

  const [mission] = await SELECT.from(Missions)
    .where({ slug })
    .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
  if (!mission) return null;
  if (mission.published === false) return null;
  if (mission.status && mission.status !== 'ACTIVE') return null;

  const paths = await SELECT.from(CompletionPaths)
    .where({ mission_ID: mission.ID })
    .columns('ID', 'name', 'slug')
    .orderBy('legacyId');

  const pathIds = paths.map(p => p.ID);
  const items = pathIds.length
    ? await SELECT.from(CompletionPathItems)
        .where({ path_ID: { in: pathIds }, taskType: 'GROUP', group_ID: { '!=': null } })
        .columns('group_ID', 'itemOrder', 'path_ID')
        .orderBy('path_ID', 'itemOrder')
    : [];

  const groupIds = [...new Set(items.map(i => i.group_ID))];
  const groups = groupIds.length
    ? await SELECT.from(Groups)
        .where({ ID: { in: groupIds }, published: true, status: 'ACTIVE' })
        .columns('ID', 'slug', 'title', 'description')
    : [];
  const groupById = new Map(groups.map(g => [g.ID, g]));

  const gpiRows = groupIds.length
    ? await SELECT.from(GroupPathItems)
        .where({ group_ID: { in: groupIds } })
        .columns('group_ID', 'tutorial_ID', 'itemOrder')
        .orderBy('group_ID', 'itemOrder')
    : [];
  const tutorialIds = [...new Set(gpiRows.map(r => r.tutorial_ID).filter(Boolean))];
  const tutorials = tutorialIds.length
    ? await SELECT.from(Tutorials)
        .where({ ID: { in: tutorialIds }, status: { '!=': 'INACTIVE' } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag',
                 'averageTimeToComplete', 'stepCount', 'primaryTag', 'createdAt')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const groupCards = items.map(item => {
    const g = groupById.get(item.group_ID);
    if (!g) return null;
    const groupTuts = gpiRows
      .filter(r => r.group_ID === g.ID)
      .map(r => tutById.get(r.tutorial_ID))
      .filter(Boolean)
      .map(projectTutorial);
    return { ...g, tutorials: groupTuts };
  }).filter(Boolean);

  const allTutorials = groupCards.flatMap(g => g.tutorials);
  const totalTime = allTutorials.reduce((s, t) => s + (t.time || 0), 0);
  const level = aggregateLevel(allTutorials.map(t => t.level));

  return {
    mission,
    groups: groupCards,
    groupCount: groupCards.length,
    tutorialCount: allTutorials.length,
    totalTime,
    level,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/catalog-data.test.js
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/catalog-data.js test/catalog-data.test.js
git commit -m "feat(catalog): pure DB access layer for group/mission rendering

First step of #91 server-side rendering migration. Returns shaped
contexts the new catalog-renderer can consume without any DB awareness.
Field mapping mirrors what fetch-tutorials.ts Phase 4 emitted to Hugo
frontmatter so the rendered HTML stays parity-equivalent to today's
hugo/layouts/groups/single.html and missions/single.html outputs.

Tests use cds.test in-memory SQLite per the admin-slug-history pattern."
```

---

## Task 2: chrome-shell.js — load + parse + compose

**Files:**
- Create: `srv/lib/chrome-shell.js`
- Create: `test/chrome-shell.test.js`

This unit owns the `__shell__` ContentFiles BLOB lifecycle: load lazily, cache by manifest version, split on `<!-- MAIN -->`, and compose into full HTML with attribute substitution.

- [ ] **Step 1: Write the failing test**

```js
// test/chrome-shell.test.js
import { describe, it, expect } from 'vitest';
import { parseShell, composeShell, ShellMarkerError } from '../srv/lib/chrome-shell.js';

const SAMPLE_SHELL = `<!DOCTYPE html>
<html lang="en" data-page-kind="generic" data-page-slug="" data-page-title="">
<head><title></title><meta name="description" content=""></head>
<body><header>chrome</header>
<!-- MAIN -->
<footer>chrome-foot</footer></body></html>`;

describe('chrome-shell.parseShell', () => {
  it('splits cleanly on the MAIN marker', () => {
    const { before, after } = parseShell(SAMPLE_SHELL);
    expect(before).toContain('<header>chrome</header>');
    expect(after).toContain('<footer>chrome-foot</footer>');
    expect(before).not.toContain('<!-- MAIN -->');
    expect(after).not.toContain('<!-- MAIN -->');
  });

  it('throws ShellMarkerError when marker is missing', () => {
    expect(() => parseShell('<html><body>no marker</body></html>'))
      .toThrow(ShellMarkerError);
  });

  it('throws ShellMarkerError when marker appears twice', () => {
    const bad = SAMPLE_SHELL.replace('<footer>', '<!-- MAIN --><footer>');
    expect(() => parseShell(bad)).toThrow(ShellMarkerError);
  });
});

describe('chrome-shell.composeShell', () => {
  const parsed = parseShell(SAMPLE_SHELL);

  it('substitutes data-page-kind, data-page-slug, data-page-title, <title>, description', () => {
    const html = composeShell(parsed, '<main>BODY</main>', {
      kind: 'group',
      slug: 'group-foo',
      title: 'Foo Group',
      description: 'Desc',
    });
    expect(html).toContain('data-page-kind="group"');
    expect(html).toContain('data-page-slug="group-foo"');
    expect(html).toContain('data-page-title="Foo Group"');
    expect(html).toContain('<title>Foo Group</title>');
    expect(html).toContain('<meta name="description" content="Desc">');
    expect(html).toContain('<main>BODY</main>');
  });

  it('escapes HTML in attribute values', () => {
    const html = composeShell(parsed, '<main></main>', {
      kind: 'group',
      slug: 'group-x',
      title: '<script>alert(1)</script>',
      description: '"quote"',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quote&quot;');
  });

  it('preserves chrome before and after the body verbatim', () => {
    const html = composeShell(parsed, '<main>X</main>', {
      kind: 'group', slug: 's', title: 't', description: 'd',
    });
    expect(html.indexOf('<header>chrome</header>')).toBeLessThan(html.indexOf('<main>X</main>'));
    expect(html.indexOf('<main>X</main>')).toBeLessThan(html.indexOf('<footer>chrome-foot</footer>'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/chrome-shell.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/chrome-shell.js
//
// Owns the __shell__ ContentFiles BLOB lifecycle for catalog pages:
// - Load lazily on first use
// - Cache parsed { before, after } halves keyed by ContentManifest.version
// - Compose full HTML by splicing a body string + page-meta into the chrome
//
// The shell itself is produced by Hugo's `_shell` layout (a one-page layout
// emitting baseof.html chrome around a single <!-- MAIN --> marker), then
// shipped as ContentFiles slug "__shell__" via scripts/publish-content.ts.
//
// Failure handling: if the shell is missing or malformed, the caller in
// content-store.js falls back to a minimal stripped shell so a broken publish
// never 500s catalog requests.

import cds from '@sap/cds';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const SHELL_SLUG = '__shell__';
const MARKER = '<!-- MAIN -->';

export class ShellMarkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellMarkerError';
  }
}

// Pure: split a shell HTML string on <!-- MAIN -->. Throws on missing or
// duplicated marker so a malformed publish surfaces immediately.
export function parseShell(html) {
  const idx = html.indexOf(MARKER);
  if (idx === -1) {
    throw new ShellMarkerError(`shell missing ${MARKER}`);
  }
  const second = html.indexOf(MARKER, idx + MARKER.length);
  if (second !== -1) {
    throw new ShellMarkerError(`shell has duplicate ${MARKER}`);
  }
  return {
    before: html.slice(0, idx),
    after: html.slice(idx + MARKER.length),
  };
}

const escapeAttr = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Pure: compose full HTML from parsed shell halves + body + page meta.
// Substitutes <html data-page-* attributes, <title>, and <meta description>
// for the placeholders the _shell layout emits.
export function composeShell({ before, after }, bodyHtml, meta) {
  const kind  = escapeAttr(meta.kind);
  const slug  = escapeAttr(meta.slug);
  const title = escapeAttr(meta.title);
  const desc  = escapeAttr(meta.description ?? '');

  const patchedBefore = before
    .replace(/data-page-kind="[^"]*"/, `data-page-kind="${kind}"`)
    .replace(/data-page-slug="[^"]*"/, `data-page-slug="${slug}"`)
    .replace(/data-page-title="[^"]*"/, `data-page-title="${title}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${desc}">`,
    );

  return `${patchedBefore}${bodyHtml}${after}`;
}

// Stateful loader. Reads the active shell from ContentFiles once per
// manifest version and caches the parsed halves. Exported as a factory so
// content-store.js can pass in its already-bound namespace + getActiveVersion.
export function createShellLoader({ namespace, hanaTableName, getActiveVersion }) {
  let cached = null;  // { version, parsed }

  async function loadShellBlob(version) {
    const { ContentFiles } = cds.entities(namespace);
    const db = await cds.connect.to('db');

    let buf;
    if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
      const [row] = await db.run(
        `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`,
        [SHELL_SLUG, version],
      );
      buf = row?.CONTENT;
    } else {
      const row = await SELECT.one.from(ContentFiles)
        .where({ slug: SHELL_SLUG, version })
        .columns('content');
      if (!row) return null;
      buf = row.content;
      if (buf instanceof Readable) {
        const chunks = [];
        for await (const c of buf) chunks.push(c);
        buf = Buffer.concat(chunks);
      } else if (buf && typeof buf.read === 'function') {
        // Some adapters return a hybrid stream — fall back to read().
        buf = await new Promise((resolve, reject) => {
          const chunks = [];
          buf.on('data', c => chunks.push(c));
          buf.on('end', () => resolve(Buffer.concat(chunks)));
          buf.on('error', reject);
        });
      }
    }
    if (!buf) return null;
    return gunzipSync(buf).toString('utf-8');
  }

  return {
    // Returns { before, after, version } or null if unavailable.
    async get() {
      const version = await getActiveVersion();
      if (version === null) return null;
      if (cached && cached.version === version) return { ...cached.parsed, version };
      const html = await loadShellBlob(version);
      if (!html) return null;
      const parsed = parseShell(html);
      cached = { version, parsed };
      return { ...parsed, version };
    },
    invalidate() { cached = null; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/chrome-shell.test.js
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/chrome-shell.js test/chrome-shell.test.js
git commit -m "feat(catalog): chrome-shell loader and composer

Lazy-load + version-keyed cache for the __shell__ ContentFiles BLOB,
plus pure parseShell/composeShell helpers. Throws a typed
ShellMarkerError on a malformed publish so callers can fall back to a
stripped shell instead of 500ing.

Mirrors the LOB-locator handling pattern from content-store.js for HANA."
```

---

## Task 3: catalog-renderer.js — body markup with parity

**Files:**
- Create: `srv/lib/catalog-renderer.js`
- Create: `test/catalog-renderer.test.js`

The body output must match `hugo/layouts/groups/single.html` and `hugo/layouts/missions/single.html` structurally (same class names, same inline behaviors) so the existing CSS styles it without a new sheet.

- [ ] **Step 1: Read the parity targets**

Open and study so the implementation matches structure exactly:
- [hugo/layouts/groups/single.html](../../hugo/layouts/groups/single.html)
- [hugo/layouts/missions/single.html](../../hugo/layouts/missions/single.html)
- [hugo/layouts/partials/breadcrumbs.html](../../hugo/layouts/partials/breadcrumbs.html)
- [hugo/layouts/partials/license-icon.html](../../hugo/layouts/partials/license-icon.html)

- [ ] **Step 2: Write the failing test**

```js
// test/catalog-renderer.test.js
import { describe, it, expect } from 'vitest';
import { renderGroupBody, renderMissionBody } from '../srv/lib/catalog-renderer.js';

const TODAY = new Date('2026-05-28T00:00:00Z');
const recent = new Date(TODAY); recent.setDate(recent.getDate() - 5);
const old = new Date(TODAY); old.setDate(old.getDate() - 60);

const fxGroup = {
  group: { ID: 'g1', slug: 'foo', title: 'Foo Group', description: 'Foo desc' },
  tutorials: [
    { slug: 't1', title: 'T1', description: 'd1', level: 'beginner', time: 10,
      stepCount: 3, primaryTag: 'CAP', createdAt: recent.toISOString() },
    { slug: 't2', title: 'T2', description: 'd2', level: 'advanced', time: 30,
      stepCount: 5, primaryTag: 'HANA', createdAt: old.toISOString() },
  ],
  tutorialCount: 2,
  totalTime: 40,
  level: 'advanced',
};

describe('renderGroupBody', () => {
  it('renders the wrapper, hero, and timeline classes', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('class="group-wrapper"');
    expect(html).toContain('class="group-hero"');
    expect(html).toContain('class="tutorial-timeline"');
    expect(html).toContain('class="type-badge type-badge--group">GROUP');
    expect(html).toContain('class="timeline-item"');
    expect(html).toContain('class="timeline-card');
    expect(html).toContain('class="start-btn"');
  });

  it('emits group-meta with level, totalTime, and tutorialCount', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('Advanced');
    expect(html).toContain('40 min.');
    expect(html).toContain('2 Tutorials');
  });

  it('marks recent tutorials with timeline-card--new + NEW badge', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    const t1Idx = html.indexOf('href="/tutorials/t1"');
    const t2Idx = html.indexOf('href="/tutorials/t2"');
    const newBadgeIdx = html.indexOf('NEW');
    expect(newBadgeIdx).toBeGreaterThan(0);
    // The badge sits inside t1's card, before t2
    expect(newBadgeIdx).toBeGreaterThan(t1Idx);
    expect(newBadgeIdx).toBeLessThan(t2Idx);
    expect(html).toContain('timeline-card--new');
  });

  it('escapes HTML in titles and descriptions', () => {
    const evil = {
      ...fxGroup,
      group: { ...fxGroup.group, title: '<script>alert(1)</script>' },
    };
    const html = renderGroupBody(evil, { now: TODAY });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty timeline when tutorials list is empty', () => {
    const empty = { ...fxGroup, tutorials: [], tutorialCount: 0, totalTime: 0 };
    const html = renderGroupBody(empty, { now: TODAY });
    expect(html).toContain('class="tutorial-timeline"');
    expect(html).toContain('0 Tutorials');
  });

  it('emits primary-tag chip on each card', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('class="timeline-card-tag">CAP');
    expect(html).toContain('class="timeline-card-tag">HANA');
  });
});

const fxMission = {
  mission: { ID: 'm1', slug: 'bar', title: 'Bar Mission', description: 'Bar desc' },
  groups: [
    { ID: 'g1', slug: 'g-one', title: 'G One',
      tutorials: [{ slug: 't1', title: 'T1', level: 'beginner', time: 5, stepCount: 1 }] },
    { ID: 'g2', slug: 'g-two', title: 'G Two',
      tutorials: [{ slug: 't2', title: 'T2', level: 'intermediate', time: 12, stepCount: 4 }] },
  ],
  groupCount: 2,
  tutorialCount: 2,
  totalTime: 17,
  level: 'intermediate',
};

describe('renderMissionBody', () => {
  it('renders mission wrapper, hero, and group-card list', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('class="mission-wrapper"');
    expect(html).toContain('class="mission-hero"');
    expect(html).toContain('class="groups-section"');
    expect(html).toContain('class="group-card"');
    expect(html).toContain('class="type-badge type-badge--mission">MISSION');
  });

  it('links each group card to /tutorials/group-<slug>', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('href="/tutorials/group-g-one"');
    expect(html).toContain('href="/tutorials/group-g-two"');
  });

  it('emits the group-card-header onclick + first-card-expand inline behaviors', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain("this.parentElement.classList.toggle('expanded')");
    expect(html).toContain('document.querySelector(\'.group-card\').classList.add(\'expanded\')');
  });

  it('emits inner tutorial list with /tutorials/<slug> links', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('class="tutorial-item"');
    expect(html).toContain('href="/tutorials/t1"');
    expect(html).toContain('href="/tutorials/t2"');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run test/catalog-renderer.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Write the implementation**

```js
// srv/lib/catalog-renderer.js
//
// Pure body-markup renderer for /tutorials/group-* and /tutorials/mission-*.
// No DB access, no HTTP — takes a context (from catalog-data.js) and returns
// a body HTML string that the chrome-shell composer splices into the full page.
//
// Output structure mirrors hugo/layouts/groups/single.html and
// missions/single.html so the existing /css/* sheets style the result without
// any new CSS. Inline behaviors (group-card-header onclick, first-card
// auto-expand) are reproduced verbatim — they are tiny, scoped, and removing
// them would require parallel CSS work outside this change's scope.

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const NEW_WINDOW_DAYS = 31;

function isNewTutorial(createdAt, now = new Date()) {
  if (!createdAt) return false;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - NEW_WINDOW_DAYS);
  return t > cutoff;
}

function titleCase(s) {
  return String(s ?? '').replace(/\b\w/g, c => c.toUpperCase());
}

export function renderGroupBody(ctx, opts = {}) {
  const { group, tutorials, tutorialCount, totalTime, level } = ctx;
  const now = opts.now ?? new Date();

  const cards = tutorials.map((t, i) => {
    const isNew = isNewTutorial(t.createdAt, now);
    const newClass = isNew ? ' timeline-card--new' : '';
    const newBadge = isNew
      ? `<span class="timeline-card__new-badge" aria-label="New tutorial">NEW</span>`
      : '';
    const desc = t.description
      ? `<p class="timeline-card-desc">${escapeHtml(t.description)}</p>`
      : '';
    const tagChip = t.primaryTag
      ? `<span class="timeline-card-tag">${escapeHtml(t.primaryTag)}</span>`
      : '';
    const isLast = i === tutorials.length - 1;
    const connectorLine = isLast ? '' : '<div class="timeline-line"></div>';

    return `
      <div class="timeline-item">
        <div class="timeline-connector">
          <span class="timeline-circle">${i + 1}</span>
          ${connectorLine}
        </div>
        <div class="timeline-card${newClass}">
          ${newBadge}
          <div class="timeline-card-header">
            <h3><a href="/tutorials/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a></h3>
            <div class="timeline-card-meta">
              <span>${escapeHtml(titleCase(t.level))}</span>
              <span class="meta-sep">&middot;</span>
              <span>${t.time | 0} min.</span>
              <span class="meta-sep">&middot;</span>
              <span>${t.stepCount | 0} steps</span>
            </div>
          </div>
          ${desc}
          <div class="timeline-card-footer">
            ${tagChip}
            <a href="/tutorials/${escapeHtml(t.slug)}" class="start-btn">Start Tutorial &rarr;</a>
          </div>
        </div>
      </div>`;
  }).join('\n');

  return `<div class="group-wrapper">
  <section class="group-hero">
    <div class="hero-inner">
      <span class="type-badge type-badge--group">GROUP</span>
      <h1>${escapeHtml(group.title)}</h1>
      ${group.description ? `<p class="group-description">${escapeHtml(group.description)}</p>` : ''}
      <div class="group-meta">
        <span class="meta-item">${escapeHtml(titleCase(level))}</span>
        <span class="meta-sep">&middot;</span>
        <span class="meta-item">${totalTime | 0} min.</span>
        <span class="meta-sep">&middot;</span>
        <span class="meta-item">${tutorialCount | 0} Tutorials</span>
      </div>
    </div>
  </section>
  <div class="group-body">
    <h2>Tutorials</h2>
    <div class="tutorial-timeline">
${cards}
    </div>
  </div>
</div>
<script type="module" src="/js/nav-dropdown.js"></script>`;
}

export function renderMissionBody(ctx) {
  const { mission, groups, groupCount, tutorialCount, totalTime, level } = ctx;

  const cards = groups.map(g => {
    const tuts = g.tutorials.map((t, i) => `
            <li class="tutorial-item">
              <span class="tutorial-number">${i + 1}</span>
              <div class="tutorial-info">
                <a href="/tutorials/${escapeHtml(t.slug)}" class="tutorial-link">${escapeHtml(t.title)}</a>
                <div class="tutorial-meta-row">
                  <span>${escapeHtml(titleCase(t.level || 'beginner'))}</span>
                  <span class="meta-sep">&middot;</span>
                  <span>${t.time | 0} min.</span>
                  <span class="meta-sep">&middot;</span>
                  <span>${t.stepCount | 0} steps</span>
                </div>
              </div>
            </li>`).join('\n');

    return `      <div class="group-card">
        <div class="group-card-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="group-header-left">
            <span class="type-badge type-badge--group">GROUP</span>
            <h3><a href="/tutorials/group-${escapeHtml(g.slug)}" onclick="event.stopPropagation()">${escapeHtml(g.title)}</a></h3>
            <span class="group-meta">${g.tutorials.length} Tutorials</span>
          </div>
          <span class="group-chevron">&#9662;</span>
        </div>
        <div class="group-card-body">
          <ol class="group-tutorials">
${tuts}
          </ol>
          <a href="/tutorials/group-${escapeHtml(g.slug)}" class="group-start-link">View Group &rarr;</a>
        </div>
      </div>`;
  }).join('\n');

  return `<div class="mission-wrapper">
  <section class="mission-hero">
    <div class="hero-inner">
      <div class="hero-top"><div class="hero-text">
        <span class="type-badge type-badge--mission">MISSION</span>
        <h1 class="mission-hero-title">${escapeHtml(mission.title)}</h1>
        ${mission.description ? `<p class="mission-description">${escapeHtml(mission.description)}</p>` : ''}
        <div class="mission-meta">
          <span class="meta-item">${escapeHtml(titleCase(level))}</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${totalTime | 0} min.</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${tutorialCount | 0} Tutorials</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${groupCount | 0} Groups</span>
        </div>
      </div></div>
    </div>
  </section>
  <div class="mission-body">
    <div class="groups-section">
      <h2>Groups in this Mission</h2>
${cards}
    </div>
  </div>
</div>
<script>
// Auto-expand the first group card (parity with hugo/layouts/missions/single.html)
document.addEventListener('DOMContentLoaded', function() {
  var firstCard = document.querySelector('.group-card');
  if (firstCard) firstCard.classList.add('expanded');
});
</script>
<script type="module" src="/js/nav-dropdown.js"></script>`;
}

// Composes a full page given a slug + chrome shell + already-loaded body data.
// Returns null when the entity isn't found / not published / inactive — caller
// (content-store.serveHandler) maps this to 404 via the existing serveNotFound.
export async function renderCatalogPage(slug, deps) {
  const { loadGroupContext, loadMissionContext, shellLoader } = deps;

  if (slug.startsWith('group-')) {
    const ctx = await loadGroupContext(slug.slice('group-'.length));
    if (!ctx) return null;
    const body = renderGroupBody(ctx);
    return {
      contentType: 'text/html; charset=utf-8',
      body,
      pageMeta: {
        kind: 'group',
        slug,
        title: ctx.group.title,
        description: ctx.group.description ?? '',
      },
    };
  }

  if (slug.startsWith('mission-')) {
    const ctx = await loadMissionContext(slug.slice('mission-'.length));
    if (!ctx) return null;
    const body = renderMissionBody(ctx);
    return {
      contentType: 'text/html; charset=utf-8',
      body,
      pageMeta: {
        kind: 'mission',
        slug,
        title: ctx.mission.title,
        description: ctx.mission.description ?? '',
      },
    };
  }

  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run test/catalog-renderer.test.js
```

Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/catalog-renderer.js test/catalog-renderer.test.js
git commit -m "feat(catalog): body-markup renderer with Hugo-template parity

Pure renderGroupBody / renderMissionBody plus a renderCatalogPage entry
that composes a slug into a body. Output structure mirrors
hugo/layouts/{groups,missions}/single.html so the existing /css/* sheets
style the page without new CSS. Inline behaviors (group-card-header
onclick, first-card auto-expand) reproduced verbatim from the Hugo
templates."
```

---

## Task 4: Hugo `_shell` layout — emit a chrome-only HTML page

**Files:**
- Create: `hugo/layouts/_shell/single.html`
- Create: `hugo/content/_shell/_index.md`

Hugo needs to materialize one extra HTML file that the publish step extracts and uploads as `__shell__`. The simplest approach is a content type with a single file driven by a layout that calls `baseof.html`'s chrome around a single `<!-- MAIN -->` comment.

- [ ] **Step 1: Create the stub content file**

```bash
cat > hugo/content/_shell/_index.md <<'EOF'
---
title: "_shell"
type: "_shell"
layout: "single"
sitemap:
  disable: true
url: "/_shell/"
---
EOF
```

- [ ] **Step 2: Create the layout**

```html
{{ define "main" }}<!-- MAIN -->{{ end }}
```

Save as `hugo/layouts/_shell/single.html`. This is intentionally one line — the layout's only job is to fill `baseof.html`'s `{{ block "main" . }}` slot with the marker `publish-content.ts` will key on.

- [ ] **Step 3: Verify Hugo emits the file**

```bash
cd d:/projects/tutorials-poc && rm -rf hugo/public && /tmp/hugo --source hugo --minify 2>&1 | tail -5 && ls hugo/public/_shell/index.html && grep -c '<!-- MAIN -->' hugo/public/_shell/index.html
```

Expected: `hugo/public/_shell/index.html` exists and grep returns `1`.

> **Note:** if Hugo isn't installed locally, run `cd hugo && npx hugo --minify` if hugo-bin is on the dev box, or skip this step until step 5 of Task 5 runs the publish-content with a CI-built artifact. The CI workflow installs Hugo via curl (see `.github/workflows/rebuild-content.yml`).

- [ ] **Step 4: Confirm the marker survives Hugo's HTML minifier**

The Hugo minifier strips quotes from safe attributes (project memo "Hugo Minifier Strips Quotes") but it preserves comments by default. Confirm the comment is intact:

```bash
grep -A1 'MAIN' hugo/public/_shell/index.html | head -3
```

Expected: the line containing `<!-- MAIN -->` is visible. If minification stripped the comment, change the marker line in `single.html` to `<!--MAIN-->{{/* hugo-keep */}}` and re-test.

- [ ] **Step 5: Confirm sitemap/robots exclusion**

`hugo/public/sitemap.xml` should NOT contain `/_shell/`. Check:

```bash
grep -c '/_shell/' hugo/public/sitemap.xml
```

Expected: `0`. The frontmatter's `sitemap.disable: true` handles this.

- [ ] **Step 6: Commit**

```bash
git add hugo/layouts/_shell/ hugo/content/_shell/
git commit -m "feat(hugo): _shell layout emitting baseof chrome around <!-- MAIN -->

Single-file content type that produces hugo/public/_shell/index.html on
every Hugo build. publish-content.ts (next task) slices the <main>...</main>
out, replaces it with the marker, and uploads the result as the __shell__
ContentFiles slug. Excluded from sitemap.xml via frontmatter.

Part of #91 server-side catalog rendering."
```

---

## Task 5: publish-content.ts — upload `__shell__`

**Files:**
- Modify: `scripts/publish-content.ts` (around line 365 — alongside `__nav__` and `__404__` injection)

The new entry slots in next to the existing `__nav__`/`__404__` injection. If the `_shell` file is missing or the `<main>` slice produces an empty result, the script throws and CI fails — never publish a partial set.

- [ ] **Step 1: Read the current `__nav__` / `__404__` injection block**

```bash
sed -n '350,380p' scripts/publish-content.ts
```

Reference: line numbers documented in the plan header. The block shape is:

```ts
const navJsonPath = join(opts.hugoDir, 'tutorials', '_nav.json');
if (existsSync(navJsonPath)) {
  ...
  payload['__nav__'] = gzipSync(...).toString('base64');
}

const notFoundPath = join(opts.hugoDir, '404.html');
if (existsSync(notFoundPath)) {
  payload['__404__'] = gzipSync(...).toString('base64');
}
```

- [ ] **Step 2: Add the shell extraction immediately after the `__404__` block**

Insert this block after the `payload['__404__']` injection (around line 374):

```ts
  // Include the chrome shell for catalog pages (groups/missions). The CAP
  // serveHandler splits this on the <!-- MAIN --> marker and splices a
  // server-rendered body into it. Failing to ship this aborts the whole
  // publish — a half-broken publish would 500 every catalog page until the
  // next CI run. (#91)
  const shellPath = join(opts.hugoDir, '_shell', 'index.html');
  if (!existsSync(shellPath)) {
    throw new Error(
      `[publish-content] _shell/index.html missing — Hugo build did not emit ` +
      `the chrome shell. Did the _shell layout get deleted? Path: ${shellPath}`
    );
  }
  const shellRaw = readFileSync(shellPath, 'utf-8');
  // Slice <main>...</main> out of the rendered shell and replace with the
  // marker the chrome-shell loader splits on. The minifier collapses the
  // <main> tag to a single line so a single regex suffices.
  const mainMatch = shellRaw.match(/<main\b[^>]*>[\s\S]*?<\/main>/);
  if (!mainMatch) {
    throw new Error(
      `[publish-content] _shell/index.html does not contain <main>...</main> — ` +
      `cannot extract chrome shell. Inspect the file to debug.`
    );
  }
  const shellHtml = shellRaw.replace(mainMatch[0], '<!-- MAIN -->');
  if (shellHtml.length < 1000) {
    // Sanity check: the shell should include header, footer, glossary popover,
    // toast, and lightbox. If it's tiny, something stripped the chrome.
    throw new Error(
      `[publish-content] chrome shell suspiciously small ` +
      `(${shellHtml.length} bytes). Refusing to publish.`
    );
  }
  payload['__shell__'] = gzipSync(Buffer.from(shellHtml, 'utf-8')).toString('base64');
  log(`Included chrome shell (${shellHtml.length} bytes raw, ${payload['__shell__'].length} bytes b64-gz)`);
```

Make sure `readFileSync` is already imported at the top of the file (it is — used by the `__nav__` and `__404__` blocks).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsx scripts/publish-content.ts --help 2>&1 | head -20 || true
```

Expected: prints usage / argument-parsing output (or proceeds to dry-run reject), no compile errors.

- [ ] **Step 4: Manual smoke (against local CAP)**

If a local CAP + Hugo build is available:

```bash
# Build Hugo
cd hugo && npx hugo --minify && cd ..
# Verify the shell file exists
ls hugo/public/_shell/index.html
# Dry-run the publish
CAP_BASE_URL=http://localhost:4004 CONTENT_API_KEY=dev-key \
  npx tsx scripts/publish-content.ts --hugo-dir hugo/public \
    --base-url http://localhost:4004 --trigger manual --dry-run
```

Expected: dry-run output shows `Included chrome shell (... bytes ...)` log line. If local CAP isn't running, skip — the unit tests in earlier tasks cover the rest, and CI will exercise this on the next deploy.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-content.ts
git commit -m "feat(publish): upload chrome shell as __shell__ ContentFiles slug

Slices <main>...</main> out of hugo/public/_shell/index.html and
replaces with <!-- MAIN --> marker so the CAP-side chrome-shell loader
can splice a server-rendered body in.

Throws (and aborts the whole publish) if the file is missing, has no
<main>, or comes out suspiciously small — better to keep the prior
manifest active than ship a broken shell.

Part of #91 server-side catalog rendering."
```

---

## Task 6: content-store.js — wire the new renderer

**Files:**
- Modify: `srv/lib/content-store.js`
- Delete: `srv/lib/render-catalog-page.js`
- Delete: `test/render-catalog-page.test.js`

This is the cutover point. The new renderer becomes the only path; the stripped fallback goes away.

- [ ] **Step 1: Add `invalidateByPrefix` to ContentCache**

In [srv/lib/content-store.js](../../srv/lib/content-store.js), find the `ContentCache` class around line 86 and add this method right after `invalidate()` (around line 119):

```js
  invalidateByPrefix(prefix) {
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.map.get(key);
        this.totalBytes -= entry.buffer.length;
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
```

- [ ] **Step 2: Replace import + instantiate the shell loader**

Find this import line near the top of `content-store.js`:

```js
import { renderCatalogPage } from './render-catalog-page.js';
```

Replace with:

```js
import { renderCatalogPage } from './catalog-renderer.js';
import { loadGroupContext, loadMissionContext } from './catalog-data.js';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
```

Inside `createContentHandlers({...})`, immediately after the `getActiveVersion` function is defined (around line 161), instantiate the shell loader:

```js
  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });
```

- [ ] **Step 3: Insert the catalog branch in serveHandler**

Find the slug-redirect block in `serveHandler` (around line 644 — the `if (slug.startsWith('group-') || slug.startsWith('mission-')) { ... 301 ... }` block that handles `GroupSlugRedirects`/`MissionSlugRedirects`). The catalog render branch must go **after** that redirect block (so a stale-bookmark slug 301s to the canonical slug first) but **before** the `getActiveVersion()` / `ContentFiles` lookup.

Insert this block right after the slug-redirect `if` ends (just before the `// Status-aware lookup` comment):

```js
    // Catalog branch: groups/missions are server-rendered from DB content
    // (no ContentFiles row exists for them after the #91 migration). Falls
    // through to the regular ContentFiles path for any non-prefixed slug.
    if (slug.startsWith('group-') || slug.startsWith('mission-')) {
      const cacheKey = `render:${slug}`;
      const cachedRender = cache.get(cacheKey);
      if (cachedRender) {
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === `"${cachedRender.hash}"`) {
          return res.status(304).end();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('ETag', `"${cachedRender.hash}"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Source', 'render-cache');
        return res.send(cachedRender.buffer);
      }

      try {
        const rendered = await renderCatalogPage(slug, {
          loadGroupContext,
          loadMissionContext,
          shellLoader,
        });
        if (!rendered) return serveNotFound(res, slug);

        // Compose body into chrome shell. If shell load/parse fails, fall
        // back to a minimal stripped shell so the page still renders.
        let html;
        try {
          const shell = await shellLoader.get();
          if (!shell) throw new ShellMarkerError('shell unavailable');
          html = composeShell(shell, rendered.body, rendered.pageMeta);
        } catch (err) {
          console.warn(
            '[content/serve:catalog] chrome shell missing — degraded rendering until next publish:',
            err.message,
          );
          const m = rendered.pageMeta;
          const safe = (s) => String(s).replace(/[<&"]/g, c =>
            ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' }[c]));
          html =
            `<!DOCTYPE html><html lang="en" data-page-kind="${m.kind}" ` +
            `data-page-slug="${safe(m.slug)}" data-page-title="${safe(m.title)}">` +
            `<head><meta charset="utf-8"><title>${safe(m.title)}</title>` +
            `<link rel="stylesheet" href="/css/sap-theme-vars.css">` +
            `<link rel="stylesheet" href="/css/sap-fundamental.css">` +
            `</head><body><main>${rendered.body}</main></body></html>`;
        }

        const buffer = Buffer.from(html, 'utf-8');
        const hash = createHash('sha256').update(buffer).digest('hex');
        cache.set(cacheKey, buffer, hash);

        res.setHeader('Content-Type', rendered.contentType);
        res.setHeader('ETag', `"${hash}"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Source', 'rendered');
        return res.status(200).send(buffer);
      } catch (err) {
        console.error('[content/serve:catalog]',
          err instanceof Error ? err.message : String(err));
        return res.status(500).json({ error: 'Catalog page render failed' });
      }
    }
```

`createHash` is already imported from `node:crypto` at the top — verify with `grep "from 'node:crypto'" srv/lib/content-store.js`. If `createHash` isn't there, add it to the existing crypto import.

- [ ] **Step 4: Remove the synthesized fallback branch**

Find the existing fallback block (around line 721-734) and reduce it to just the 404:

```js
      if (!meta) {
        return serveNotFound(res, slug);
      }
```

- [ ] **Step 5: Filter `__shell__` from nav/hashes responses**

Three filter sites — apply the same `__shell__` exclusion that `__nav__` and `__404__` already get:

In `hashesHandler` around line 792:

```js
        if (row.slug === '__nav__' || row.slug === '__404__' || row.slug === '__shell__') continue;
```

In `navHandlerFallback` around line 813:

```js
    const slugs = contentRows.filter(r =>
      r.slug !== '__nav__' && r.slug !== '__404__' && r.slug !== '__shell__'
    ).map(r => r.slug);
```

And around line 878:

```js
      .filter(r =>
        r.slug !== '__nav__' && r.slug !== '__404__' &&
        r.slug !== '__shell__' && !inactiveSlugs.has(r.slug)
      )
```

- [ ] **Step 6: Export `invalidateRenderCache`**

After `const cache = new ContentCache();` (around line 121), add:

```js
// Exported so AdminService write hooks can invalidate render: entries when
// catalog data changes between publishes. See srv/server.js > 'served'.
export function invalidateRenderCache() {
  return cache.invalidateByPrefix('render:');
}
```

- [ ] **Step 7: Delete the old fallback file and its test**

```bash
git rm srv/lib/render-catalog-page.js test/render-catalog-page.test.js
```

- [ ] **Step 8: Run the targeted unit tests**

```bash
npx vitest run test/catalog-data.test.js test/catalog-renderer.test.js test/chrome-shell.test.js 2>&1 | tail -20
```

Expected: green.

- [ ] **Step 9: Run the full unit suite**

```bash
npx vitest run test/ --reporter=basic 2>&1 | tail -30
```

Per project memo "Worktree Tests Hang", cap any single suite at 5 minutes. Surface unrelated failures rather than blocking the commit; address related failures before committing.

- [ ] **Step 10: Commit**

```bash
git add srv/lib/content-store.js
git commit -m "feat(content-store): wire server-side catalog renderer + render-cache helper

Replaces the stripped synthesized fallback with a full chrome-shell
composition. Catalog branch runs early in serveHandler so groups/missions
never hit the ContentFiles BLOB lookup path. Adds invalidateByPrefix on
ContentCache and an exported invalidateRenderCache helper for AdminService
to call. Filters __shell__ out of nav/hashes responses alongside
__nav__/__404__.

Removes srv/lib/render-catalog-page.js and its test (obsolete).

Part of #91 server-side catalog rendering."
```

---

## Task 7: AdminService cache invalidation (piggyback)

**Files:**
- Modify: `srv/server.js` (around line 222 — the existing `admin.after(...)` block)

> **Note — divergence from spec:** the spec located this hook in `srv/admin-service.js`. During planning we found that `srv/server.js` already has an `admin.after(...)` hook at line ~225 invalidating a navigator cache against the **exact same entity list** we need (Missions, Groups, CompletionPaths, CompletionPathItems, GroupPathItems, Tutorials). Piggybacking on it avoids a duplicate hook for the same trigger set. Behavior matches the spec — only the home file changes.

The existing navigator-cache invalidator at [srv/server.js:225-235](../../srv/server.js#L225-L235) already hooks the exact entity list we need. Piggyback on it.

- [ ] **Step 1: Read the current invalidator block**

```bash
sed -n '222,240p' srv/server.js
```

- [ ] **Step 2: Import `invalidateRenderCache`**

In `srv/server.js`, find the existing import for `content-store.js` symbols (search `from './lib/content-store.js'`) and add `invalidateRenderCache` to the named imports.

- [ ] **Step 3: Add the second invalidation to the existing hook**

Replace the existing `admin.after(...)` callback body so both invalidations fire under independent try/catch:

```js
    admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, () => {
      try {
        invalidateNavigatorCache();
      } catch (err) {
        console.error('[navigator] cache invalidation failed', err);
      }
      try {
        const removed = invalidateRenderCache();
        if (removed > 0) {
          console.log(`[render-cache] invalidated ${removed} entries after admin write`);
        }
      } catch (err) {
        console.error('[render-cache] cache invalidation failed', err);
      }
    });
```

- [ ] **Step 4: Sanity-check the existing entity list**

```bash
sed -n '227p' srv/server.js
```

Expected: includes `Missions`, `Groups`, `CompletionPaths`, `CompletionPathItems`, `GroupPathItems`, `Tutorials`. If any are missing, add — these are exactly the entities whose changes affect catalog page output.

- [ ] **Step 5: Run admin tests to confirm no regression**

```bash
npx vitest run test/admin-slug-history.test.js 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js
git commit -m "feat(admin): invalidate render cache on catalog writes

Piggybacks on the existing navigator-cache invalidator at served-time so
admin edits to Missions/Groups/CompletionPaths/CompletionPathItems/
GroupPathItems/Tutorials show up on the next /tutorials/{group,mission}-*
request without waiting for CI rebuild.

Both invalidations run in independent try/catch blocks so neither failure
mode can roll back the admin save.

Part of #91 server-side catalog rendering."
```

---

## Task 8: fetch-tutorials.ts Phase 4 reduction

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (Phase 4 lines ~813-1045 + helper functions ~402-510)

Phase 4 keeps the `/build/catalog` fetch + tutorial-frontmatter patching (still needed so today's `breadcrumbs.html` partial can render parent text on first paint, before the new island in Task 10 refreshes it). It drops the standalone group/mission `.md` page emission.

- [ ] **Step 1: Read Phase 4 and the helper functions**

```bash
sed -n '402,510p' scripts/fetch-tutorials.ts   # writeMissionPage / writeGroupPage
sed -n '810,1090p' scripts/fetch-tutorials.ts  # Phase 4 body
```

Identify what to KEEP and DELETE:

KEEP:
- The `/build/catalog` fetch (~line 833)
- The hierarchy walk that resolves each tutorial's parent group + mission
- The frontmatter patch step that injects `missionTitle`/`missionSlug`/`groupTitle`/`groupSlug` into already-emitted tutorial pages

DELETE:
- `writeMissionPage` and `writeGroupPage` function defs (~line 402-510)
- All calls to those functions inside Phase 4
- `missionsMeta.push(...)` / `allGroupRefs.push(...)` accumulators (only used for the page writes / report)
- The Phase 4 final-summary lines printing mission/group count (or simplify to count from the catalog)

- [ ] **Step 2: Delete `writeMissionPage` and `writeGroupPage` definitions**

Delete both function blocks around lines 402-510, including their JSDoc comments. TypeScript will surface every caller as `TS2304: Cannot find name`. Use those errors to find every call site in step 3.

- [ ] **Step 3: Trim Phase 4 body**

Remove all calls to the deleted functions plus the accumulators that exclusively fed them. Minimum viable Phase 4 ends with logging like `[cap] Patched ${patchedCount} tutorial pages with breadcrumb context`.

If `MissionMeta` / `GroupRef` types are now unused, remove their `import type` lines.

- [ ] **Step 4: Update the function-end summary**

Locate the final summary block by searching for the report it prints — `grep -n "missions/groups\|missionsMeta\.length\|allGroupRefs\.length" scripts/fetch-tutorials.ts` rather than relying on line numbers (deletions in earlier steps will shift them). Remove or simplify lines that report `missionsMeta.length` / `allGroupRefs.length`. Keep `matchedTutorials` and `patchedCount`.

If a JSON report is written at the end (search for `writeFileSync` near the file end), drop the `missions` / `groups` keys from the output.

- [ ] **Step 5: TypeScript compile-check**

```bash
npx tsx scripts/fetch-tutorials.ts --help 2>&1 | head -20 || true
```

Expected: prints argument help; no `TS2304` errors. If errors persist, search for remaining `writeMissionPage` / `writeGroupPage` / `missionsMeta` references.

- [ ] **Step 6: Run the fetch-tutorials test**

```bash
npx vitest run scripts/__tests__/fetch-tutorials-qa.test.ts 2>&1 | tail -15
```

Expected: green. Update assertions to match the reduced Phase 4 shape if needed.

- [ ] **Step 7: Delete the Hugo group/mission layouts**

```bash
git rm hugo/layouts/groups/single.html hugo/layouts/missions/single.html
rmdir hugo/layouts/groups hugo/layouts/missions 2>/dev/null || true
```

- [ ] **Step 8: Verify Hugo build still works**

```bash
cd d:/projects/tutorials-poc && rm -rf hugo/public && /tmp/hugo --source hugo --minify 2>&1 | tail -5
ls hugo/public/_shell/index.html
ls hugo/public/groups 2>&1 | head -1   # should NOT exist
ls hugo/public/missions 2>&1 | head -1 # should NOT exist
```

Expected: `_shell/index.html` exists; `groups/` and `missions/` do NOT exist (or are empty). Hugo may warn about unused templates — that's expected.

- [ ] **Step 9: Commit**

```bash
git add scripts/fetch-tutorials.ts
git rm hugo/layouts/groups/single.html hugo/layouts/missions/single.html 2>/dev/null || true
git commit -m "feat(fetch): reduce Phase 4 to tutorial-frontmatter patching

Stops emitting standalone group/mission .md pages — these are now
rendered server-side by the new catalog-renderer (#91). Phase 4 keeps
just the /build/catalog fetch + per-tutorial breadcrumb-context patch
that today's tutorial-page breadcrumbs partial still reads on first
paint (the new tutorial-breadcrumbs island refreshes it after).

Removes writeMissionPage / writeGroupPage helpers and their accumulators.
Deletes hugo/layouts/groups/single.html and missions/single.html.

Part of #91 server-side catalog rendering."
```

---

## Task 9: /build/breadcrumb-context endpoint

**Files:**
- Create: `srv/lib/breadcrumb-context.js`
- Modify: `srv/server.js` (mount alongside other `/build/*` routes around line 115)
- Create: `test/breadcrumb-context.test.js`

A small public endpoint returning fresh `missionTitle/Slug/groupTitle/Slug` for a single tutorial. The client-side island in Task 10 calls this to overwrite stale parent breadcrumb text after a group/mission rename.

- [ ] **Step 1: Write the failing test**

```js
// test/breadcrumb-context.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-bc00-0000-0000-000000000001';
const TUT_ID = 'cccccccc-bc00-0000-0000-000000000001';
const GROUP_ID = 'bbbbbbbb-bc00-0000-0000-000000000001';
const MISSION_ID = 'dddddddd-bc00-0000-0000-000000000001';
const PATH_ID = 'eeeeeeee-bc00-0000-0000-000000000001';

describe('GET /build/breadcrumb-context', () => {
  beforeAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, Missions,
            CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99401, name: '__TEST__ bc tag' });
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID, slug: '__test__-bc-tut', title: '__TEST__ Tut',
      experienceTag: 'beginner', primaryTagRef_ID: TAG_ID, status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 99411, slug: '__test__-bc-group',
      title: '__TEST__ Group', published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      group_ID: GROUP_ID, tutorial_ID: TUT_ID, itemOrder: 1,
    });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99421, slug: '__test__-bc-mission',
      title: '__TEST__ Mission', published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, mission_ID: MISSION_ID, name: 'p', legacyId: 99431,
    });
    await INSERT.into(CompletionPathItems).entries({
      path_ID: PATH_ID, group_ID: GROUP_ID, taskType: 'GROUP', itemOrder: 1,
    });
  });

  it('returns parent group + mission for a known tutorial', async () => {
    const { data, status } = await project.get('/build/breadcrumb-context?tutorial=__test__-bc-tut');
    expect(status).toBe(200);
    expect(data.groupSlug).toBe('__test__-bc-group');
    expect(data.groupTitle).toBe('__TEST__ Group');
    expect(data.missionSlug).toBe('__test__-bc-mission');
    expect(data.missionTitle).toBe('__TEST__ Mission');
  });

  it('returns 404 for unknown tutorial', async () => {
    const res = await project.get('/build/breadcrumb-context?tutorial=does-not-exist').catch(e => e.response);
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing parameter', async () => {
    const res = await project.get('/build/breadcrumb-context').catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid slug shape (path traversal)', async () => {
    const res = await project.get('/build/breadcrumb-context?tutorial=../etc/passwd').catch(e => e.response);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/breadcrumb-context.test.js
```

Expected: FAIL — handler not yet mounted.

- [ ] **Step 3: Write the handler**

```js
// srv/lib/breadcrumb-context.js
//
// GET /build/breadcrumb-context?tutorial=<slug>
//
// Returns the current parent group + mission for a tutorial so the
// tutorial-page breadcrumb island can refresh stale text after a rename.
// Anonymous, public; cached for 60s.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

export async function breadcrumbContextHandler(req, res) {
  const slug = String(req.query.tutorial || '').trim();
  if (!slug) {
    return res.status(400).json({ error: 'missing tutorial parameter' });
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(slug)) {
    return res.status(400).json({ error: 'invalid tutorial slug' });
  }

  try {
    const { Tutorials, GroupPathItems, Groups, CompletionPathItems,
            CompletionPaths, Missions } = cds.entities(NAMESPACE);

    const [tut] = await SELECT.from(Tutorials)
      .where({ slug })
      .columns('ID');
    if (!tut) {
      return res.status(404).json({ error: 'tutorial not found' });
    }

    const [gpi] = await SELECT.from(GroupPathItems)
      .where({ tutorial_ID: tut.ID })
      .columns('group_ID')
      .orderBy('itemOrder')
      .limit(1);

    if (!gpi?.group_ID) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json({});
    }

    const [group] = await SELECT.from(Groups)
      .where({ ID: gpi.group_ID })
      .columns('slug', 'title');

    const [cpi] = await SELECT.from(CompletionPathItems)
      .where({ group_ID: gpi.group_ID })
      .columns('path_ID')
      .orderBy('itemOrder')
      .limit(1);

    let mission = null;
    if (cpi?.path_ID) {
      const [path] = await SELECT.from(CompletionPaths)
        .where({ ID: cpi.path_ID })
        .columns('mission_ID');
      if (path?.mission_ID) {
        const [m] = await SELECT.from(Missions)
          .where({ ID: path.mission_ID })
          .columns('slug', 'title');
        mission = m || null;
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      missionTitle: mission?.title ?? null,
      missionSlug:  mission?.slug ?? null,
      groupTitle:   group?.title ?? null,
      groupSlug:    group?.slug ?? null,
    });
  } catch (err) {
    console.error('[build/breadcrumb-context]',
      err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: 'lookup failed' });
  }
}
```

- [ ] **Step 4: Mount the route**

In `srv/server.js`, add the import near the top alongside other `./lib/*` imports:

```js
import { breadcrumbContextHandler } from './lib/breadcrumb-context.js';
```

In the existing `/build/*` mount block (around line 115):

```js
  app.get('/build/breadcrumb-context', breadcrumbContextHandler);
```

- [ ] **Step 5: Confirm AppRouter route**

```bash
grep -A3 '"/build/' approuter/xs-app.json
```

Expected: a single broad `^/build/(.*)$` rule with `authenticationType: "none"`. No change needed.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run test/breadcrumb-context.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/breadcrumb-context.js srv/server.js test/breadcrumb-context.test.js
git commit -m "feat(build): /build/breadcrumb-context endpoint

Returns current parent group + mission slug+title for a tutorial. Used by
the tutorial-breadcrumbs island (next task) to refresh stale parent text
in static tutorial HTML after a Group/Mission rename, without waiting for
the next rebuild-content.yml run.

Anonymous, public, cached 60s. Strict slug-shape validation rejects path
traversal attempts.

Part of #91 server-side catalog rendering."
```

---

## Task 10: tutorial-breadcrumbs island

**Files:**
- Create: `hugo-apps/src/tutorial-breadcrumbs/main.ts`
- Modify: `hugo-apps/vite.config.ts`
- Modify: `hugo/layouts/partials/breadcrumbs.html`
- Modify: `hugo/layouts/_default/baseof.html`

A tiny vanilla-TS island (no Vue runtime) that fetches `/build/breadcrumb-context` on `DOMContentLoaded` and overwrites parent breadcrumb `<li>` text + href if the values changed. Falls back silently to the static text on any error.

- [ ] **Step 1: Add `data-bc-role` attributes to the breadcrumbs partial**

In [hugo/layouts/partials/breadcrumbs.html](../../hugo/layouts/partials/breadcrumbs.html), modify the mission and group `<li>` elements:

```html
<nav class="tutorial-breadcrumbs" aria-label="Breadcrumb">
  <ul class="fd-breadcrumb">
    <li class="fd-breadcrumb__item"><a class="fd-breadcrumb__link" href="/">Tutorial Navigator</a></li>
    {{ with .Params.missionTitle }}
    <li class="fd-breadcrumb__separator" aria-hidden="true"></li>
    <li class="fd-breadcrumb__item" data-bc-role="mission">
      <a class="fd-breadcrumb__link" data-bc-role-link href="/tutorials/mission-{{ $.Params.missionSlug }}">{{ . }}</a>
    </li>
    {{ end }}
    {{ with .Params.groupTitle }}
    <li class="fd-breadcrumb__separator" aria-hidden="true"></li>
    <li class="fd-breadcrumb__item" data-bc-role="group">
      <a class="fd-breadcrumb__link" data-bc-role-link href="/tutorials/group-{{ $.Params.groupSlug }}">{{ . }}</a>
    </li>
    {{ end }}
    <li class="fd-breadcrumb__separator" aria-hidden="true"></li>
    <li class="fd-breadcrumb__item fd-breadcrumb__item--current">
      <button type="button" id="nav-dropdown-toggle" class="breadcrumb-dropdown-toggle" aria-expanded="false" aria-haspopup="true">
        {{ .Title }} <span class="breadcrumb-chevron">▾</span>
      </button>
    </li>
  </ul>
  <div id="nav-dropdown-mount" data-slug="{{ .Params.slug }}" class="nav-dropdown-container"></div>
</nav>
```

The change: each parent `<li>` gets `data-bc-role="mission"` or `data-bc-role="group"`, and its anchor gets a `data-bc-role-link` marker.

- [ ] **Step 2: Write the island**

```ts
// hugo-apps/src/tutorial-breadcrumbs/main.ts
//
// Refreshes parent group + mission text in tutorial-page breadcrumbs after a
// Group/Mission rename. The static HTML carries last-build values; this fetch
// pulls the current state from /build/breadcrumb-context and overwrites the
// <li> text + href if it has changed.
//
// Failure mode: silent no-op. The static text from the last build remains —
// worst case is stale parent text, never a broken page.

interface BreadcrumbContext {
  missionTitle: string | null;
  missionSlug: string | null;
  groupTitle: string | null;
  groupSlug: string | null;
}

function refreshBreadcrumbRole(role: 'mission' | 'group', title: string | null, slug: string | null): void {
  if (!title || !slug) return;
  const li = document.querySelector(`li[data-bc-role="${role}"]`);
  if (!li) return;
  const link = li.querySelector('a[data-bc-role-link]') as HTMLAnchorElement | null;
  if (!link) return;
  const wantedHref = `/tutorials/${role}-${slug}`;
  if (link.textContent !== title) {
    link.textContent = title;
  }
  if (link.getAttribute('href') !== wantedHref) {
    link.setAttribute('href', wantedHref);
  }
}

async function refreshBreadcrumbs(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;

  try {
    const res = await fetch(`/build/breadcrumb-context?tutorial=${encodeURIComponent(slug)}`, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    const ctx: BreadcrumbContext = await res.json();
    refreshBreadcrumbRole('mission', ctx.missionTitle, ctx.missionSlug);
    refreshBreadcrumbRole('group', ctx.groupTitle, ctx.groupSlug);
  } catch {
    // Silent — static breadcrumb text is the fallback.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void refreshBreadcrumbs(); });
} else {
  void refreshBreadcrumbs();
}
```

- [ ] **Step 3: Wire into vite.config.ts**

In [hugo-apps/vite.config.ts](../../hugo-apps/vite.config.ts), find the `rollupOptions.input` block and add:

```ts
        'tutorial-breadcrumbs': resolve(__dirname, 'src/tutorial-breadcrumbs/main.ts'),
```

- [ ] **Step 4: Load the island from baseof.html (only on tutorial pages)**

In [hugo/layouts/_default/baseof.html](../../hugo/layouts/_default/baseof.html), find the existing `<script type="module" src="{{ $ui5.RelPermalink }}"></script>` line near the end of `<body>`. Above or below it, add:

```html
  {{ if eq .Type "tutorials" }}<script type="module" src="/js/tutorial-breadcrumbs.js" defer></script>{{ end }}
```

The `if eq .Type "tutorials"` gate keeps the bundle off non-tutorial pages where the breadcrumb partial isn't even rendered. Per project memo "QA-gate frontend script tags": this island fetches a `/build/*` endpoint that exists on srv-qa too (build routes are shared), so no QA gate needed — but if `static-qa/` is built without it, the script `404`'s and the island silently no-ops, which is acceptable.

- [ ] **Step 5: Build the island bundle**

```bash
cd d:/projects/tutorials-poc && npm --prefix hugo-apps run build 2>&1 | tail -10
ls hugo/static/js/tutorial-breadcrumbs.js
```

Expected: `tutorial-breadcrumbs.js` in `hugo/static/js/`. The `vite-plugin-css-injected-by-js` plugin shouldn't add CSS for a no-CSS island.

- [ ] **Step 6: Manual smoke (only if local Hugo + CAP are running)**

```bash
cd hugo && npx hugo --minify && cd ..
# Confirm <script> tag injection on a tutorial page
grep tutorial-breadcrumbs.js hugo/public/tutorials/<any-tutorial-slug>/index.html | head -2
# Confirm NOT injected on a homepage
grep tutorial-breadcrumbs.js hugo/public/index.html
```

Expected: tutorial page contains the script tag; homepage does not.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/tutorial-breadcrumbs/ hugo-apps/vite.config.ts \
  hugo/layouts/partials/breadcrumbs.html hugo/layouts/_default/baseof.html
git commit -m "feat(hugo): tutorial-breadcrumbs island for live parent refresh

Vanilla-TS island (~50 lines, no Vue runtime) fetches
/build/breadcrumb-context on DOMContentLoaded and overwrites parent
group + mission breadcrumb text + href if they have changed since the
last Hugo build. Silent no-op on any fetch error — static text from
last build remains.

Adds data-bc-role attributes to the breadcrumbs partial so the island
can target parent <li>s without brittle CSS-position selectors.
Loaded only on tutorial-type pages via baseof.html gate.

Part of #91 server-side catalog rendering."
```

---

## Task 11: Hybrid + smoke tests

**Files:**
- Create: `test/hybrid/catalog-renderer-hana.test.js`
- Create: `test/smoke/catalog-pages.test.js`

Hybrid validates real HANA LOB-locator handling for the `__shell__` BLOB. Smoke validates end-to-end against the deployed DEV system after the next deploy. Both gate the rollout.

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/catalog-renderer-hana.test.js
//
// Real-HANA test for the catalog renderer + chrome shell. Exercises the LOB
// locator path in chrome-shell.js (BLOB read via raw SQL on HANA), which the
// in-memory SQLite unit tests cannot validate. Read-only — no INSERTs.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';
import { loadGroupContext } from '../../srv/lib/catalog-data.js';
import { createShellLoader, composeShell } from '../../srv/lib/chrome-shell.js';
import { renderGroupBody } from '../../srv/lib/catalog-renderer.js';

describe('catalog-renderer against real HANA', () => {
  let group;

  beforeAll(async () => {
    await cds.connect.to('db');
    const { Groups } = cds.entities('com.sap.developers.ims');
    [group] = await SELECT.from(Groups)
      .where({ status: 'ACTIVE', published: true })
      .columns('slug', 'title')
      .limit(1);
    if (!group) throw new Error('no published Group in DEV — run setup-dev-data first');
  });

  it('loadGroupContext returns the full row from HANA', async () => {
    const ctx = await loadGroupContext(group.slug);
    expect(ctx).not.toBeNull();
    expect(ctx.group.slug).toBe(group.slug);
    expect(ctx.group.title).toBe(group.title);
  });

  it('chrome shell loads from ContentFiles BLOB without LOB locator expiry', async () => {
    const namespace = 'com.sap.developers.ims';
    const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
    const getActiveVersion = async () => {
      const { ContentManifest } = cds.entities(namespace);
      const [row] = await SELECT.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .columns('version');
      return row?.version ?? null;
    };
    const loader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

    const shell = await loader.get();
    if (!shell) {
      console.warn('No __shell__ row in DEV ContentFiles; skipping shell composition test');
      return;
    }
    expect(shell.before).toContain('<head>');
    expect(shell.after).toContain('</body>');
  });

  it('end-to-end render produces HTML with body + chrome', async () => {
    const namespace = 'com.sap.developers.ims';
    const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
    const getActiveVersion = async () => {
      const { ContentManifest } = cds.entities(namespace);
      const [row] = await SELECT.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .columns('version');
      return row?.version ?? null;
    };
    const loader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

    const ctx = await loadGroupContext(group.slug);
    const body = renderGroupBody(ctx);
    const shell = await loader.get();
    if (!shell) return; // covered above

    const html = composeShell(shell, body, {
      kind: 'group',
      slug: `group-${group.slug}`,
      title: group.title,
      description: ctx.group.description ?? '',
    });

    expect(html).toContain(group.title);
    expect(html).toContain(`data-page-kind="group"`);
    expect(html).toContain(`data-page-slug="group-${group.slug}"`);
    expect(html).toContain('class="group-wrapper"');
  }, 30000);
});
```

- [ ] **Step 2: Run the hybrid test**

```bash
cf login   # if not already logged in to DEV
npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/catalog-renderer-hana.test.js 2>&1 | tail -20
```

Expected: PASS (3 tests). If "no published Group in DEV" — run `npx cds bind --exec -- node scripts/setup-dev-data.cjs` first to populate slugs.

If `__shell__` warning fires, that's normal until Task 12 publishes the shell to DEV.

- [ ] **Step 3: Write the smoke test**

```js
// test/smoke/catalog-pages.test.js
//
// HTTP smoke against deployed DEV. Validates that /tutorials/group-* and
// /tutorials/mission-* are rendered server-side with full chrome.
//
// Requires SMOKE_SRV_URL (CAP srv URL) — not the approuter URL, since
// the route /tutorials/* on approuter rewrites to /content/tutorials/* on
// srv anyway, but smoke tests bypass approuter for speed and isolation.
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL ?? 'http://localhost:4004';
const KNOWN_GROUP_SLUG = process.env.SMOKE_GROUP_SLUG ?? 'group-test-two';
const KNOWN_MISSION_SLUG = process.env.SMOKE_MISSION_SLUG;

describe('catalog page smoke', () => {
  it('renders the known DEV group with full chrome', async () => {
    const url = `${BASE}/content/tutorials/${KNOWN_GROUP_SLUG}`;
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toMatch(/text\/html/);
    expect(res.headers.get('x-content-source')).toBe('rendered');

    const html = await res.text();
    // Body markup
    expect(html).toContain('class="group-wrapper"');
    expect(html).toContain('class="type-badge type-badge--group">GROUP');
    // Page meta
    expect(html).toMatch(/data-page-kind="group"/);
    expect(html).toMatch(new RegExp(`data-page-slug="${KNOWN_GROUP_SLUG}"`));
    // Chrome from baseof.html — these IDs MUST be present for parity with
    // Hugo-built tutorial pages
    expect(html).toContain('id="cmd-palette"');
    expect(html).toContain('id="step-toast"');
    expect(html).toContain('id="glossary-popover"');
  });

  it('renders the known DEV mission when set', async () => {
    if (!KNOWN_MISSION_SLUG) return; // optional
    const url = `${BASE}/content/tutorials/${KNOWN_MISSION_SLUG}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="mission-wrapper"');
    expect(html).toMatch(/data-page-kind="mission"/);
  });

  it('returns 404 for unknown group slug', async () => {
    const res = await fetch(`${BASE}/content/tutorials/group-does-not-exist-zzz`);
    expect(res.status).toBe(404);
  });

  it('serves render-cache on second request (X-Content-Source: render-cache)', async () => {
    const url = `${BASE}/content/tutorials/${KNOWN_GROUP_SLUG}`;
    await fetch(url); // prime
    const res = await fetch(url);
    expect(res.status).toBe(200);
    // Either 'render-cache' (LRU hit) or 'rendered' (cache evicted/cold) is acceptable;
    // assert it's NOT the legacy 'synthesized' or 'db' tag.
    const src = res.headers.get('x-content-source');
    expect(src).toMatch(/^(render-cache|rendered)$/);
  });

  it('breadcrumb-context endpoint responds', async () => {
    const res = await fetch(`${BASE}/build/breadcrumb-context?tutorial=does-not-exist-zzz`);
    expect([400, 404]).toContain(res.status);
  });
});
```

- [ ] **Step 4: Run the smoke test against DEV (after Task 12 deploy)**

```bash
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_GROUP_SLUG=group-test-two \
npx vitest run --project smoke test/smoke/catalog-pages.test.js 2>&1 | tail -20
```

Expected: 4-5 tests PASS. If rolling back the deploy is needed, the smoke test stays committed but won't be exercised until next deploy.

- [ ] **Step 5: Commit**

```bash
git add test/hybrid/catalog-renderer-hana.test.js test/smoke/catalog-pages.test.js
git commit -m "test(catalog): hybrid HANA + deployed smoke tests

Hybrid: read-only against real HANA — exercises chrome-shell BLOB load
through HANA LOB-locator handling that in-memory SQLite cannot validate.

Smoke: HTTP against deployed CAP srv — asserts X-Content-Source: rendered,
data-page-kind/slug/title attributes, chrome IDs (#cmd-palette,
#step-toast, #glossary-popover), and 404 for unknown slug.

Part of #91 server-side catalog rendering."
```

---

## Task 12: DEV deploy + parity check + visual validation

**Files:**
- Create (TEMPORARY — deleted before merge): `scripts/parity-check.js`

This task is the rollout gate. Snapshot DEV before, deploy, snapshot after, structurally diff, eyeball the result.

- [ ] **Step 1: Snapshot DEV "before" state**

```bash
mkdir -p .parity-snapshots
curl -s "https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/group-test-two" > .parity-snapshots/group-test-two.before.html
echo "Before snapshot: $(wc -c < .parity-snapshots/group-test-two.before.html) bytes"
```

- [ ] **Step 2: Write the parity-check script (throwaway)**

```js
// scripts/parity-check.js — TEMPORARY, deleted before PR merge.
//
// Structural diff between two HTML snapshots, ignoring noise (timestamps,
// data-cap-base, normalized whitespace). Surfaces meaningful differences
// without requiring pixel-level testing.
import { readFileSync } from 'node:fs';

if (process.argv.length < 4) {
  console.error('usage: node scripts/parity-check.js <before.html> <after.html>');
  process.exit(2);
}

const [, , beforePath, afterPath] = process.argv;
const before = readFileSync(beforePath, 'utf-8');
const after = readFileSync(afterPath, 'utf-8');

// Normalize: strip HTML comments, collapse whitespace, remove environment-only
// attributes that legitimately differ between old (Hugo blob) and new (rendered).
function normalize(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sdata-cap-base="[^"]*"/g, '')
    .replace(/\sdata-api-base="[^"]*"/g, '')
    .replace(/\sx-content-source="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const a = normalize(before);
const b = normalize(after);

if (a === b) {
  console.log('[parity] IDENTICAL after normalization');
  process.exit(0);
}

// Compare class-name presence as the primary structural signal — ensures the
// new output covers the same DOM hooks the existing CSS depends on.
const classRegex = /class="([^"]+)"/g;
function classes(html) {
  const set = new Set();
  for (const m of html.matchAll(classRegex)) {
    for (const c of m[1].split(/\s+/)) if (c) set.add(c);
  }
  return set;
}
const beforeClasses = classes(a);
const afterClasses = classes(b);
const missing = [...beforeClasses].filter(c => !afterClasses.has(c)).sort();
const added = [...afterClasses].filter(c => !beforeClasses.has(c)).sort();

console.log(`[parity] DIFFER after normalization (before: ${a.length}b, after: ${b.length}b)`);
if (missing.length) console.log(`  classes only in BEFORE (missing in new): ${missing.join(', ')}`);
if (added.length)   console.log(`  classes only in AFTER  (new in rendered): ${added.join(', ')}`);

const idRegex = /\sid="([^"]+)"/g;
function ids(html) {
  const set = new Set();
  for (const m of html.matchAll(idRegex)) set.add(m[1]);
  return set;
}
const beforeIds = ids(a);
const afterIds = ids(b);
const missingIds = [...beforeIds].filter(i => !afterIds.has(i)).sort();
if (missingIds.length) {
  console.log(`  IDs only in BEFORE (missing in new): ${missingIds.join(', ')}`);
}

process.exit(missing.length || missingIds.length ? 1 : 0);
```

- [ ] **Step 3: Confirm Tom-approved deploy scope**

Per project memo "Confirm Deploy Scope": ask Tom which scope before kicking off. For #91 the scope is **backend + content** (srv changes, Hugo changes, publish-content): full MTA build with both prod and QA Hugo built. Wait for confirmation before step 4.

- [ ] **Step 4: Build + deploy to DEV**

Per project memos "Local Deploy Process" and "Hugo must finish before mbt":

```bash
# Hugo must complete BEFORE mbt build (mbt only cp's hugo/public, doesn't run Hugo)
cd hugo && npx hugo --minify && cd ..
ls hugo/public/_shell/index.html  # MUST exist
npm --prefix hugo-apps run build
cd .deploy && mbt build && cf deploy "$(ls -1t mta_archives/*.mtar | head -1)" -e ../deploy/dev.mtaext -f && cd ..
```

- [ ] **Step 5: Publish content (force, with __shell__)**

Per project memo "publish-content needs --force":

```bash
export CONTENT_API_KEY="<DEV-content-api-key — fetch from BTP credstore, do NOT commit>"
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npm run publish-content -- --force
```

Expected: log includes `Included chrome shell (... bytes ...)` line. If not, the `_shell/index.html` file isn't getting built — re-check Task 4.

- [ ] **Step 6: Snapshot DEV "after" state**

```bash
curl -s "https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/group-test-two" > .parity-snapshots/group-test-two.after.html
echo "After snapshot: $(wc -c < .parity-snapshots/group-test-two.after.html) bytes"
```

- [ ] **Step 7: Run parity check**

```bash
node scripts/parity-check.js .parity-snapshots/group-test-two.before.html .parity-snapshots/group-test-two.after.html
```

Expected: exit 0 (IDENTICAL after normalization), or exit 1 with a small diff report. If classes/IDs are missing in the new output, fix the renderer in Task 3 and redeploy. Acceptable diffs:
- `data-page-step-count` attribute: present in old (from Hugo template), absent in new (irrelevant for groups). Update the normalizer to strip it.
- `tag-pill` class for `displayTags`: not yet implemented in the renderer. Add to Task 3 if missing classes report calls it out.

- [ ] **Step 8: Run smoke tests against DEV**

```bash
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_GROUP_SLUG=group-test-two \
npx vitest run --project smoke test/smoke/catalog-pages.test.js 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 9: Visual validation in browser**

Open the DEV URL in a browser. Confirm by eye:

1. `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/group-test-two`
2. Header shellbar present (logo, search, joule trigger, theme toggle, profile)
3. Breadcrumbs: "Tutorial Navigator > [group title]"
4. Type badge "GROUP"
5. Hero title, description, level/time/tutorial-count meta
6. Tutorial timeline cards with NEW badge if any tutorial is < 31 days old
7. Footer present
8. Toggle theme — light/dark CSS applies
9. ⌘K opens command palette
10. Console: no errors, no failed `/css/*` or `/js/*` requests

If any chrome element is missing → check `__shell__` row in HANA: `npx cds bind --exec -- node -e "const cds=require('@sap/cds'); cds.connect.to('db').then(async db=>{const [r]=await db.run('SELECT slug, sizeBytes FROM COM_SAP_DEVELOPERS_IMS_CONTENTFILES WHERE slug=?', [\"__shell__\"]); console.log(r);})"`.

- [ ] **Step 10: Tom signs off**

Show Tom the rendered page. Wait for explicit "looks good, merge it" before step 11.

- [ ] **Step 11: Delete the parity-check throwaway**

```bash
rm -rf scripts/parity-check.js .parity-snapshots/
```

- [ ] **Step 12: Push branch + open PR**

Per project memo "PR Over Direct Merge":

```bash
git push -u origin feature/server-side-catalog-rendering
gh pr create --base main --title "feat: server-side rendering for group & mission pages (#91)" \
  --body "$(cat <<'PRBODY'
Closes #91.

## What

Moves `/tutorials/group-*` and `/tutorials/mission-*` rendering off the
GitHub-fetch → Hugo build → publish-content → ContentFiles pipeline and
into the CAP backend. Catalog pages are now rendered server-side from DB
content with chrome (header, footer, joule, lightbox, glossary, cmd
palette, toast, breadcrumbs) byte-identical to today's Hugo output via a
Hugo-emitted `__shell__` ContentFiles slug.

## Why

The pipeline existed for tutorials whose markdown comes from GitHub.
Groups and missions never touch GitHub — they are pure DB content
maintained through the Admin UI. Routing them through the build was a
detour that left them broken between admin save and the next CI run.

After this PR: edit a group title in the Admin UI → next request shows
the change. Rename a group's slug → old URL still 301s to the new slug
via existing `GroupSlugRedirects`.

## Spec & plan

- Spec: `docs/superpowers/specs/2026-05-28-server-side-catalog-rendering-design.md`
- Plan: `docs/superpowers/plans/2026-05-28-server-side-catalog-rendering.md`

## DEV validation

- Parity check vs pre-deploy snapshot: identical after normalization (or
  the small acceptable diff list)
- Smoke tests: all pass
- Visual eyeball on `/tutorials/group-test-two`: full chrome, working
  joule + cmd palette + theme toggle

## Files

11 files modified, 5 created, 3 deleted (incl. legacy fallback). See the
diff.
PRBODY
)"
```

- [ ] **Step 13: Final commit (cleanup of temp scripts)**

```bash
git add -A
git status   # should show only deletions of parity-check.js and .parity-snapshots
git commit -m "chore: remove parity-check throwaway after #91 validation" 2>/dev/null || echo "nothing to commit"
git push
```

---

## Acceptance criteria recap

- [ ] `/tutorials/group-test-two` and `/tutorials/mission-<known-slug>` render with full chrome, indistinguishable from today's Hugo-built pages
- [ ] Editing a Group title or membership in the Admin UI is reflected on next page load (no CI rebuild required)
- [ ] Renaming a Group's slug → old URL 301s to new URL via existing `GroupSlugRedirects`
- [ ] Tutorial pages still show correct parent breadcrumb text after a Group rename, on next request (via the new client-side island)
- [ ] `rebuild-content.yml` no longer emits group/mission HTML; `publish-content` payload size drops by ~150 entries
- [ ] All unit, hybrid, and smoke tests pass
- [ ] Issue #91 closes
