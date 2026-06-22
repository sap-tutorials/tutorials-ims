# #429 Targeted Catalog/Slug Rebuild — Design

> Spec brainstormed 2026-06-22. Replaces the silently no-op `scheduleRebuild('admin-write')` path with a 3-mode dispatcher that auto-classifies each admin write and dispatches the cheapest valid rebuild — 30-60s wall clock for ~80% of admin saves vs the current 10-13 min full rebuild.

## Summary

When admins save through AdminService (CRUD or bound action), the post-debounce rebuild now runs in one of three modes depending on what was saved:

| Trigger | Mode | Wall clock | Why |
|---|---|---|---|
| CRUD: Missions / Groups / CompletionPaths / CompletionPathItems / GroupPathItems / FeaturedTasks | **catalog-only** | 30-60s | Catalog data lives in `hugo/data/browse.json`; Hugo rebuilds it from `/build/catalog`. Tutorial pages embed mission/group breadcrumbs at Hugo build time, so a Hugo rebuild captures them. No tutorial-markdown re-fetch needed. |
| CRUD: Tutorials (single row) | **slug-targeted** with `slug: <tutorial.slug>` | 30-60s | `fetch-tutorials.ts` honors `TUTORIAL_SLUG` (already wired by #433); re-fetches one markdown, rebuilds Hugo, `publish-content --heal` uploads the diff. |
| CRUD: Steps | **slug-targeted** with best-effort parent slug lookup | 30-60s (fallback: 3-5 min) | `Step.tutorial.slug` via CQL at hook time. Falls back to `full` if lookup fails. |
| CRUD: Tags | **full + force-cap-refetch=true** | 3-5 min | Tag labels propagate into tutorial frontmatter via `displayTagSlugs/displayTags`. `force-cap-refetch=true` regenerates frontmatter from cached markdown (no GitHub round-trip per slug). |
| Bound action: `classifyCategories` | **catalog-only** | 30-60s | /browse/ category facet driven by MissionCategories / GroupCategories junctions. |
| Bound action: `setFeaturedOrder` | **catalog-only** | 30-60s | /browse/ featured ordering. |
| Bound action: `commitTagImport` | **full + force-cap-refetch=true** | 3-5 min | Bulk Tag creates affect tutorial frontmatter. |
| Bound action: `cleanupUnusedTags` | **full + force-cap-refetch=true** | 3-5 min | Tag deletes affect frontmatter (orphan refs cleared). |
| Migration-mode requests (`x-migration-mode: true` header) | **suppressed** — script triggers one final `full` rebuild at end | n/a | Pattern already established by `srv/lib/migration-mode.js` for change-tracking suppression. |
| Anything else / unknown entity | **full** | 10-13 min | Safe fallback. |

`GITHUB_DISPATCH_TOKEN` moves from `process.env` (mtaext-baked) to BTP Credential Store (admin Secrets UI editable, no redeploy needed).

## Context — why this PR exists

Today's chain when an admin saves a Mission/Group/CompletionPath:

1. `invalidateNavigatorCache()` runs ✓ instant
2. `invalidateRenderCache()` runs ✓ instant
3. `scheduleRebuild('admin-write')` is silently no-op because `GITHUB_DISPATCH_TOKEN` is unset on tutorials-srv on DEV.
4. Even if the token were set, the dispatched `rebuild-content.yml` workflow takes 10-13 min because it re-fetches all 1380 tutorial markdowns, rebuilds Hugo, and republishes everything via the chunked `/content/publish` path — most of which is unnecessary for a catalog-only edit.

Issue [#429] (the parent issue) lays out the proposed 3-tier rebuild and slug-targeted scoping. The 3-mode shape captures the spectrum: catalog-only when only `/browse/` data changes, slug-targeted when a specific tutorial changes, full otherwise.

Surfaced from issue #382 phase F1 — repaired the meta-tutorials mission via raw SQL UPDATEs, then tried to refresh the rendered mission page. The full rebuild took ~10-13 min just to bust the catalog cache and republish the (unchanged) mission HTML.

## Settled decisions (from 2026-06-22 brainstorming with Tom)

1. **Single workflow with a `mode` input**, not a sibling `rebuild-catalog.yml`. Reuses the existing CI plumbing; the `slug` / `slugs` workflow inputs (added by #433) carry through unchanged.

2. **Auto-classify by entity** in `srv/lib/_classify-rebuild-mode.js`. CRUD handlers in `srv/server.js` call the pure classifier and pass the result to `scheduleRebuild`. New bound-action hooks for the 4 catalog-affecting actions.

3. **Best-effort Step → Tutorial slug lookup** with `full`-mode fallback if the lookup fails. Logs on every fallback so a regression is visible.

4. **Mode merge during the 60s debounce window**: priority `full > slug-targeted > catalog-only`. Slug-targeted accumulates slugs into a Set; capped at 50 then upgrades to `full`.

5. **Migration-mode suspend**: `x-migration-mode: true` header short-circuits the hook (no scheduleRebuild call). Migration scripts trigger ONE final `full` rebuild at end-of-run via direct GitHub workflow_dispatch API call (the scripts already hold the PAT). No new srv endpoints.

6. **Token from BTP Credential Store** via `srv/lib/credstore.js#readSecret('GITHUB_DISPATCH_TOKEN')`. 5-min in-memory TTL cache to avoid hammering credstore. Falls back to `process.env.GITHUB_DISPATCH_TOKEN` for local dev / unit tests. The `Secrets` row + value are bootstrapped manually via the existing admin Secrets UI — no CSV seed (per memory `feedback_cap_csv_seeds_clobber_admin_data`).

7. **v2 follow-up filed** as [#541] — per-tag reverse-lookup slug list. Out of scope for #429.

## Changes by file

### 1. `.github/workflows/rebuild-content.yml` — `mode` input + conditional steps

Add a new workflow_dispatch input:

```yaml
mode:
  description: |
    Rebuild scope. 'full' (default) re-fetches all tutorials, rebuilds Vue apps, runs full publish.
    'catalog-only' skips fetch + Vue + AI quiz; just rebuilds Hugo from cached markdown
    + new browse.json and runs publish-content --heal. 30-60s wall clock.
    'slug-targeted' uses the existing `slug` / `slugs` inputs to re-fetch only those slugs;
    same 30-60s wall clock.
  required: false
  default: full
  type: choice
  options:
    - full
    - catalog-only
    - slug-targeted
```

Per-step `if:` conditions:

| Step | Condition |
|---|---|
| `Fetch tutorials` | `inputs.mode != 'catalog-only'` |
| `Lint tutorial markdown` | `inputs.mode != 'catalog-only'` |
| `Validate tutorials` | `inputs.mode != 'catalog-only'` |
| `Build Vue apps` | `inputs.mode == 'full'` |
| `Copy Joule vendor bundles` | `inputs.mode == 'full'` |
| `Build Hugo site` | always |
| `Publish tutorial content to HANA` | always |
| `Build display app` | `inputs.mode == 'full'` |
| `Build admin SPAs` + tarball + STATIC_DIR swap | `inputs.mode == 'full'` |

`force-cap-refetch` already exists as an input; srv passes `true` for Tag-class rebuilds.

### 2. `srv/lib/_classify-rebuild-mode.js` (NEW)

```javascript
// Pure helpers for routing admin writes to the right rebuild mode.
// Imported by srv/server.js admin.after hooks; tested directly via vitest.

const CATALOG_ONLY_ENTITIES = new Set([
  'Missions',
  'Groups',
  'CompletionPaths',
  'CompletionPathItems',
  'GroupPathItems',
  'FeaturedTasks',
]);
const SLUG_TARGETED_ENTITIES = new Set(['Tutorials', 'Steps']);
const FULL_FORCE_CAP_REFETCH_ENTITIES = new Set(['Tags']);

const CATALOG_ONLY_ACTIONS = new Set(['classifyCategories', 'setFeaturedOrder']);
const FULL_FORCE_CAP_REFETCH_ACTIONS = new Set(['commitTagImport', 'cleanupUnusedTags']);

/**
 * Classify an entity-CRUD or bound-action trigger to a rebuild mode.
 * @param {string} entityOrActionName
 * @param {'crud'|'action'} kind
 * @returns {{ mode: 'catalog-only'|'slug-targeted'|'full', forceCapRefetch: boolean, needsSlug: boolean }}
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
 * - Anything else / lookup failure: returns null (caller falls back to 'full' mode).
 *
 * @param {string} entityName
 * @param {object} row — the saved entity row from req.data
 * @returns {Promise<string|null>}
 */
export async function resolveSlugForEntity(entityName, row) {
  if (!row) return null;
  if (entityName === 'Tutorials' && row.slug) return row.slug;
  if (entityName === 'Steps' && row.tutorial_ID) {
    try {
      const cds = (await import('@sap/cds')).default;
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const tut = await SELECT.one.from(Tutorials).columns('slug').where({ ID: row.tutorial_ID });
      return tut?.slug ?? null;
    } catch (err) {
      // Logged by the caller; fallback to full mode.
      return null;
    }
  }
  return null;
}
```

### 3. `srv/lib/rebuild-trigger.js` — opts-based signature + mode merge + credstore

**Signature change:**

```javascript
// Before:
export async function scheduleRebuild(reason) { ... }

// After:
export async function scheduleRebuild(reason, opts = {}) {
  const { mode = 'full', slug = null, forceCapRefetch = false } = opts;
  ...
}
```

**State extension:**

```javascript
let _state = {
  cachedToken: process.env.GITHUB_DISPATCH_TOKEN ?? null,
  cachedTokenExpiresAt: 0,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  pendingTimer: null,
  pendingReason: null,
  pendingMode: null,                 // NEW
  pendingSlugs: new Set(),           // NEW
  pendingForceCapRefetch: false,     // NEW
  dispatchFn: defaultDispatch,
};

const TOKEN_TTL_MS = 5 * 60 * 1000;
const RANK = { 'catalog-only': 1, 'slug-targeted': 2, 'full': 3 };
const SLUG_ACCUMULATOR_CAP = 50;
```

**Mode-merge logic:**

```javascript
function mergePending({ mode, slug, forceCapRefetch }) {
  // Mode: take the higher rank
  if (!_state.pendingMode || RANK[mode] > RANK[_state.pendingMode]) {
    _state.pendingMode = mode;
  }
  // Slug accumulation (only meaningful in slug-targeted mode)
  if (slug) {
    _state.pendingSlugs.add(slug);
    if (_state.pendingSlugs.size > SLUG_ACCUMULATOR_CAP) {
      _state.pendingMode = 'full';  // Cap-exceeded → upgrade to full
      _state.pendingSlugs.clear();
    }
  }
  // forceCapRefetch is sticky — once any trigger asks for it, it stays.
  if (forceCapRefetch) _state.pendingForceCapRefetch = true;
}
```

**Token resolution:**

```javascript
async function getDispatchToken() {
  if (_state.cachedToken && Date.now() < _state.cachedTokenExpiresAt) {
    return _state.cachedToken;
  }
  try {
    const { readSecret } = await import('./credstore.js');
    const token = await readSecret('GITHUB_DISPATCH_TOKEN');
    if (token) {
      _state.cachedToken = token;
      _state.cachedTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
      return token;
    }
  } catch (err) {
    LOG.warn(`[rebuild-trigger] credstore lookup failed: ${err.message ?? err}`);
  }
  // Fallback to env var (local dev / unit tests / credstore not bound)
  return process.env.GITHUB_DISPATCH_TOKEN ?? null;
}
```

**Dispatch inputs:**

```javascript
const inputs = {
  'trigger-source': reasonAtFire,
  environment: rebuildTargetEnv,
  mode: pendingModeAtFire,
};
if (pendingModeAtFire === 'slug-targeted' && pendingSlugsAtFire.size > 0) {
  inputs.slugs = [...pendingSlugsAtFire].join(',');
}
if (pendingForceCapRefetchAtFire) {
  inputs['force-cap-refetch'] = true;
}
```

### 4. `srv/server.js` (~line 360) — classifier-driven hook

**Note:** The `navInvalidatingEntities` array driving the hook's entity registration is unchanged from today (`['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials', 'FeaturedTasks']` plus `Steps`/`Tags` if not already present — verify and add as needed). Only the dispatch logic INSIDE the handler changes.

**Replace** the existing single `scheduleRebuild('admin-write')` call with:

```javascript
import { classifyRebuildMode, resolveSlugForEntity } from './lib/_classify-rebuild-mode.js';

// Migration-mode suspension: scripts setting x-migration-mode: true do bulk
// writes that should NOT each trigger a rebuild. The script itself triggers
// one final full rebuild via workflow_dispatch at end-of-run.
admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, async (data, req) => {
  if (req.headers?.['x-migration-mode'] === 'true') return;

  // ... existing invalidateNavigatorCache + invalidateRenderCache calls ...

  const entityName = req.target?.name?.split('.').pop();
  if (!entityName) return;
  const { mode, forceCapRefetch, needsSlug } = classifyRebuildMode(entityName, 'crud');

  let slug = null;
  if (needsSlug) {
    slug = await resolveSlugForEntity(entityName, req.data);
    if (!slug) {
      console.warn(`[rebuild-trigger] slug lookup failed for ${entityName}; falling back to full mode`);
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

**Add** bound-action hooks for the 4 catalog-affecting actions:

```javascript
const CATALOG_ACTIONS = ['classifyCategories', 'setFeaturedOrder', 'commitTagImport', 'cleanupUnusedTags'];
for (const actionName of CATALOG_ACTIONS) {
  admin.after(actionName, async (_data, req) => {
    if (req.headers?.['x-migration-mode'] === 'true') return;
    const { mode, forceCapRefetch } = classifyRebuildMode(actionName, 'action');
    scheduleRebuild(`admin-action:${actionName}`, { mode, forceCapRefetch }).catch(err => {
      console.error('[rebuild-trigger] scheduling failed', err);
    });
  });
}
```

### 5. Migration scripts — end-of-run final rebuild dispatch

`scripts/migrate-reference-data.js` and `scripts/migrate-user-progress.js`:

After the existing bulk-write loop finishes (and before exiting), add:

```javascript
// Trigger one final full rebuild after the bulk migration completes.
// During migration, the x-migration-mode header suppresses per-entity
// rebuilds in srv; this is the explicit at-end flush.
if (process.env.GITHUB_DISPATCH_TOKEN) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            mode: 'full',
            'trigger-source': 'migration-flush',
            environment: process.env.REBUILD_TARGET_ENV || 'dev',
          },
        }),
      }
    );
    if (!res.ok) {
      console.warn(`[migration] post-migration rebuild dispatch failed: ${res.status} ${res.statusText}`);
    } else {
      console.log('[migration] dispatched post-migration full rebuild');
    }
  } catch (err) {
    console.warn(`[migration] dispatch error (non-fatal): ${err.message ?? err}`);
  }
} else {
  console.log('[migration] GITHUB_DISPATCH_TOKEN unset — skipping post-migration rebuild dispatch (run rebuild-content manually)');
}
```

### 6. `docs/developers/operations/admin-secrets.md` (NEW or extend)

Append a section:

```markdown
## Bootstrap: GITHUB_DISPATCH_TOKEN

