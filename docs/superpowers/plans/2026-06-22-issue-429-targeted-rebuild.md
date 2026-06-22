# #429 Targeted Catalog/Slug Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-mode `scheduleRebuild('admin-write')` path with a 3-mode dispatcher (catalog-only / slug-targeted / full + force-cap-refetch) that auto-classifies each admin write to the cheapest valid rebuild — 30-60s for ~80% of admin saves vs the current 10-13 min full rebuild.

**Architecture:** A pure classifier helper (`_classify-rebuild-mode.js`) routes each entity/action to a `{ mode, slug, forceCapRefetch }` triple. `scheduleRebuild` accepts these as opts, merges them across the 60s debounce window using `full > slug-targeted > catalog-only` priority + a 50-slug accumulator cap, and reads `GITHUB_DISPATCH_TOKEN` from BTP Credential Store with a 5-min cache + env fallback. The workflow gets a `mode` input that skips fetch/Vue/AI-quiz/admin-SPA-build steps when the trigger doesn't need them. Migration scripts short-circuit per-row dispatches via the existing `x-migration-mode` header and trigger one final full rebuild at end-of-run.

**Tech Stack:** Node.js 22 ESM, vitest, `@sap/cds`, GitHub Actions workflow YAML, BTP Credential Store (via existing `srv/lib/credstore.js`).

**Spec:** [`docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md`](../specs/2026-06-22-issue-429-targeted-rebuild-design.md)

---

## File Structure

**New files:**

- [`srv/lib/_classify-rebuild-mode.js`](../../../srv/lib/_classify-rebuild-mode.js) — Pure classifier helper: `classifyRebuildMode(entityOrActionName, kind)` + `resolveSlugForEntity(entityName, row)`.
- [`test/unit/_classify-rebuild-mode.test.js`](../../../test/unit/_classify-rebuild-mode.test.js) — Table-driven classifier tests + Tutorials/Steps slug-resolver coverage (with `cds.test('serve', '--in-memory')` boot for the Steps→Tutorial lookup).
- [`test/unit/rebuild-trigger.test.js`](../../../test/unit/rebuild-trigger.test.js) — New tests for the opts-based signature, mode-merge, slug-accumulate, slug-cap-50, forceCapRefetch-sticky, credstore-cache, env-fallback.
- [`test/scripts/migrate-end-of-run-dispatch.test.js`](../../../test/scripts/migrate-end-of-run-dispatch.test.js) — Mocks `fetch` to verify migration scripts post the right `mode: 'full'` body shape.

**Modified files:**

- [`.github/workflows/rebuild-content.yml`](../../../.github/workflows/rebuild-content.yml) — Add `mode` input; add per-step `if:` conditions.
- [`srv/lib/rebuild-trigger.js`](../../../srv/lib/rebuild-trigger.js) — Signature change to opts-based; add mode-merge state; replace `process.env.GITHUB_DISPATCH_TOKEN` with credstore-backed `getDispatchToken()`.
- [`srv/server.js`](../../../srv/server.js) — Replace single `scheduleRebuild('admin-write')` call with classifier-driven dispatch; add 4 bound-action hooks; expand `navInvalidatingEntities` to include `Steps` and `Tags`; add `x-migration-mode` short-circuit.
- [`scripts/migrate-reference-data.js`](../../../scripts/migrate-reference-data.js) — End-of-run `fetch` call to `workflow_dispatch` for `import` and `populate-slugs` modes (NOT for `export`).
- [`scripts/migrate-user-progress.js`](../../../scripts/migrate-user-progress.js) — Same for `import` mode (NOT for `export`).
- [`docs/developers/operations/secrets-tracking.md`](../../../docs/developers/operations/secrets-tracking.md) — Append a "Bootstrap: GITHUB_DISPATCH_TOKEN" section.

---

## Task 0: Pre-Flight Sanity

**Files:** None modified — verification only.

- [ ] **Step 0: Verify branch is `worktree-429-targeted-rebuild`**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
git branch --show-current
```

Expected: `worktree-429-targeted-rebuild`. If anything else, STOP and re-checkout. See memory [[feedback_branch_slip_after_long_session]].

- [ ] **Step 1: Verify baseline tests pass**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit 2>&1 | tail -5
```

Record the baseline pass count (e.g. "Test Files N passed (N) Tests M passed (M)"). Tasks 2-5 will add tests; the final sanity pass (Task 7) re-runs the same set and asserts ≥M passing.

- [ ] **Step 2: Verify the workflow YAML parses**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/rebuild-content.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`. If parser errors, STOP — current main is broken and we'd be building on sand.

- [ ] **Step 3: Confirm dependencies exist**

```bash
node -e "import('./srv/lib/credstore.js').then(m => console.log('credstore exports:', Object.keys(m).join(', ')));"
```

Expected output includes `readSecret`, `writeSecret`. Spec assumes both. If `readSecret` is missing, halt and re-check the spec's credstore reference.

- [ ] **Step 4: Confirm the `navInvalidatingEntities` array shape**

```bash
grep -n 'navInvalidatingEntities' srv/server.js
```

Expected: line ~480 declares the array with 7 entries (`Missions`, `Groups`, `CompletionPaths`, `CompletionPathItems`, `GroupPathItems`, `Tutorials`, `FeaturedTasks`). Task 4 will add `Steps` and `Tags`.

- [ ] **Step 5: Probe the workflow's current step list**

```bash
grep -nE '^      - name:' .github/workflows/rebuild-content.yml
```

Record the step names + line numbers — Task 1 will add `if:` conditions to specific steps. Useful reference.

---

## Task 1: Workflow YAML — Add `mode` Input + Per-Step Skips

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`

This task is independent of the srv-side work — can be implemented and merged on its own if needed.

- [ ] **Step 1: Add the `mode` input**

In `.github/workflows/rebuild-content.yml`, find the `workflow_dispatch.inputs:` block. After the existing `publish-batch-size:` input (~line 53), add a new input:

```yaml
      mode:
        description: |
          Rebuild scope. 'full' (default) re-fetches all tutorials, rebuilds Vue apps, runs full publish.
          'catalog-only' skips fetch + Vue + AI quiz; just rebuilds Hugo from cached markdown + new
          browse.json and runs publish-content --heal. 30-60s wall clock. 'slug-targeted' uses the
          existing `slug`/`slugs` inputs to re-fetch only those slugs; same 30-60s wall clock.
        required: false
        default: full
        type: choice
        options:
          - full
          - catalog-only
          - slug-targeted
```

- [ ] **Step 2: Add per-step `if:` conditions**

Add the `if:` block to each step as listed below (preserving existing other YAML around each step):

| Step name | New `if:` value |
|---|---|
| `Fetch tutorials` | `if: ${{ inputs.mode != 'catalog-only' }}` |
| `Lint tutorial markdown` | `if: ${{ inputs.mode != 'catalog-only' }}` |
| `Upload tutorial-markdown lint report` | `if: ${{ always() && inputs.mode != 'catalog-only' }}` (preserves the existing `if: always()` semantics) |
| `Validate tutorials` | `if: ${{ inputs.mode != 'catalog-only' }}` |
| `Build Vue apps` | `if: ${{ inputs.mode == 'full' }}` |
| `Copy Joule vendor bundles` | `if: ${{ inputs.mode == 'full' }}` |
| `Build display app` | `if: ${{ inputs.mode == 'full' }}` |
| `Build admin SPAs` (and the tarball + STATIC_DIR swap steps that follow it) | `if: ${{ inputs.mode == 'full' }}` |

