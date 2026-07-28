# Missions & Groups Preview Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `published`-gated QA and Main preview links to the General group on the admin Missions and Groups Object Pages.

**Architecture:** Reuse the Tutorials preview-links pattern — a pure URL/label helper, virtual fields on the projections, `after('READ')` decorators that populate them, and `UI.DataFieldWithUrl` rows in the General FieldGroup. Missions/Groups are served on the `/tutorials/*` route with a `mission-`/`group-` slug prefix, so the links are `/tutorials(-qa)/{kind}-{slug}`. Links render only when `published === true`.

**Tech Stack:** SAP CAP (Node.js), CDS annotations, Fiori Elements V4 Object Page, Vitest.

## Global Constraints

- Links render only when `published === true` (and slug present, and kind valid); unset otherwise → FE renders empty cells.
- Preview links are **relative**: QA `/tutorials-qa/{kind}-{slug}`, Main `/tutorials/{kind}-{slug}`, where `{kind}` is `mission` or `group`.
- Main-link label is `View Live Mission` (missions) / `View Live Group` (groups); QA-link label is `View QA Preview` for both. The `DataFieldWithUrl` `Label:` is `Live Mission`/`Live Group` and `QA Preview`.
- `Value` on each `DataFieldWithUrl` = the `*Label` field; `Url` = the `*Url` field (not swapped).
- 4 virtual `String` fields per entity: `qaPreviewUrl`, `qaPreviewLabel`, `mainPreviewUrl`, `mainPreviewLabel`.
- No GitHub links, no RepoCatalog lookup, no client fetch, no new table.
- Each of Missions/Groups has a single `@UI` annotate block — no last-wins hazard; edit that block's `FieldGroup#General`.
- Run `npx cds deploy --to sqlite::memory:` before commit and `npm test`.
- Deploy is full-build only (no `--skip-build`, no `-m` scoping); bump `applicationVersion` in both manifests.

---

### Task 1: Pure preview-links helper + unit tests

**Files:**
- Create: `srv/lib/preview-links.js`
- Test: `test/unit/preview-links.test.js`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `buildPreviewLinks({ published, slug, kind }) → { qaPreviewUrl, qaPreviewLabel, mainPreviewUrl, mainPreviewLabel }` — every key a `String` or `undefined`. All-`undefined` unless `published === true` && `slug` truthy && `kind ∈ {'mission','group'}`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/preview-links.test.js
import { describe, it, expect } from 'vitest';
import { buildPreviewLinks } from '../../srv/lib/preview-links.js';