Admin writes to Missions/Groups/CompletionPaths/etc. dispatch a debounced
`rebuild-content.yml` workflow run. The dispatch is gated on a PAT stored
in BTP Credential Store. To enable post-admin-write auto-rebuild:

1. Generate a fine-scoped GitHub PAT with `workflow:write` only.
   See [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md).
2. In the admin Secrets UI (`/admin-ui/#secrets-display`), click "Create"
   and add a row with `key = GITHUB_DISPATCH_TOKEN`, `kind = pat`,
   `rotationOwner = <your email>`.
3. Click into the new row, then "Set Value" — paste the PAT.
4. Verify: make a small admin edit to a Mission and observe the
   `rebuild-content` workflow fires within 60-90s.

If the secret is unset, `scheduleRebuild` silently no-ops on production
and falls back to `process.env.GITHUB_DISPATCH_TOKEN` in local dev.

### Rotation

The credstore-backed read is cached for 5 minutes in-memory. After rotating
the PAT via the UI, expect up to a 5-min window before srv picks up the new
value. Force-refresh by restarting `tutorials-srv` if needed.
```

### 7. Tests

**`test/unit/_classify-rebuild-mode.test.js`** (NEW) — table-driven:

```javascript
describe('classifyRebuildMode', () => {
  it.each([
    // CRUD
    ['Missions',              'crud', 'catalog-only', false, false],
    ['Groups',                'crud', 'catalog-only', false, false],
    ['CompletionPaths',       'crud', 'catalog-only', false, false],
    ['CompletionPathItems',   'crud', 'catalog-only', false, false],
    ['GroupPathItems',        'crud', 'catalog-only', false, false],
    ['FeaturedTasks',         'crud', 'catalog-only', false, false],
    ['Tutorials',             'crud', 'slug-targeted', false, true],
    ['Steps',                 'crud', 'slug-targeted', false, true],
    ['Tags',                  'crud', 'full',         true,  false],
    ['Advocates',             'crud', 'full',         false, false],  // safe default
    // Actions
    ['classifyCategories',    'action', 'catalog-only', false, false],
    ['setFeaturedOrder',      'action', 'catalog-only', false, false],
    ['commitTagImport',       'action', 'full',         true,  false],
    ['cleanupUnusedTags',     'action', 'full',         true,  false],
    ['rotateSecretValue',     'action', 'full',         false, false],  // safe default
  ])('classify(%s, %s) → %s force=%s slug=%s', (name, kind, expectedMode, expectedForce, expectedSlug) => {
    const out = classifyRebuildMode(name, kind);
    expect(out.mode).toBe(expectedMode);
    expect(out.forceCapRefetch).toBe(expectedForce);
    expect(out.needsSlug).toBe(expectedSlug);
  });
});