**Critical:** `Build Hugo site` and `Publish tutorial content to HANA` MUST NOT get an `if:` — they always run, regardless of mode. Catalog-only needs both.

For each step that already has an `if:` (e.g. `Set up VCAP_SERVICES for AI authoring` has `if: ${{ inputs.ai-author-enabled == true }}`), keep the existing condition AND add the mode condition with `&&`:

```yaml
      - name: Set up VCAP_SERVICES for AI authoring
        if: ${{ inputs.ai-author-enabled == true && inputs.mode != 'catalog-only' }}
```

The AI quiz step is implicitly mode-gated because `ai-author-enabled` is paired with `fetch-tutorials`; making it explicit is defensive.

- [ ] **Step 3: Verify YAML still parses**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
python -c "import yaml; yaml.safe_load(open('.github/workflows/rebuild-content.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`.

- [ ] **Step 4: Eyeball the diff**

```bash
git diff .github/workflows/rebuild-content.yml | head -80
```

Confirm: 1 new `mode` input; per-step `if:` conditions on the right steps; `Build Hugo site` and `Publish tutorial content` UNCHANGED (no `if:`).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # MUST be worktree-429-targeted-rebuild
git add .github/workflows/rebuild-content.yml
git commit -m "feat(ci): #429 — add mode input + per-step skips for catalog-only/slug-targeted rebuilds"
```

---

## Task 2: Pure Classifier Helper + Failing Tests

**Files:**
- Create: `srv/lib/_classify-rebuild-mode.js`
- Create: `test/unit/_classify-rebuild-mode.test.js`

TDD: write failing tests first, then implement.

- [ ] **Step 1: Write the failing test file**

Create `test/unit/_classify-rebuild-mode.test.js`:

```javascript
/**
 * Unit tests for the pure rebuild-mode classifier. No I/O, no CDS boot
 * for the classifier itself; the Steps→Tutorial slug resolver gets a
 * separate cds.test('serve') boot for its one SELECT path.
 *
 * Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §2
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { classifyRebuildMode, resolveSlugForEntity } from '../../srv/lib/_classify-rebuild-mode.js';

// Boot CDS once at file top so the Steps→Tutorial resolver test can hit a
// real in-memory DB. The pure-path describes below don't depend on this,
// but vitest hooks register correctly regardless. Pattern matches
// test/notification-reset.test.js.
cds.test('serve', '--project', '.', '--in-memory');

describe('classifyRebuildMode', () => {
  it.each([
    // CRUD on nav-invalidating entities
    ['Missions',              'crud', 'catalog-only', false, false],
    ['Groups',                'crud', 'catalog-only', false, false],
    ['CompletionPaths',       'crud', 'catalog-only', false, false],
    ['CompletionPathItems',   'crud', 'catalog-only', false, false],
    ['GroupPathItems',        'crud', 'catalog-only', false, false],
    ['FeaturedTasks',         'crud', 'catalog-only', false, false],
    // Slug-targeted
    ['Tutorials',             'crud', 'slug-targeted', false, true],
    ['Steps',                 'crud', 'slug-targeted', false, true],
    // Full + force-cap-refetch
    ['Tags',                  'crud', 'full',         true,  false],
    // Safe default: anything else → full, no force
    ['Advocates',             'crud', 'full',         false, false],
    ['SomeFutureEntity',      'crud', 'full',         false, false],
    // Bound actions
    ['classifyCategories',    'action', 'catalog-only', false, false],
    ['setFeaturedOrder',      'action', 'catalog-only', false, false],
    ['commitTagImport',       'action', 'full',         true,  false],
    ['cleanupUnusedTags',     'action', 'full',         true,  false],
    // Unrecognized action → safe default
    ['rotateSecretValue',     'action', 'full',         false, false],
    ['uploadPhoto',           'action', 'full',         false, false],
  ])('classify(%s, %s) → mode=%s force=%s slug=%s', (name, kind, expectedMode, expectedForce, expectedSlug) => {
    const out = classifyRebuildMode(name, kind);
    expect(out.mode).toBe(expectedMode);
    expect(out.forceCapRefetch).toBe(expectedForce);
    expect(out.needsSlug).toBe(expectedSlug);
  });

  it('defaults kind to "crud" when omitted', () => {
    const out = classifyRebuildMode('Missions');
    expect(out.mode).toBe('catalog-only');
  });
});

describe('resolveSlugForEntity (pure paths)', () => {
  it('returns row.slug for Tutorials when present', async () => {
    expect(await resolveSlugForEntity('Tutorials', { slug: 'foo' })).toBe('foo');
  });

  it('returns null when Tutorials row has no slug', async () => {
    expect(await resolveSlugForEntity('Tutorials', {})).toBeNull();
  });

  it('returns null for null row', async () => {
    expect(await resolveSlugForEntity('Tutorials', null)).toBeNull();
  });

  it('returns null for Steps with no tutorial_ID', async () => {
    expect(await resolveSlugForEntity('Steps', {})).toBeNull();
  });

  it('returns null for unknown entity', async () => {
    expect(await resolveSlugForEntity('Advocates', { ID: 'x' })).toBeNull();
  });
});

// The Steps-with-tutorial_ID path needs a real CDS DB to exercise the SELECT.
// Pattern matches test/notification-reset.test.js (per memory feedback_default_off_flags_need_live_smoke).
// cds.test() was already called at the top of the file.

describe('resolveSlugForEntity — Steps→Tutorial via CDS', () => {
  beforeAll(async () => {
    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-4290-0000-0000-000000000001',
      slug: 'pr429-tut-1',
      title: '#429 fixture tutorial',
      status: 'ACTIVE',
    });
    await INSERT.into(Steps).entries({
      ID: 'bbbbbbbb-4290-0000-0000-000000000001',
      tutorial_ID: 'aaaaaaaa-4290-0000-0000-000000000001',
      title: 'Step 1',
      stepOrder: 1,
    });
  });

  it('returns parent tutorial slug when row.tutorial_ID resolves', async () => {
    const slug = await resolveSlugForEntity('Steps', {
      tutorial_ID: 'aaaaaaaa-4290-0000-0000-000000000001',
    });
    expect(slug).toBe('pr429-tut-1');
  });

  it('returns null when row.tutorial_ID points at a non-existent tutorial (orphan FK)', async () => {
    const slug = await resolveSlugForEntity('Steps', {
      tutorial_ID: 'ffffffff-9999-9999-9999-999999999999',
    });
    expect(slug).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/_classify-rebuild-mode.test.js 2>&1 | tail -15
```

Expected: FAIL at module-load with `Cannot find module '../../srv/lib/_classify-rebuild-mode.js'` (file doesn't exist yet). Confirms the import path is correct.

- [ ] **Step 3: Create the classifier**

Create `srv/lib/_classify-rebuild-mode.js`:

```javascript
// srv/lib/_classify-rebuild-mode.js
//
// Pure helpers for routing admin writes to the right rebuild mode.
// Imported by srv/server.js admin.after hooks; tested directly via vitest.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
// Issue: #429

import cds from '@sap/cds';

// Entities whose CRUD changes /browse/ catalog data but NOT tutorial-page
// content. Catalog data lives in hugo/data/browse.json (built from
// /build/catalog) and is consumed by /browse/ + mission/group landing pages.
// Tutorial-page breadcrumbs read from cached frontmatter at Hugo build time,
// so a Hugo rebuild captures them without re-fetching markdown.
const CATALOG_ONLY_ENTITIES = new Set([
  'Missions',
  'Groups',
  'CompletionPaths',
  'CompletionPathItems',
  'GroupPathItems',
  'FeaturedTasks',
]);

// Entities whose CRUD targets a specific tutorial. Re-fetch one markdown,
// rebuild Hugo (cheap when only 1 page changed), publish-content --heal.
const SLUG_TARGETED_ENTITIES = new Set([
  'Tutorials',
  'Steps',  // resolves via Step.tutorial_ID → Tutorials.slug at hook time
]);

// Entities whose CRUD affects tutorial frontmatter (display tag labels)
// across many tutorials. Full rebuild with force-cap-refetch=true is the
// safe-but-fast path — the GitHub markdown cache hits so only frontmatter
// regenerates against fresh /build/tag-labels.
const FULL_FORCE_CAP_REFETCH_ENTITIES = new Set([
  'Tags',
]);

// Bound actions on AdminService that mutate catalog state without going
// through standard CRUD on the entities above. Each needs an explicit hook
// because admin.after('CREATE'|'UPDATE'|'DELETE', ...) doesn't catch them.
const CATALOG_ONLY_ACTIONS = new Set([
  'classifyCategories',  // mutates MissionCategories/GroupCategories junctions
  'setFeaturedOrder',    // changes /browse/ featured ordering
]);

const FULL_FORCE_CAP_REFETCH_ACTIONS = new Set([
  'commitTagImport',     // bulk-creates Tag rows (affects tutorial frontmatter)
  'cleanupUnusedTags',   // deletes orphan Tag rows (affects tutorial frontmatter)
]);

/**
 * Classify an entity-CRUD or bound-action trigger to a rebuild mode.
 *
 * Unrecognized names fall through to { mode: 'full', forceCapRefetch: false,
 * needsSlug: false } — safe-by-default. New catalog-affecting entities/actions
 * MUST be added to one of the sets above to get the cheaper rebuild.
 *
 * @param {string} entityOrActionName — bare entity name (e.g. 'Missions') or
 *                                       bound action name (e.g. 'classifyCategories')
 * @param {'crud'|'action'} kind — defaults to 'crud'
 * @returns {{
 *   mode: 'catalog-only'|'slug-targeted'|'full',
 *   forceCapRefetch: boolean,
 *   needsSlug: boolean,
 * }}
 */