describe('buildPreviewLinks', () => {
  it('builds both links for a published mission', () => {
    expect(buildPreviewLinks({ published: true, slug: 'my-mission', kind: 'mission' })).toEqual({
      qaPreviewUrl:     '/tutorials-qa/mission-my-mission',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/mission-my-mission',
      mainPreviewLabel: 'View Live Mission',
    });
  });

  it('builds both links for a published group with group- prefix and Group label', () => {
    expect(buildPreviewLinks({ published: true, slug: 'my-group', kind: 'group' })).toEqual({
      qaPreviewUrl:     '/tutorials-qa/group-my-group',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/group-my-group',
      mainPreviewLabel: 'View Live Group',
    });
  });

  it('returns all-undefined for an unpublished mission', () => {
    const out = buildPreviewLinks({ published: false, slug: 'my-mission', kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined when slug is missing', () => {
    const out = buildPreviewLinks({ published: true, slug: null, kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined for an invalid kind', () => {
    const out = buildPreviewLinks({ published: true, slug: 'x', kind: 'tutorial' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined when published is not strictly true', () => {
    const out = buildPreviewLinks({ published: 1, slug: 'x', kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/preview-links.test.js`
Expected: FAIL — cannot resolve `buildPreviewLinks` (module not found).

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/preview-links.js
//
// Pure URL/label builder for the published-only QA + Live preview links
// surfaced on the admin Missions and Groups Object Pages (General tab).
// Spec: docs/superpowers/specs/2026-07-28-mission-group-preview-links-design.md
//
// Missions and Groups are served on the /tutorials/* route with a
// `mission-` / `group-` slug prefix (srv/lib/content-store.js catalog
// branch), so a published mission `foo` lives at /tutorials/mission-foo.
//
// Kept pure (no DB, no cds) so it is unit-testable without a round trip.
// The after('READ') decorators in admin-service.js call this per row.

const EMPTY = {
  qaPreviewUrl: undefined, qaPreviewLabel: undefined,
  mainPreviewUrl: undefined, mainPreviewLabel: undefined,
};

const LIVE_LABEL = { mission: 'View Live Mission', group: 'View Live Group' };

export function buildPreviewLinks({ published, slug, kind } = {}) {
  // Sole gate: only published rows with a slug and a known kind get links.
  // Anything else leaves the fields unset so FE renders empty cells.
  if (published !== true || !slug || (kind !== 'mission' && kind !== 'group')) {
    return { ...EMPTY };
  }
  return {
    qaPreviewUrl:     `/tutorials-qa/${kind}-${slug}`,
    qaPreviewLabel:   'View QA Preview',
    mainPreviewUrl:   `/tutorials/${kind}-${slug}`,
    mainPreviewLabel: LIVE_LABEL[kind],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/preview-links.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/preview-links.js test/unit/preview-links.test.js
git commit -m "feat(admin): pure builder for mission/group preview links"
```

---

### Task 2: Declare 4 virtual fields on Missions + Groups projections

**Files:**
- Modify: `srv/admin-service.cds:92-93` (the Missions and Groups projection one-liners)

**Interfaces:**
- Consumes: nothing.
- Produces: 4 virtual `String` fields — `qaPreviewUrl`, `qaPreviewLabel`, `mainPreviewUrl`, `mainPreviewLabel` — on **each** of `AdminService.Missions` and `AdminService.Groups`, visible in `/admin/$metadata`.

- [ ] **Step 1: Write the failing test**

```js
// Append inside describe('Missions annotations', ...) — or create a new
// describe block if none exists — in test/admin-annotations.test.js.
// (Groups shares the same $metadata document via the `metadata` variable.)
it('Missions + Groups projections expose the 4 preview-link virtual fields', () => {
  // $metadata declares each Property once per entity type; assert presence.
  for (const col of ['qaPreviewUrl', 'qaPreviewLabel', 'mainPreviewUrl', 'mainPreviewLabel']) {
    expect(metadata, `${col} not found in $metadata`).toContain(`Name="${col}"`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "preview-link virtual fields"`
Expected: FAIL — the field names are absent from `$metadata`.

Note: if no `describe('Missions annotations', ...)` block exists, place the new `it` inside the top-level `describe('UI Annotations in $metadata', ...)` block so the shared `metadata` variable is in scope.

- [ ] **Step 3: Add the virtual fields to both projections**

In `srv/admin-service.cds`, change lines 92-93 from:

```cds
  entity Missions as projection on ims.Missions { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String };
  entity Groups as projection on ims.Groups { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String };
```

to:

```cds
  entity Missions as projection on ims.Missions { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String,
    virtual qaPreviewUrl : String, virtual qaPreviewLabel : String, virtual mainPreviewUrl : String, virtual mainPreviewLabel : String };
  entity Groups as projection on ims.Groups { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String,
    virtual qaPreviewUrl : String, virtual qaPreviewLabel : String, virtual mainPreviewUrl : String, virtual mainPreviewLabel : String };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-annotations.test.js -t "preview-link virtual fields"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds test/admin-annotations.test.js
git commit -m "feat(admin): declare preview-link virtual fields on Missions/Groups"
```

---

### Task 3: Populate fields in after('READ') decorators for Missions + Groups

**Files:**
- Modify: `srv/admin-service.js` (import + two new `after('READ')` decorators)
- Test: `test/unit/admin-mission-group-links-read.test.js`

**Interfaces:**
- Consumes: `buildPreviewLinks` from `srv/lib/preview-links.js` (Task 1); virtual fields from Task 2.
- Produces: at runtime, each published `AdminService.Missions`/`Groups` row read carries the populated link fields.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/admin-mission-group-links-read.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Missions/Groups read: preview links (published-gated)', () => {
  beforeAll(async () => {
    const { Missions, Groups } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries([
      { ID: cds.utils.uuid(), slug: 'pub-mission', title: 'Pub Mission', published: true },
      { ID: cds.utils.uuid(), slug: 'unpub-mission', title: 'Unpub Mission', published: false },
    ]);
    await INSERT.into(Groups).entries([
      { ID: cds.utils.uuid(), slug: 'pub-group', title: 'Pub Group', published: true },
      { ID: cds.utils.uuid(), slug: 'unpub-group', title: 'Unpub Group', published: false },
    ]);
  });

  it('published mission exposes mission-prefixed QA + main links', async () => {
    const { status, data } = await project.get(
      "/admin/Missions?$filter=slug eq 'pub-mission'" +
      '&$select=slug,published,qaPreviewUrl,mainPreviewUrl,qaPreviewLabel,mainPreviewLabel',
      adminAuth);
    expect(status).toBe(200);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe('/tutorials-qa/mission-pub-mission');
    expect(row.mainPreviewUrl).toBe('/tutorials/mission-pub-mission');
    expect(row.mainPreviewLabel).toBe('View Live Mission');
  });

  it('unpublished mission exposes no links', async () => {
    const { data } = await project.get(
      "/admin/Missions?$filter=slug eq 'unpub-mission'&$select=slug,qaPreviewUrl,mainPreviewUrl",
      adminAuth);
    const row = data.value[0];
    expect(row.qaPreviewUrl ?? null).toBeNull();
    expect(row.mainPreviewUrl ?? null).toBeNull();
  });

  it('published group exposes group-prefixed links with Group label', async () => {
    const { data } = await project.get(
      "/admin/Groups?$filter=slug eq 'pub-group'" +
      '&$select=slug,published,qaPreviewUrl,mainPreviewUrl,mainPreviewLabel',
      adminAuth);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe('/tutorials-qa/group-pub-group');
    expect(row.mainPreviewUrl).toBe('/tutorials/group-pub-group');
    expect(row.mainPreviewLabel).toBe('View Live Group');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-mission-group-links-read.test.js`
Expected: FAIL — link fields come back `null`/absent (decorators not wired yet).

- [ ] **Step 3: Add the import + decorators**

At the top of `srv/admin-service.js`, near the existing
`import { buildTutorialLinks } from './lib/tutorial-links.js';` line, add:

```js
import { buildPreviewLinks } from './lib/preview-links.js';
```

Then, near the other `this.after('READ', ...)` handlers (e.g. after the
Tutorials links decorator added by the prior feature), add both:

```js
    // ─── after(READ, Missions/Groups) — published-only preview links ────
    //
    // Populate the 4 virtual preview-link fields for published rows only.
    // Missions/Groups are served on /tutorials/{mission|group}-{slug}
    // (content-store.js catalog branch), so the links carry that prefix.
    // Pure computation over fields already on the row — no DB lookup, no
    // throw source; the defensive `if (!r) continue` guards a malformed row.
    //
    // Spec: docs/superpowers/specs/2026-07-28-mission-group-preview-links-design.md
    this.after('READ', 'Missions', (rows) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r) continue;
        Object.assign(r, buildPreviewLinks({ published: r.published, slug: r.slug, kind: 'mission' }));
      }
    });

    this.after('READ', 'Groups', (rows) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r) continue;
        Object.assign(r, buildPreviewLinks({ published: r.published, slug: r.slug, kind: 'group' }));
      }
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-mission-group-links-read.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/unit/admin-mission-group-links-read.test.js
git commit -m "feat(admin): populate mission/group preview links on read"
```

---

### Task 4: Render the links in the Missions + Groups General FieldGroups

**Files:**
- Modify: `app/admin-annotations.cds` — Missions field-label block (~line 85-100) + General FieldGroup (~line 124-134); Groups field-label block (~line 294-305) + General FieldGroup (~line 329-336).

**Interfaces:**
- Consumes: the 4 virtual fields per entity (Task 2), populated at read time (Task 3).
- Produces: 2 `UI.DataFieldWithUrl` rows in each entity's General FieldGroup, rendered on the Object Page.

- [ ] **Step 1: Write the failing test**

```js
// Append inside describe('UI Annotations in $metadata', ...) in
// test/admin-annotations.test.js
it('Missions + Groups General FieldGroups carry the 2 DataFieldWithUrl link rows', () => {
  for (const target of ['AdminService.Missions', 'AdminService.Groups']) {
    // Each entity's General FieldGroup is emitted as a UI.FieldGroup with
    // Qualifier="General" under the entity's Annotations target.
    const region = metadata.match(
      new RegExp(`<Annotations Target="${target.replace('.', '\\.')}">[\\s\\S]*?</Annotations>`),
    );
    expect(region, `${target} annotations region not found`).toBeTruthy();
    expect(region[0], `${target} missing DataFieldWithUrl`).toContain('UI.DataFieldWithUrl');
    expect(region[0], `${target} missing qaPreviewUrl`).toContain('qaPreviewUrl');
    expect(region[0], `${target} missing mainPreviewUrl`).toContain('mainPreviewUrl');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "DataFieldWithUrl link rows"`
Expected: FAIL — no `DataFieldWithUrl` in the Missions/Groups annotation regions yet.

Note: if the emitted `$metadata` puts the FieldGroup annotations in a region shape the regex above does not match, adjust the matcher to reliably locate each entity's General FieldGroup (intent: verify the 2 DataFieldWithUrl rows with the qaPreviewUrl/mainPreviewUrl targets are present for each entity). Report any adjustment.

- [ ] **Step 3: Add the 4 labels + field control to each entity's field block**

In the Missions `annotate AdminService.Missions with { ... }` block (the one
starting `legacyIdStr @Common.Label...` ~line 85), before its closing `};`
(after the `averageTimeToComplete` line ~99), add:

```cds
  qaPreviewUrl     @Common.Label: 'QA Preview'    @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'    @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Mission'  @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Mission'  @Common.FieldControl: #ReadOnly;
```

In the Groups `annotate AdminService.Groups with { ... }` block (~line 294),
before its closing `};` (after the `status` line ~304), add:

```cds
  qaPreviewUrl     @Common.Label: 'QA Preview'  @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'  @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Group'  @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Group'  @Common.FieldControl: #ReadOnly;
```

- [ ] **Step 4: Add the DataFieldWithUrl rows to each General FieldGroup**

In the Missions `FieldGroup#General: { Data: [ ... ] }` (~line 124-134),
append after the last entry (`{ Value: status }`):

```cds
    { Value: status },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Mission' }
```

In the Groups `FieldGroup#General: { Data: [ ... ] }` (~line 329-336), append
after the last entry (`{ Value: status }`):

```cds
    { Value: status },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Group' }
```

(Each edit replaces the trailing `{ Value: status }` line with the same line plus the two new rows — mind the comma after `{ Value: status }`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/admin-annotations.test.js -t "DataFieldWithUrl link rows"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds test/admin-annotations.test.js
git commit -m "feat(admin): render preview links in Missions/Groups General group"
```

---

### Task 5: Bust the UI5 fragment cache + full validation

**Files:**
- Modify: `app/admin/missions/webapp/manifest.json` (applicationVersion `0.0.3` → `0.0.4`)
- Modify: `app/admin/groups/webapp/manifest.json` (applicationVersion `0.0.1` → `0.0.2`)

**Interfaces:**
- Consumes: nothing.
- Produces: version bumps forcing the UI5 IndexedDB fragment cache to re-parse the annotations post-deploy.

- [ ] **Step 1: Bump both applicationVersions**

In `app/admin/missions/webapp/manifest.json`, change `"version": "0.0.3"` → `"version": "0.0.4"`.
In `app/admin/groups/webapp/manifest.json`, change `"version": "0.0.1"` → `"version": "0.0.2"`.

(If either current value differs from what's stated, bump the patch by one and note it in the report.)

- [ ] **Step 2: Compile-guard the CDS model**

Run: `npx cds deploy --to sqlite::memory:`
Expected: completes without error. (Missions/Groups each have a single `@UI` block, so no "Duplicate assignment" warning is expected here — unlike the Tutorials Lifecycle case.)

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the new `preview-links`, `admin-mission-group-links-read`, and `admin-annotations` assertions. The project has known fresh-worktree suite-import failures (missing native bindings / unbuilt bundles under `hugo-apps`/`srv-qa`); those are unrelated to this branch. Distinguish any failure that touches this branch's files (`srv/lib/preview-links.js`, `srv/admin-service.js`, `srv/admin-service.cds`, `app/admin-annotations.cds`, the two manifests, or the new test files) from the pre-existing ones, and do NOT mark DONE if a branch-file test fails.

- [ ] **Step 4: Commit**

```bash
git add app/admin/missions/webapp/manifest.json app/admin/groups/webapp/manifest.json
git commit -m "chore(admin): bump missions/groups applicationVersion to bust fragment cache"
```

---

## Self-Review

**1. Spec coverage:**
- Pure helper + `published`/slug/kind gating + `mission-`/`group-` prefix + Group/Mission labels → Task 1. ✓
- 4 virtual fields on each of Missions + Groups → Task 2. ✓
- Two `after('READ')` decorators populating published rows → Task 3. ✓
- DataFieldWithUrl rendering in each General FieldGroup + labels → Task 4. ✓
- `$metadata` regression pins → Tasks 2 & 4. ✓
- cds deploy guard + npm test → Task 5. ✓
- applicationVersion bumps (both manifests) + full-deploy note → Task 5 + Global Constraints. ✓
- Relative links → Task 1 (helper). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". All code blocks concrete. The two "if the shape/value differs, adjust/note" instructions are bounded fallbacks with a stated intent, not placeholders. ✓

**3. Type consistency:** `buildPreviewLinks` signature and its 4 return keys are identical across Task 1 (definition), Task 3 (calls), and the field names in Tasks 2 & 4: `qaPreviewUrl`, `qaPreviewLabel`, `mainPreviewUrl`, `mainPreviewLabel`. `kind` values `'mission'`/`'group'` consistent between the two decorators and the helper. Labels `View Live Mission`/`View Live Group` consistent between helper (Task 1) and read-test assertions (Task 3). ✓

**Deploy reminder (post-merge, not a plan task):** ship with a full `npm run deploy -- --env <env>` (no `--skip-build`, no `-m` scoping) so the approuter admin bundle + `$metadata` rebuild.