describe('resolveSlugForEntity', () => {
  it('returns row.slug for Tutorials', async () => {
    expect(await resolveSlugForEntity('Tutorials', { slug: 'foo' })).toBe('foo');
  });
  it('returns null when Tutorials row has no slug', async () => {
    expect(await resolveSlugForEntity('Tutorials', {})).toBeNull();
  });
  it('returns null for Steps with no tutorial_ID', async () => {
    expect(await resolveSlugForEntity('Steps', {})).toBeNull();
  });
  // The Steps-with-tutorial_ID path needs cds.test boot to hit the SELECT.
  // Covered as an integration-style test below using `cds.test('serve', '--in-memory')`
  // — boot deploys the in-memory schema, seed a Tutorial + Step, call the
  // resolver, assert it returns the parent's slug. Matches the pattern in
  // test/notification-reset.test.js (per memory feedback_default_off_flags_need_live_smoke).
});

describe('resolveSlugForEntity — integration', () => {
  // cds.test('serve', '--in-memory') boots; seed Tutorial + Step in beforeAll;
  // call resolveSlugForEntity('Steps', { tutorial_ID: <id> }) → expect tutorial.slug.
});
```

**`test/unit/rebuild-trigger.test.js`** (EXTEND) — add cases:

1. `scheduleRebuild('x', { mode: 'catalog-only' })` dispatches with `mode: 'catalog-only'`.
2. Mode-upgrade during window: catalog-only then full → final dispatch is full.
3. Mode-stable during window: full then catalog-only → stays full.
4. Slug-accumulate: 3 slug-targeted calls with distinct slugs → final dispatch carries `slugs: 'a,b,c'`.
5. Slug-cap: 51 slug-targeted calls → upgrades to full.
6. `forceCapRefetch` sticks once set.
7. Migration-mode short-circuit: `req.headers['x-migration-mode'] === 'true'` skips scheduleRebuild (verified by the admin.after hook test).
8. Credstore-cache: two consecutive `scheduleRebuild` calls share one `readSecret` invocation within the 5-min window.
9. Credstore-fallback: when `readSecret` throws, falls back to `process.env.GITHUB_DISPATCH_TOKEN`.

**`test/unit/migrate-end-of-run-dispatch.test.js`** (NEW, minimal):

Mock the `fetch` global; verify the migrate scripts send the right body shape when `GITHUB_DISPATCH_TOKEN` is set, and skip silently when it's unset.

### 8. Workflow smoke test (manual, post-merge)

Documented in PR description:

1. Open `Actions` → `Rebuild Content` → `Run workflow`.
2. Set `mode = catalog-only`, leave everything else default.
3. Click `Run workflow`.
4. Observe: `Fetch tutorials`, `Lint tutorial markdown`, `Validate tutorials`, `Build Vue apps`, `Copy Joule vendor bundles`, `Build display app`, `Build admin SPAs` steps all show as "skipped".
5. Wall clock total <90s.

## Risks

| Risk | Mitigation |
|---|---|
| Step → Tutorial lookup hits a transient DB error and silently falls back to full mode | Always logged with the entity ID; metric visible in CF logs. If this fallback fires more than ~5%, file follow-up to cache the lookup or denormalize the slug onto Steps. |
| 50-slug cap in slug-accumulator is hit by a non-migration bulk admin operation | Logged at WARN level. Falls back to full mode (correct outcome, just slower). **Cap value is a module-level `const SLUG_ACCUMULATOR_CAP = 50`** — not env-configurable in the initial PR. If admins regularly hit the cap, a follow-up can promote it to an env var; YAGNI for now. |
| Migration script forgets to dispatch the final rebuild (e.g. exits abnormally) | Acceptable: next admin write triggers one. Catalog isn't stale-forever. |
| Credstore-cached token survives a PAT rotation by up to 5 min | Documented in admin-secrets.md. `tutorials-srv` restart forces re-read. |
| Bound action that mutates catalog state is added in a future PR but not registered in CATALOG_ACTIONS | Default is `full` mode for unrecognized actions — safe. The classifier comment block documents the registration requirement. The next regression-aware PR-author adds the entry. |
| `req.headers` is undefined in non-HTTP-context dispatch (e.g. CDS unit test calling a service directly) | The `?.` chain handles undefined gracefully. Migration-mode short-circuit only fires when the header IS the literal string `'true'`. |

## Out of scope

- Per-tag reverse-lookup slug list — filed as [#541] for v2.
- QA / prod credstore wiring — DEV-first per cutover plan; QA/prod ride after DEV soak.
- Removing the `process.env.GITHUB_DISPATCH_TOKEN` fallback entirely — kept for local dev / unit tests / catastrophic credstore outage.
- Slug-level scope expansion for tutorial pages affected by mission-rename (the issue body's "Even better — debounced single-path rebuild from the admin save"). Catalog-only already gets us to 30-60s; further granularity is marginal gain.
- Approuter tarball cache busting — not needed in catalog-only mode (the approuter static dir doesn't change).

## Acceptance criteria

### Pre-merge (code shape)

- [ ] `.github/workflows/rebuild-content.yml` has `mode` input with 3 values; per-step `if:` conditions match the table above.
- [ ] `srv/lib/_classify-rebuild-mode.js` exists; classifies all 9 nav-invalidating entities + 4 bound actions correctly; pure functions, no I/O.
- [ ] `srv/lib/rebuild-trigger.js`:
  - Signature is `scheduleRebuild(reason, opts = {})`.
  - Mode-merge, slug-accumulate, slug-cap-50, forceCapRefetch-sticky all unit-tested.
  - Token sourced via `getDispatchToken()` with 5-min cache + env fallback.
- [ ] `srv/server.js` admin.after hook calls `classifyRebuildMode` and passes opts; short-circuits on `x-migration-mode: true`.
- [ ] 4 new bound-action hooks registered for `classifyCategories`, `setFeaturedOrder`, `commitTagImport`, `cleanupUnusedTags`.
- [ ] Migration scripts (`migrate-reference-data.js`, `migrate-user-progress.js`) post end-of-run full rebuild via fetch.
- [ ] `docs/developers/operations/admin-secrets.md` has the bootstrap section.
- [ ] Unit tests pass; no schema changes.
- [ ] `cds compile srv/admin-service.cds` succeeds (no service changes; safety check).
- [ ] PR description quotes the manual smoke checklist.

### Post-deploy (manual verification)

- [ ] Admin Secrets UI used to set `GITHUB_DISPATCH_TOKEN` on DEV.
- [ ] Manual `workflow_dispatch` with `mode=catalog-only` skips the right steps; wall clock <90s.
- [ ] Admin save on a Mission triggers a catalog-only dispatch within 60-90s; observed in `rebuild-content` Actions tab.
- [ ] Admin save on a Tutorial triggers a slug-targeted dispatch with the correct `slugs` input.
- [ ] Admin save on a Tag triggers a full+`force-cap-refetch=true` dispatch.

## Backout

- Revert the PR. `scheduleRebuild` reverts to the single-mode form; the workflow's `mode` input gets ignored if unknown; default behavior continues as `full`.
- No data risk; no schema migration involved.
- `Secrets` row for `GITHUB_DISPATCH_TOKEN` can stay (harmless if unread).

## Refs

- #429 (parent)
- #382 phase F1 (the trigger)
- #423 / #424 / #425 / #428 (the four PR chain that surfaced this gap)
- #433 (the `slugs` workflow input this PR consumes)
- #541 (v2 follow-up: per-tag reverse-lookup)
- Memory: `[[feedback_merge_is_not_deploy]]`, `[[feedback_cap_csv_seeds_clobber_admin_data]]`, `[[feedback_cf_set_env_drops_on_redeploy]]` (the constraints that shaped the credstore-backed approach)