export function classifyRebuildMode(entityOrActionName, kind = 'crud') {
  if (kind === 'crud') {
    if (CATALOG_ONLY_ENTITIES.has(entityOrActionName)) {
      return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false };
    }
    if (SLUG_TARGETED_ENTITIES.has(entityOrActionName)) {
      return { mode: 'slug-targeted', forceCapRefetch: false, needsSlug: true };
    }
    if (FULL_FORCE_CAP_REFETCH_ENTITIES.has(entityOrActionName)) {
      return { mode: 'full', forceCapRefetch: true, needsSlug: false };
    }
    return { mode: 'full', forceCapRefetch: false, needsSlug: false };
  }
  if (CATALOG_ONLY_ACTIONS.has(entityOrActionName)) {
    return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false };
  }
  if (FULL_FORCE_CAP_REFETCH_ACTIONS.has(entityOrActionName)) {
    return { mode: 'full', forceCapRefetch: true, needsSlug: false };
  }
  return { mode: 'full', forceCapRefetch: false, needsSlug: false };
}

/**
 * Best-effort slug resolution for an entity row.
 * - Tutorials: returns row.slug directly.
 * - Steps: walks Step.tutorial_ID → Tutorials.slug via CQL.
 * - Anything else / lookup failure / null row: returns null. Caller falls back
 *   to 'full' mode.
 *
 * The CQL SELECT for Steps runs against the active cds connection — works
 * in unit tests via cds.test() AND in production. Any thrown error
 * (transient DB hiccup, schema mismatch) is caught and yields null, which
 * the admin.after hook in srv/server.js translates to a 'full' fallback
 * (with WARN log) instead of crashing the admin save.
 *
 * @param {string} entityName
 * @param {object|null} row — the saved entity row from req.data
 * @returns {Promise<string|null>}
 */
export async function resolveSlugForEntity(entityName, row) {
  if (!row) return null;
  if (entityName === 'Tutorials') {
    return row.slug ?? null;
  }
  if (entityName === 'Steps') {
    if (!row.tutorial_ID) return null;
    try {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const tut = await SELECT.one.from(Tutorials).columns('slug').where({ ID: row.tutorial_ID });
      return tut?.slug ?? null;
    } catch (_err) {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/_classify-rebuild-mode.test.js 2>&1 | tail -10
```

Expected: all tests PASS. Roughly 19 test cases.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # MUST be worktree-429-targeted-rebuild
git add srv/lib/_classify-rebuild-mode.js test/unit/_classify-rebuild-mode.test.js
git commit -m "feat(rebuild-trigger): #429 — pure classifyRebuildMode + resolveSlugForEntity helper"
```

---

## Task 3: Refactor `rebuild-trigger.js` to Opts + Mode-Merge + Credstore

**Files:**
- Modify: `srv/lib/rebuild-trigger.js`
- Create: `test/unit/rebuild-trigger.test.js`

TDD: write failing tests first against the new signature, then refactor.

- [ ] **Step 1: Write failing tests**

Create `test/unit/rebuild-trigger.test.js`:

```javascript
/**
 * Unit tests for #429 — opts-based scheduleRebuild + mode-merge + slug-accumulate
 * + credstore-backed token + env fallback.
 *
 * Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scheduleRebuild, _resetForTests } from '../../srv/lib/rebuild-trigger.js';

// Note: rebuild-trigger.js imports './credstore.js' lazily inside getDispatchToken.
// vi.mock the module so unit tests don't need a real BTP binding.
vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),  // default: credstore has no value
}));

describe('scheduleRebuild — opts-based signature (#429)', () => {
  let captured;
  let mockDispatch;

  beforeEach(async () => {
    captured = [];
    mockDispatch = vi.fn().mockImplementation(async (inputs) => {
      captured.push(inputs);
      return { status: 204 };
    });
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: 'test-token' });
    // Reset credstore mock
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
  });

  it('dispatches with mode=full by default (back-compat)', async () => {
    await scheduleRebuild('admin-write');
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('dispatches with mode=catalog-only when passed in opts', async () => {
    await scheduleRebuild('admin-write', { mode: 'catalog-only' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('catalog-only');
  });

  it('upgrades catalog-only → full when a full trigger fires during the window', async () => {
    await scheduleRebuild('a', { mode: 'catalog-only' });
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('does NOT downgrade full → catalog-only', async () => {
    await scheduleRebuild('a', { mode: 'full' });
    await scheduleRebuild('b', { mode: 'catalog-only' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('upgrades catalog-only → slug-targeted (rank-2 beats rank-1)', async () => {
    await scheduleRebuild('a', { mode: 'catalog-only' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-x' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('slug-targeted');
    expect(captured[0].slugs).toBe('tut-x');
  });

  it('accumulates slugs across multiple slug-targeted calls', async () => {
    await scheduleRebuild('a', { mode: 'slug-targeted', slug: 'tut-a' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-b' });
    await scheduleRebuild('c', { mode: 'slug-targeted', slug: 'tut-c' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    const slugs = captured[0].slugs.split(',').sort();
    expect(slugs).toEqual(['tut-a', 'tut-b', 'tut-c']);
  });

  it('dedupes repeated slugs in the accumulator', async () => {
    await scheduleRebuild('a', { mode: 'slug-targeted', slug: 'tut-a' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-a' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0].slugs).toBe('tut-a');
  });

  it('upgrades slug-targeted → full when slug accumulator exceeds 50', async () => {
    for (let i = 0; i < 51; i++) {
      await scheduleRebuild('bulk', { mode: 'slug-targeted', slug: `tut-${i}` });
    }
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
    expect(captured[0].slugs).toBeUndefined();  // slugs cleared on cap
  });

  it('forceCapRefetch is sticky (once set, stays set)', async () => {
    await scheduleRebuild('a', { mode: 'full', forceCapRefetch: true });
    await scheduleRebuild('b', { mode: 'full', forceCapRefetch: false });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0]['force-cap-refetch']).toBe(true);
  });

  it('does NOT include force-cap-refetch input when never set', async () => {
    await scheduleRebuild('a', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0]['force-cap-refetch']).toBeUndefined();
  });
});

describe('scheduleRebuild — token resolution (#429)', () => {
  let captured;
  let mockDispatch;

  beforeEach(() => {
    captured = [];
    mockDispatch = vi.fn().mockImplementation(async (inputs) => {
      captured.push(inputs);
      return { status: 204 };
    });
  });

  it('no-op when neither credstore nor env has a token', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
    delete process.env.GITHUB_DISPATCH_TOKEN;
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(0);
  });

  it('uses env fallback when credstore returns null', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
    process.env.GITHUB_DISPATCH_TOKEN = 'env-token';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });

  it('uses credstore value when available (takes precedence over env)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue('credstore-token');
    process.env.GITHUB_DISPATCH_TOKEN = 'env-token';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(credstore.readSecret).toHaveBeenCalledWith('GITHUB_DISPATCH_TOKEN');
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });

  it('caches the credstore lookup within the 5-min TTL window', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue('cached-token');
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('a', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(2);
    // Both dispatches happened, but credstore was only consulted once thanks
    // to the in-memory TTL cache.
    expect(credstore.readSecret).toHaveBeenCalledTimes(1);
  });

  it('falls back to env when credstore throws', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockRejectedValue(new Error('credstore unavailable'));
    process.env.GITHUB_DISPATCH_TOKEN = 'env-fallback';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/rebuild-trigger.test.js 2>&1 | tail -15
```

Expected: many tests FAIL (the new opts signature isn't there yet). The default-mode-full one might pass coincidentally because the old single-arg signature ignored the second arg. Either way, fix in step 3.

- [ ] **Step 3: Refactor `srv/lib/rebuild-trigger.js`**

Replace the entire file with:

```javascript
// srv/lib/rebuild-trigger.js
//
// Debounced GitHub workflow_dispatch trigger for admin writes.
// When admins save through AdminService, this module dispatches a rebuild
// after a 60s quiet window. The dispatch's `mode` is auto-classified by
// srv/lib/_classify-rebuild-mode.js based on what was saved.
//
// 3-mode dispatch shape (#429):
//   - 'catalog-only'   → 30-60s, skips fetch + Vue + AI quiz
//   - 'slug-targeted'  → 30-60s, re-fetches only listed slug(s)
//   - 'full'           → 10-13 min (or 3-5 min with force-cap-refetch on cache hit)
//
// Token sourcing: BTP Credential Store via srv/lib/credstore.js, with a
// 5-min in-memory TTL cache and a process.env fallback for local dev / unit
// tests. The Secrets row is bootstrapped manually via the admin Secrets UI;
// see docs/developers/operations/secrets-tracking.md#bootstrap-github_dispatch_token.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
// Issue: #429. Uses native fetch (Node >= 20) — no octokit dependency.

import { resolveTenantSettings } from './runtime-config/tenant-settings.js';

const REPO_OWNER = 'sap-tutorials';
const REPO_NAME = 'tutorials-ims';
const WORKFLOW_FILE = 'rebuild-content.yml';
const DEFAULT_DEBOUNCE_MS = 60_000;
const GITHUB_API = 'https://api.github.com';

// Token cache TTL — 5 min. Rotation via admin Secrets UI takes effect on
// the next cache miss (or immediately after a tutorials-srv restart).
const TOKEN_TTL_MS = 5 * 60 * 1000;

// Mode-merge priority — higher rank wins during the debounce window.
const RANK = { 'catalog-only': 1, 'slug-targeted': 2, 'full': 3 };

// Slug-accumulator cap. Beyond this, fall back to 'full' mode to avoid a
// massive comma-separated slugs payload to the workflow_dispatch API.
// Configurable promotion to env var is YAGNI — bulk admin operations >50
// rows in a single 60s window are rare; migration scripts skip the trigger
// entirely via x-migration-mode.
const SLUG_ACCUMULATOR_CAP = 50;

let _state = {
  // Token resolution
  cachedToken: null,
  cachedTokenExpiresAt: 0,
  // Debounce
  debounceMs: DEFAULT_DEBOUNCE_MS,
  pendingTimer: null,
  pendingReason: null,
  // Mode-merge state
  pendingMode: null,                 // null | 'catalog-only' | 'slug-targeted' | 'full'
  pendingSlugs: new Set(),
  pendingForceCapRefetch: false,
  // Injection point for tests
  dispatchFn: defaultDispatch,
};

/**
 * Resolve the GITHUB_DISPATCH_TOKEN with credstore-first + env fallback +
 * 5-min TTL cache. Returns null if neither source has a value.
 */
async function getDispatchToken() {
  if (_state.cachedToken && Date.now() < _state.cachedTokenExpiresAt) {
    return _state.cachedToken;
  }
  let token = null;
  try {
    const { readSecret } = await import('./credstore.js');
    token = await readSecret('GITHUB_DISPATCH_TOKEN');
  } catch (err) {
    // Credstore unavailable (no BTP binding / network blip / decryption
    // failure). Log once per cache window so we see the gap without flooding.
    console.warn(`[rebuild-trigger] credstore lookup failed (falling back to env): ${err.message ?? err}`);
  }
  if (!token) {
    token = process.env.GITHUB_DISPATCH_TOKEN ?? null;
  }
  if (token) {
    _state.cachedToken = token;
    _state.cachedTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  }
  return token;
}

async function defaultDispatch(inputs) {
  const token = await getDispatchToken();
  if (!token) return { status: 0, skipped: true };
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return { status: res.status };
}

/**
 * Merge a new (mode, slug, forceCapRefetch) trigger into the pending state.
 * Mode: take the higher RANK. Slug: add to Set (deduped). Cap exceeded →
 * upgrade to 'full' and clear the set. ForceCapRefetch: sticky once set.
 */
function mergePending({ mode, slug, forceCapRefetch }) {
  if (!_state.pendingMode || RANK[mode] > RANK[_state.pendingMode]) {
    _state.pendingMode = mode;
  }
  if (slug) {
    _state.pendingSlugs.add(slug);
    if (_state.pendingSlugs.size > SLUG_ACCUMULATOR_CAP) {
      _state.pendingMode = 'full';
      _state.pendingSlugs.clear();
    }
  }
  if (forceCapRefetch) {
    _state.pendingForceCapRefetch = true;
  }
}

/**
 * Schedule a rebuild dispatch after the debounce window.
 *
 * @param {string} reason — diagnostic string surfaced as 'trigger-source' input
 * @param {object} opts
 * @param {'catalog-only'|'slug-targeted'|'full'} [opts.mode='full']
 * @param {string|null} [opts.slug=null]
 * @param {boolean} [opts.forceCapRefetch=false]
 */
export async function scheduleRebuild(reason, opts = {}) {
  const mode = opts.mode ?? 'full';
  const slug = opts.slug ?? null;
  const forceCapRefetch = opts.forceCapRefetch ?? false;

  // Note: we no longer short-circuit on missing token here. getDispatchToken()
  // is async + credstore-backed; deferring the check to dispatch time lets us
  // pick up a freshly-set token without restarting srv. The default dispatchFn
  // returns { skipped: true } when token is unset.

  if (_state.pendingTimer) {
    clearTimeout(_state.pendingTimer);
  }
  _state.pendingReason = reason;
  mergePending({ mode, slug, forceCapRefetch });

  _state.pendingTimer = setTimeout(async () => {
    const reasonAtFire = _state.pendingReason;
    const modeAtFire = _state.pendingMode ?? 'full';
    const slugsAtFire = [..._state.pendingSlugs];
    const forceCapRefetchAtFire = _state.pendingForceCapRefetch;
    // Reset state immediately so a new trigger during the dispatch starts
    // a fresh window.
    _state.pendingTimer = null;
    _state.pendingReason = null;
    _state.pendingMode = null;
    _state.pendingSlugs = new Set();
    _state.pendingForceCapRefetch = false;

    try {
      const { rebuildTargetEnv } = await resolveTenantSettings();
      const inputs = {
        'trigger-source': reasonAtFire,
        environment: rebuildTargetEnv,
        mode: modeAtFire,
      };
      if (modeAtFire === 'slug-targeted' && slugsAtFire.length > 0) {
        inputs.slugs = slugsAtFire.join(',');
      }
      if (forceCapRefetchAtFire) {
        inputs['force-cap-refetch'] = true;
      }
      await _state.dispatchFn(inputs);
    } catch (err) {
      console.error('[rebuild-trigger] dispatch failed:', err.message ?? err);
      // Do NOT rethrow. Admin save already succeeded; the next trigger
      // picks up the missed change.
    }
  }, _state.debounceMs);
}

// One-time boot warning if no token is reachable.
let _bootWarned = false;
export async function checkFeatureFlag() {
  if (_bootWarned) return;
  _bootWarned = true;
  const token = await getDispatchToken();
  if (!token) {
    console.warn('[rebuild-trigger] GITHUB_DISPATCH_TOKEN unreachable from credstore or env — admin writes will not trigger rebuilds. Set via /admin-ui/#secrets-display.');
  } else {
    console.log('[rebuild-trigger] active — admin writes will dispatch (target env resolved per-call from TenantSettings).');
  }
}

// Test-only escape hatch.
export function _resetForTests({ dispatchFn, debounceMs, token } = {}) {
  if (_state.pendingTimer) clearTimeout(_state.pendingTimer);
  _state = {
    cachedToken: token ?? null,
    cachedTokenExpiresAt: token ? Date.now() + TOKEN_TTL_MS : 0,
    debounceMs: debounceMs ?? DEFAULT_DEBOUNCE_MS,
    pendingTimer: null,
    pendingReason: null,
    pendingMode: null,
    pendingSlugs: new Set(),
    pendingForceCapRefetch: false,
    dispatchFn: dispatchFn ?? defaultDispatch,
  };
  _bootWarned = false;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/rebuild-trigger.test.js 2>&1 | tail -10
```

Expected: all tests PASS. Roughly 15 test cases.

- [ ] **Step 5: Spot-check that nothing else imports the OLD signature**

```bash
grep -rn 'scheduleRebuild' srv/ test/ scripts/ 2>&1 | grep -v 'rebuild-trigger.js' | head -10
```

Expected: each call site uses either no second arg (back-compat) OR an opts object. Single-string second-arg callers like `scheduleRebuild('admin-write', 'some-tag')` would silently misuse the new API — flag any.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # MUST be worktree-429-targeted-rebuild
git add srv/lib/rebuild-trigger.js test/unit/rebuild-trigger.test.js
git commit -m "feat(rebuild-trigger): #429 — opts-based scheduleRebuild + mode-merge + credstore token"
```

---

## Task 4: Wire `srv/server.js` to Classifier + Bound-Action Hooks

**Files:**
- Modify: `srv/server.js`

This task is the integration — assumes Tasks 2 + 3 are complete.

- [ ] **Step 0: Pre-flight grep for the registration guard**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
grep -n '__navigatorCacheInvalidatorRegistered' srv/server.js
```

Expected: two hits — one on the `if (!globalThis.__navigatorCacheInvalidatorRegistered)` open, one on the `globalThis.__navigatorCacheInvalidatorRegistered = true;` setter. Confirms the surrounding registration guard is where the plan expects.

- [ ] **Step 1: Add imports**

In `srv/server.js`, find the existing `import { scheduleRebuild, ... } from './lib/rebuild-trigger.js';` line. Add the classifier import right after it:

```javascript
import { scheduleRebuild, checkFeatureFlag as checkRebuildTriggerFeatureFlag } from './lib/rebuild-trigger.js';
import { classifyRebuildMode, resolveSlugForEntity } from './lib/_classify-rebuild-mode.js';
```

- [ ] **Step 2: Update `navInvalidatingEntities` to include Steps and Tags**

Find the array (~line 480):

OLD:
```javascript
    const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials', 'FeaturedTasks'];
```

NEW:
```javascript
    // #429: classifier-driven rebuild. Each entity routes to a different
    // mode via classifyRebuildMode(); Steps + Tags added so their CRUD
    // also triggers a (slug-targeted or full+force-cap-refetch) rebuild.
    const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials', 'Steps', 'FeaturedTasks', 'Tags'];
```

- [ ] **Step 3: Replace the inner dispatch logic**

Find the `admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, ...)` handler (~line 481-498). Replace the entire handler body with:

```javascript
    admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, async (_data, req) => {
      // #429: migration-mode short-circuit. Bulk migration scripts set
      // x-migration-mode: true and dispatch one final rebuild at end-of-run.
      // Per-row triggers during a migration would dispatch hundreds of
      // workflow runs (all debounced into one full, but still wasteful).
      if (req.headers?.['x-migration-mode'] === 'true') return;

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

      // [#174 PR 3, #429] Schedule a rebuild. classifyRebuildMode routes the
      // entity to the cheapest valid mode (catalog-only/slug-targeted/full).
      const entityName = req.target?.name?.split('.').pop();
      if (!entityName) return;
      const { mode, forceCapRefetch, needsSlug } = classifyRebuildMode(entityName, 'crud');

      let slug = null;
      if (needsSlug) {
        slug = await resolveSlugForEntity(entityName, req.data);
        if (!slug) {
          console.warn(`[rebuild-trigger] slug lookup failed for ${entityName} (id=${req.data?.ID}); falling back to full mode`);
          scheduleRebuild('admin-write', { mode: 'full' }).catch(err => {
            console.error('[rebuild-trigger] scheduling failed', err);
          });
          return;
        }
      }

      scheduleRebuild('admin-write', { mode, slug, forceCapRefetch }).catch(err => {
        console.error('[rebuild-trigger] scheduling failed', err);
      });
    });
```

- [ ] **Step 4: Add the bound-action hooks**

Immediately AFTER the closing `});` of the admin.after hook above (and INSIDE the `if (!globalThis.__navigatorCacheInvalidatorRegistered)` block, just before `globalThis.__navigatorCacheInvalidatorRegistered = true;`), add:

```javascript
    // #429: bound-action hooks for catalog-affecting actions that don't go
    // through standard CRUD. The classifier returns 'catalog-only' or
    // 'full+force-cap-refetch' depending on the action; we don't need a slug
    // because no bound action targets a specific tutorial.
    const CATALOG_AFFECTING_ACTIONS = ['classifyCategories', 'setFeaturedOrder', 'commitTagImport', 'cleanupUnusedTags'];
    for (const actionName of CATALOG_AFFECTING_ACTIONS) {
      admin.after(actionName, async (_data, req) => {
        if (req.headers?.['x-migration-mode'] === 'true') return;
        const { mode, forceCapRefetch } = classifyRebuildMode(actionName, 'action');
        scheduleRebuild(`admin-action:${actionName}`, { mode, forceCapRefetch }).catch(err => {
          console.error('[rebuild-trigger] scheduling failed', err);
        });
      });
    }
```

- [ ] **Step 5: Verify the file still parses**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
node --check srv/server.js
```

Expected: no output (success).

- [ ] **Step 6: Verify existing tests still pass**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/_classify-rebuild-mode.test.js test/unit/rebuild-trigger.test.js 2>&1 | tail -5
```

Expected: all Tasks 2 + 3 tests still PASS.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # MUST be worktree-429-targeted-rebuild
git add srv/server.js
git commit -m "feat(server): #429 — classifier-driven scheduleRebuild + bound-action hooks + migration-mode short-circuit"
```

---

## Task 5: Migration Scripts — End-of-Run Dispatch

**Files:**
- Modify: `scripts/migrate-reference-data.js`
- Modify: `scripts/migrate-user-progress.js`
- Create: `test/scripts/migrate-end-of-run-dispatch.test.js`

- [ ] **Step 1: Write failing test**

Create `test/scripts/migrate-end-of-run-dispatch.test.js`:

```javascript
/**
 * Unit test for #429 — migration scripts trigger one final 'full' rebuild
 * via direct workflow_dispatch after the bulk-write loop completes.
 *
 * Tests the pure helper extracted into the migration scripts. The actual
 * end-of-run wiring is verified inline by reading the script source and
 * asserting the helper call shape — matches the lint-via-source pattern
 * used elsewhere in this repo (memory feedback_qa_gate_frontend_script_tags).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchFinalRebuild } from '../../scripts/lib/migration-final-rebuild.js';

describe('dispatchFinalRebuild (#429)', () => {
  let originalFetch;
  let originalEnv;
  let capturedCall;

  beforeEach(() => {
    capturedCall = null;
    originalFetch = global.fetch;
    originalEnv = process.env.GITHUB_DISPATCH_TOKEN;
    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      capturedCall = { url, init };
      return { ok: true, status: 204, text: async () => '' };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = originalEnv;
  });

  it('skips dispatch when GITHUB_DISPATCH_TOKEN is unset', async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const result = await dispatchFinalRebuild({ source: 'test-migration' });
    expect(result.skipped).toBe(true);
    expect(capturedCall).toBeNull();
  });

  it('posts to the right workflow with mode=full', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    await dispatchFinalRebuild({ source: 'test-migration' });
    expect(capturedCall).not.toBeNull();
    expect(capturedCall.url).toContain('/repos/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml/dispatches');
    expect(capturedCall.init.method).toBe('POST');
    const body = JSON.parse(capturedCall.init.body);
    expect(body.ref).toBe('main');
    expect(body.inputs.mode).toBe('full');
    expect(body.inputs['trigger-source']).toBe('migration-flush:test-migration');
  });

  it('targets the env from REBUILD_TARGET_ENV (defaults to dev)', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    process.env.REBUILD_TARGET_ENV = 'qa';
    await dispatchFinalRebuild({ source: 'test-migration' });
    const body = JSON.parse(capturedCall.init.body);
    expect(body.inputs.environment).toBe('qa');
    delete process.env.REBUILD_TARGET_ENV;
  });

  it('returns skipped=true (non-fatal) when fetch throws', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await dispatchFinalRebuild({ source: 'test-migration' });
    expect(result.skipped).toBe(true);
    expect(result.error).toBeDefined();
  });
});

describe('migration scripts wire the helper (#429)', () => {
  it('migrate-reference-data.js calls dispatchFinalRebuild for import + populate-slugs', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/migrate-reference-data.js'), 'utf8');
    expect(src).toMatch(/dispatchFinalRebuild/);
    // Both write modes wire the call:
    expect(src).toMatch(/source:\s*['"]reference-data-import['"]/);
    expect(src).toMatch(/source:\s*['"]reference-data-populate-slugs['"]/);
  });

  it('migrate-user-progress.js calls dispatchFinalRebuild for import', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/migrate-user-progress.js'), 'utf8');
    expect(src).toMatch(/dispatchFinalRebuild/);
    expect(src).toMatch(/source:\s*['"]user-progress-import['"]/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/scripts/migrate-end-of-run-dispatch.test.js 2>&1 | tail -10
```

Expected: FAIL at module-load (`Cannot find module 'scripts/lib/migration-final-rebuild.js'`).

- [ ] **Step 3: Create the shared helper**

Create `scripts/lib/migration-final-rebuild.js`:

```javascript
// scripts/lib/migration-final-rebuild.js
//
// Shared helper for migrate-reference-data.js + migrate-user-progress.js —
// at end-of-run, fires ONE workflow_dispatch for a 'full' rebuild so the
// per-row triggers we suppressed during bulk migration (via the
// x-migration-mode header) still result in a fresh /browse/ + tutorial pages.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §5
// Issue: #429

const REPO_OWNER = 'sap-tutorials';
const REPO_NAME = 'tutorials-ims';
const WORKFLOW_FILE = 'rebuild-content.yml';

/**
 * Trigger a final 'full' rebuild via GitHub workflow_dispatch.
 *
 * - Requires GITHUB_DISPATCH_TOKEN in process.env. Migration scripts already
 *   hold the PAT for unrelated reasons; reusing keeps this self-contained.
 * - REBUILD_TARGET_ENV env var selects the environment (default 'dev').
 * - Non-fatal: any error is logged and returned as { skipped: true, error }.
 *   The bulk migration already succeeded; failing to dispatch should not
 *   crash the script after-the-fact.
 *
 * @param {object} opts
 * @param {string} opts.source — diagnostic tag (e.g. 'reference-data-import')
 * @returns {Promise<{ skipped: boolean, status?: number, error?: string }>}
 */
export async function dispatchFinalRebuild({ source }) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.log(`[migration] GITHUB_DISPATCH_TOKEN unset — skipping post-migration rebuild dispatch for ${source} (run rebuild-content manually)`);
    return { skipped: true };
  }
  const environment = process.env.REBUILD_TARGET_ENV || 'dev';
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          mode: 'full',
          environment,
          'trigger-source': `migration-flush:${source}`,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `${res.status} ${res.statusText}: ${body.slice(0, 200)}`;
      console.warn(`[migration] post-migration rebuild dispatch failed: ${msg}`);
      return { skipped: true, status: res.status, error: msg };
    }
    console.log(`[migration] dispatched post-migration full rebuild (source=${source}, env=${environment})`);
    return { skipped: false, status: res.status };
  } catch (err) {
    console.warn(`[migration] dispatch error (non-fatal): ${err.message ?? err}`);
    return { skipped: true, error: err.message ?? String(err) };
  }
}
```

- [ ] **Step 4: Wire `scripts/migrate-reference-data.js`**

Open `scripts/migrate-reference-data.js`. Find the top-level sub-command dispatch (~line 125-138):

```javascript
const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData().catch(console.error);
} else if (mode === 'populate-slugs') {
  populateSlugs().catch(console.error);
}
```

Add the helper import at the top of the file (after other imports — find the existing `import` block, the script is ESM):

```javascript
import { dispatchFinalRebuild } from './lib/migration-final-rebuild.js';
```

Replace the sub-command dispatch with:

```javascript
const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData()
    .then(() => dispatchFinalRebuild({ source: 'reference-data-import' }))
    .catch(console.error);
} else if (mode === 'populate-slugs') {
  populateSlugs()
    .then(() => dispatchFinalRebuild({ source: 'reference-data-populate-slugs' }))
    .catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-reference-data.js [export|import|populate-slugs]');
  console.log('  export          — Fetch from Java IMS and save as JSON');
  console.log('  import          — Load JSON into CAP system');
  console.log('  populate-slugs  — Patch slug fields from AEM cache into CAP');
  process.exit(1);
}
```

**Note:** export mode does NOT call dispatchFinalRebuild — exporting is read-only and triggers no admin writes.

- [ ] **Step 5: Wire `scripts/migrate-user-progress.js`**

Find the sub-command dispatch (~line 122-128):

```javascript
const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData().catch(console.error);
}
```

Add the helper import:

```javascript
import { dispatchFinalRebuild } from './lib/migration-final-rebuild.js';
```

Replace the sub-command dispatch:

```javascript
const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData()
    .then(() => dispatchFinalRebuild({ source: 'user-progress-import' }))
    .catch(console.error);
}
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/scripts/migrate-end-of-run-dispatch.test.js 2>&1 | tail -10
```

Expected: all 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add scripts/lib/migration-final-rebuild.js scripts/migrate-reference-data.js scripts/migrate-user-progress.js test/scripts/migrate-end-of-run-dispatch.test.js
git commit -m "feat(migration): #429 — end-of-run workflow_dispatch trigger for import paths"
```

---

## Task 6: Documentation — Secrets Bootstrap

**Files:**
- Modify: `docs/developers/operations/secrets-tracking.md`

- [ ] **Step 1: Append the bootstrap section**

Open `docs/developers/operations/secrets-tracking.md` (it already exists). Find the end of the file. Append:

```markdown

---

## Bootstrap: GITHUB_DISPATCH_TOKEN (#429)

Admin writes to Missions/Groups/CompletionPaths/Tutorials/Steps/Tags/etc.
dispatch a debounced `rebuild-content.yml` workflow run after a 60s quiet
window. The dispatch is gated on a PAT stored in BTP Credential Store. To
enable post-admin-write auto-rebuild:

1. Generate a fine-scoped GitHub PAT with `workflow:write` only.
   See [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)
   for the rotation runbook.
2. In the admin Secrets UI (`/admin-ui/#secrets-display`), click "Create"
   and add a row with:
   - `key = GITHUB_DISPATCH_TOKEN`
   - `kind = pat`
   - `rotationOwner = <your email>`
   - `description = GitHub PAT for rebuild-content.yml workflow_dispatch (#429)`
3. Click into the new row, then **Set Value** — paste the PAT.
4. Verify: make a small admin edit to a Mission and watch the
   `rebuild-content` Actions tab. Within 60-90s a new run should appear
   with `trigger-source: admin-write` and `mode: catalog-only`.

### What happens without the token

If the secret is unset, `scheduleRebuild` silently no-ops on production
and falls back to `process.env.GITHUB_DISPATCH_TOKEN` in local dev
(useful for unit tests). The next admin save tries again, so there's no
permanent stale state — just no auto-rebuild until the secret is set.

### Rotation

The credstore-backed read is cached for 5 minutes in-memory on each
tutorials-srv instance. After rotating the PAT via the admin UI, expect
up to a 5-minute window before srv picks up the new value. Force-refresh
by restarting `tutorials-srv` (`cf restart tutorials-srv`) if needed.

### Mode classification

The dispatched workflow runs in one of three modes depending on what the
admin saved:

| Entity / action | Mode | Wall clock |
|---|---|---|
| Missions / Groups / CompletionPaths / CompletionPathItems / GroupPathItems / FeaturedTasks | catalog-only | 30-60s |
| Tutorials (single row) | slug-targeted | 30-60s |
| Steps (resolves to parent tutorial slug) | slug-targeted (fallback: full) | 30-60s |
| Tags | full + force-cap-refetch | 3-5 min |
| Bound action: classifyCategories, setFeaturedOrder | catalog-only | 30-60s |
| Bound action: commitTagImport, cleanupUnusedTags | full + force-cap-refetch | 3-5 min |

Mode classifier: `srv/lib/_classify-rebuild-mode.js`.
```

- [ ] **Step 2: Sanity check the file**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
wc -l docs/developers/operations/secrets-tracking.md
grep -c 'GITHUB_DISPATCH_TOKEN' docs/developers/operations/secrets-tracking.md
```

Expected: the GITHUB_DISPATCH_TOKEN string appears ≥2 times (header + usage). File size grew.

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add docs/developers/operations/secrets-tracking.md
git commit -m "docs(secrets): #429 — bootstrap recipe for GITHUB_DISPATCH_TOKEN via admin Secrets UI"
```

---

## Task 7: Final Sanity Pass

**Files:** None — verification only.

- [ ] **Step 1: Branch sanity**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
git branch --show-current     # MUST be worktree-429-targeted-rebuild
git log --oneline main..HEAD  # 6 commits (Tasks 1-6)
```

- [ ] **Step 2: Full file scope check**

```bash
git diff --name-only main..HEAD | sort
```

Expected files (matches the plan's File Structure section):

```
.github/workflows/rebuild-content.yml
docs/developers/operations/secrets-tracking.md
docs/superpowers/plans/2026-06-22-issue-429-targeted-rebuild.md
docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
scripts/lib/migration-final-rebuild.js
scripts/migrate-reference-data.js
scripts/migrate-user-progress.js
srv/lib/_classify-rebuild-mode.js
srv/lib/rebuild-trigger.js
srv/server.js
test/scripts/migrate-end-of-run-dispatch.test.js
test/unit/_classify-rebuild-mode.test.js
test/unit/rebuild-trigger.test.js
```

13 files. Anything else listed → investigate (likely a Windows CRLF flip — see memory `feedback_crlf_regression_on_windows`).

- [ ] **Step 3: Re-run the full in-scope unit-test suite**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit/_classify-rebuild-mode.test.js test/unit/rebuild-trigger.test.js test/scripts/migrate-end-of-run-dispatch.test.js 2>&1 | tail -8
```

Expected: 3 files pass, ~35 tests total (19 classifier + 15 trigger + 7 migration helper).

- [ ] **Step 4: Re-run the BROADER unit-test suite for regressions**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
npx vitest run test/unit 2>&1 | tail -10
```

Expected: baseline pass count from Task 0 Step 1 + the 35 new tests. No regressions in other suites.

- [ ] **Step 5: `node --check` on every modified srv/script file**

```bash
node --check srv/lib/rebuild-trigger.js
node --check srv/lib/_classify-rebuild-mode.js
node --check srv/server.js
node --check scripts/lib/migration-final-rebuild.js
node --check scripts/migrate-reference-data.js
node --check scripts/migrate-user-progress.js
echo "all parse OK"
```

- [ ] **Step 6: cds compile sanity (no schema changes; this is defensive)**

```bash
npx cds compile srv/admin-service.cds 2>&1 | tail -3
```

Expected: exit 0. No service-shape changes in this PR — this catches accidental Ctrl+S of an unrelated CDS file.

- [ ] **Step 7: Workflow YAML re-parse**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/rebuild-content.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`.

- [ ] **Step 8: Rebase on `origin/main` if it advanced**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
git fetch origin
git log --oneline HEAD..origin/main | head -5    # commits in main not in branch
```

If `origin/main` advanced, `git rebase origin/main`. Run Step 4 again afterward to confirm no semantic regression.

---

## Task 8: Open the PR

**Files:** None modified — PR creation step.

- [ ] **Step 1: Push the branch**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
git push -u origin worktree-429-targeted-rebuild
```

- [ ] **Step 2: Draft PR body**

Save to `.git-pr-body.md` (gitignored — won't accidentally land in the PR's tree):

````markdown
Closes #429. Filed [#541] as v2 follow-up for per-tag reverse-lookup scope.

## Why

When admins save a Mission / Group / CompletionPath / etc. via the admin UI,
the current rebuild path takes ~10-13 min wall clock even though the saved
data only affects `/browse/` catalog rendering. The same is true for Tutorial,
Step, and Tag edits — most don't need a full 1380-tutorial republish.

## What

Replaces single-mode `scheduleRebuild('admin-write')` with a 3-mode classifier:

| Trigger | Mode | Wall clock |
|---|---|---|
| Missions / Groups / CompletionPaths / CompletionPathItems / GroupPathItems / FeaturedTasks | catalog-only | 30-60s |
| Tutorials (single row) | slug-targeted | 30-60s |
| Steps (resolves to parent slug; falls back to full on lookup failure) | slug-targeted | 30-60s |
| Tags | full + force-cap-refetch | 3-5 min |
| Bound action: classifyCategories, setFeaturedOrder | catalog-only | 30-60s |
| Bound action: commitTagImport, cleanupUnusedTags | full + force-cap-refetch | 3-5 min |
| Anything else | full | 10-13 min |

Plus:
- Workflow `mode` input + per-step `if:` conditions in `rebuild-content.yml`.
- Mode-merge logic across the 60s debounce window: `full > slug-targeted > catalog-only`. Slug accumulator caps at 50; over that, upgrades to full.
- `x-migration-mode: true` header short-circuits the trigger entirely. Migration scripts call `dispatchFinalRebuild({ source: ... })` at end-of-run for `import` / `populate-slugs` modes (not for `export`).
- `GITHUB_DISPATCH_TOKEN` moves from `process.env` (mtaext-baked) to BTP Credential Store via the existing admin Secrets UI. 5-min TTL cache + env fallback.

## Bootstrap (post-merge)

Per the new section in `docs/developers/operations/secrets-tracking.md`:

1. Generate a fine-scoped GitHub PAT (`workflow:write` only).
2. `/admin-ui/#secrets-display` → Create → `key=GITHUB_DISPATCH_TOKEN`.
3. Set Value → paste the PAT.
4. Verify with a small Mission edit; watch the Actions tab.

## Test results

```
vitest run test/unit/_classify-rebuild-mode.test.js test/unit/rebuild-trigger.test.js test/scripts/migrate-end-of-run-dispatch.test.js
Test Files  3 passed (3)
     Tests  ~35 passed
```

`node --check` clean on all 6 modified srv/script files. `cds compile srv/admin-service.cds` exit 0. Workflow YAML re-parsed clean. `git diff --name-only` matches the planned 13-file scope.

## Manual smoke (post-merge + post-deploy)

1. Set `GITHUB_DISPATCH_TOKEN` via admin Secrets UI per the docs.
2. `Actions` → `Rebuild Content` → `Run workflow`. Set `mode = catalog-only`. Click Run.
3. Watch the run: `Fetch tutorials`, `Lint tutorial markdown`, `Validate tutorials`, `Build Vue apps`, `Copy Joule vendor bundles`, `Build display app`, `Build admin SPAs` should show **skipped**. `Build Hugo site` and `Publish tutorial content` should run. Total wall clock <90s.
4. Make a small Mission edit via `/admin-ui/`. Within 60-90s a new workflow run should appear with `trigger-source: admin-write` and `mode: catalog-only`.

## Out of scope

- Per-tag reverse-lookup slug list — [#541] (v2).
- QA/PROD credstore wiring — DEV-first per cutover plan.
- Removing the `process.env.GITHUB_DISPATCH_TOKEN` fallback — kept for local dev / unit tests / credstore outage.

## Backout

- Revert this PR. `scheduleRebuild` reverts to the single-arg form. Workflow's `mode` input gets ignored if unknown. Default behavior continues as `full`.
- No data risk; no schema migration involved.
- The `Secrets` row for `GITHUB_DISPATCH_TOKEN` can stay (harmless if unread).

## Spec + plan trail

- Spec: `docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md`
- Plan: `docs/superpowers/plans/2026-06-22-issue-429-targeted-rebuild.md`
````

- [ ] **Step 3: Create the PR**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/429-targeted-rebuild
gh pr create --title "feat(rebuild): #429 — targeted catalog/slug rebuild + credstore-backed dispatch token (closes #429)" --body-file .git-pr-body.md --base main
rm .git-pr-body.md
```

- [ ] **Step 4: Confirm PR is open**

```bash
gh pr view --json number,url,state,changedFiles,additions,deletions
```

Record the PR number. The next session (or post-merge cleanup) references it.

---

## Notes for the executor

- **Pre-merge probes (Task 0) are non-negotiable** — they catch upstream drift (current workflow YAML state, credstore exports, navInvalidatingEntities shape) before you start editing.
- **Branch is `worktree-429-targeted-rebuild`.** Stay on it — `git branch --show-current` should match before every commit. See memory `[[feedback_branch_slip_after_long_session]]` and `[[feedback_verify_branch_before_commit]]`.
- **Mocking `srv/lib/credstore.js` in Task 3 tests requires `vi.mock()` at the top of the test file (BEFORE imports).** Vitest hoists vi.mock calls automatically; if you see import-order errors, double-check the mock is declared at file top, not inside `beforeEach`. **Fallback if hoisting misbehaves on Windows** (per memory `[[feedback_module_singletons_in_vitest_cds]]`): switch to per-test `vi.doMock` + `vi.resetModules()` + dynamic `await import('../../srv/lib/rebuild-trigger.js')` inside each test. The SUT's `await import('./credstore.js')` is dynamic, so the fresh module identity matters.
- **Steps→Tutorial CDS test (Task 2)** requires `cds.test('serve', '--in-memory')` to boot. The first test boot takes ~3-5s; subsequent tests in the same file reuse the boot.
- **TDD strictly** for Tasks 2, 3, 5 — failing test first, then implement. The mode-merge logic in Task 3 is the easiest to get wrong; the test suite is the safety net.
- **Each commit message uses conventional-commits** matching project precedent — `feat(rebuild-trigger):`, `feat(server):`, `feat(migration):`, `feat(ci):`, `docs(secrets):`.
- **No CDS schema changes** in this PR. If `git diff --name-only` shows any `db/**` file, you've drifted.
