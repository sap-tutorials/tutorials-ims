# Tutorial Lifecycle Source & Preview Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four ACTIVE-only links (GitHub source repo, GitHub Contributions repo, QA preview, live tutorial) to the Lifecycle group on the admin Tutorials Object Page.

**Architecture:** Reuse the proven `#918 isolated` virtual-field pattern — declare virtual fields on the `AdminService.Tutorials` projection, populate them ACTIVE-only in a fail-quiet `after('READ','Tutorials')` decorator that reads `RepoCatalog` via raw SQL, and render them as `UI.DataFieldWithUrl` rows in the last-wins Lifecycle FieldGroup. URL construction is extracted to a pure helper for unit testing.

**Tech Stack:** SAP CAP (Node.js), CDS annotations, Fiori Elements V4 Object Page, Vitest.

## Global Constraints

- Status enum is `ACTIVE` / `INACTIVE` only (`db/schema.cds:16`); links render only for `status === 'ACTIVE'`.
- Preview links (QA + main) are **relative** paths (env-correct): `/tutorials-qa/{slug}` and `/tutorials/{slug}`.
- GitHub source folder URL: `https://github.com/{owner}/{repo}/tree/{branch}/tutorials/{slug}`.
- Contributions repo name = `{repo}-Contribution` (suffix convention).
- `owner` defaults to `sap-tutorials` when RepoCatalog owner is null; `branch` defaults to `main` when null; skip both GitHub links when `repo` is null/empty.
- Fail-quiet: any RepoCatalog SELECT throw leaves GitHub fields unset and logs a warning; QA/main links are set independently and never suppressed by a catalog failure.
- 8 virtual fields total (4 `*Url` + 4 `*Label`); friendly label text, not raw URLs.
- Run `npx cds deploy --to sqlite::memory:` before commit (runtime-only `@assert` guard per global rules) and `npm test`.
- Deploy is full-build only (no `--skip-build`, no `-m` scoping); bump `applicationVersion` in the tutorials manifest to bust the UI5 fragment cache.

---

### Task 1: Pure URL-builder helper + unit tests

**Files:**
- Create: `srv/lib/tutorial-links.js`
- Test: `test/unit/tutorial-links.test.js`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `buildTutorialLinks({ status, slug, owner, repo, branch }) → { sourceRepoUrl, sourceRepoLabel, contribRepoUrl, contribRepoLabel, qaPreviewUrl, qaPreviewLabel, mainPreviewUrl, mainPreviewLabel }` — every key is a `String` or `undefined`. Returns all-`undefined` when `status !== 'ACTIVE'`. GitHub keys are `undefined` when `repo` is null/empty; QA/main keys are always set for ACTIVE rows.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/tutorial-links.test.js
import { describe, it, expect } from 'vitest';
import { buildTutorialLinks } from '../../srv/lib/tutorial-links.js';

describe('buildTutorialLinks', () => {
  const base = { status: 'ACTIVE', slug: 'my-tut', owner: 'sap-tutorials', repo: 'Tutorials', branch: 'main' };

  it('builds all 8 fields for an ACTIVE row with a full catalog entry', () => {
    expect(buildTutorialLinks(base)).toEqual({
      sourceRepoUrl:    'https://github.com/sap-tutorials/Tutorials/tree/main/tutorials/my-tut',
      sourceRepoLabel:  'sap-tutorials/Tutorials',
      contribRepoUrl:   'https://github.com/sap-tutorials/Tutorials-Contribution/tree/main/tutorials/my-tut',
      contribRepoLabel: 'sap-tutorials/Tutorials-Contribution',
      qaPreviewUrl:     '/tutorials-qa/my-tut',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/my-tut',
      mainPreviewLabel: 'View Live Tutorial',
    });
  });

  it('returns all-undefined for a non-ACTIVE row', () => {
    const out = buildTutorialLinks({ ...base, status: 'INACTIVE' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('sets QA/main but not GitHub links when repo is missing', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: 'my-tut', owner: null, repo: null, branch: null });
    expect(out.qaPreviewUrl).toBe('/tutorials-qa/my-tut');
    expect(out.mainPreviewUrl).toBe('/tutorials/my-tut');
    expect(out.sourceRepoUrl).toBeUndefined();
    expect(out.contribRepoUrl).toBeUndefined();
  });

  it('defaults owner to sap-tutorials and branch to main when null', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: 'my-tut', owner: null, repo: 'Tutorials', branch: null });
    expect(out.sourceRepoUrl).toBe('https://github.com/sap-tutorials/Tutorials/tree/main/tutorials/my-tut');
    expect(out.sourceRepoLabel).toBe('sap-tutorials/Tutorials');
  });

  it('returns all-undefined when slug is missing', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: null, owner: 'x', repo: 'y', branch: 'main' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tutorial-links.test.js`
Expected: FAIL — cannot resolve `buildTutorialLinks` (module not found).

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/tutorial-links.js
//
// Pure URL/label builder for the ACTIVE-only source & preview links surfaced
// on the admin Tutorials Object Page Lifecycle tab.
// Spec: docs/superpowers/specs/2026-07-28-tutorial-lifecycle-source-preview-links-design.md
//
// Kept pure (no DB, no cds) so the URL logic is unit-testable without a round
// trip. The after('READ','Tutorials') decorator in admin-service.js calls this
// once per row with values it already has (status, slug) plus the RepoCatalog
// lookup (owner, repo, branch).

const GITHUB_BASE = 'https://github.com';
const EMPTY = {
  sourceRepoUrl: undefined, sourceRepoLabel: undefined,
  contribRepoUrl: undefined, contribRepoLabel: undefined,
  qaPreviewUrl: undefined, qaPreviewLabel: undefined,
  mainPreviewUrl: undefined, mainPreviewLabel: undefined,
};

export function buildTutorialLinks({ status, slug, owner, repo, branch } = {}) {
  // Non-ACTIVE rows (and rows with no slug) get no links — FE renders the
  // unset DataFieldWithUrl cells as empty. This is the sole ACTIVE gate.
  if (status !== 'ACTIVE' || !slug) return { ...EMPTY };

  const out = { ...EMPTY };

  // QA + main previews depend only on the slug and are always set for ACTIVE
  // rows, independent of RepoCatalog (so a catalog miss/throw never hides them).
  out.qaPreviewUrl = `/tutorials-qa/${slug}`;
  out.qaPreviewLabel = 'View QA Preview';
  out.mainPreviewUrl = `/tutorials/${slug}`;
  out.mainPreviewLabel = 'View Live Tutorial';

  // GitHub links need a repo. owner/branch fall back to project defaults.
  if (repo) {
    const o = owner || 'sap-tutorials';
    const b = branch || 'main';
    out.sourceRepoUrl = `${GITHUB_BASE}/${o}/${repo}/tree/${b}/tutorials/${slug}`;
    out.sourceRepoLabel = `${o}/${repo}`;
    out.contribRepoUrl = `${GITHUB_BASE}/${o}/${repo}-Contribution/tree/${b}/tutorials/${slug}`;
    out.contribRepoLabel = `${o}/${repo}-Contribution`;
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/tutorial-links.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tutorial-links.js test/unit/tutorial-links.test.js
git commit -m "feat(admin): pure builder for tutorial source & preview links"
```

---

### Task 2: Declare the 8 virtual fields on the Tutorials projection

**Files:**
- Modify: `srv/admin-service.cds:34-68` (the `Tutorials` projection, next to `virtual isolated`)

**Interfaces:**
- Consumes: nothing.
- Produces: 8 virtual `String` fields on `AdminService.Tutorials` — `sourceRepoUrl`, `sourceRepoLabel`, `contribRepoUrl`, `contribRepoLabel`, `qaPreviewUrl`, `qaPreviewLabel`, `mainPreviewUrl`, `mainPreviewLabel` — visible in `/admin/$metadata` as `Edm.String` Properties.

- [ ] **Step 1: Write the failing test**

```js
// Append inside the existing `describe('Tutorials annotations', ...)` block
// in test/admin-annotations.test.js (after the existing 'has Tutorials
// LineItem annotation' it-block).
it('Tutorials projection exposes the 8 lifecycle-link virtual fields', () => {
  for (const col of [
    'sourceRepoUrl', 'sourceRepoLabel',
    'contribRepoUrl', 'contribRepoLabel',
    'qaPreviewUrl', 'qaPreviewLabel',
    'mainPreviewUrl', 'mainPreviewLabel',
  ]) {
    expect(metadata, `${col} not found on AdminService.Tutorials`)
      .toContain(`Name="${col}"`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "lifecycle-link virtual fields"`
Expected: FAIL — the field names are absent from `$metadata`.

- [ ] **Step 3: Add the virtual fields**

In `srv/admin-service.cds`, change the tail of the `Tutorials` projection so the
`virtual isolated : Boolean` line gains the 8 new siblings:

```cds
    // #918 — populated by after('READ') decorator in admin-service.js.
    // True iff a KgIsolation row exists for this tutorial slug. Fail-quiet:
    // if the SELECT throws or the sidecar is missing, stays null.
    virtual isolated : Boolean,
    // ACTIVE-only source & preview links, populated by the after('READ')
    // decorator in admin-service.js from RepoCatalog + slug. Unset for
    // non-ACTIVE rows so FE renders empty cells. Spec:
    // docs/superpowers/specs/2026-07-28-tutorial-lifecycle-source-preview-links-design.md
    virtual sourceRepoUrl    : String,
    virtual sourceRepoLabel  : String,
    virtual contribRepoUrl   : String,
    virtual contribRepoLabel : String,
    virtual qaPreviewUrl     : String,
    virtual qaPreviewLabel   : String,
    virtual mainPreviewUrl   : String,
    virtual mainPreviewLabel : String
  };
```

(The prior line ended `virtual isolated : Boolean` with no trailing comma before
the closing `};` — add the comma as shown.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-annotations.test.js -t "lifecycle-link virtual fields"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds test/admin-annotations.test.js
git commit -m "feat(admin): declare lifecycle source/preview link virtual fields"
```

---

### Task 3: Populate the fields in a fail-quiet after('READ','Tutorials') decorator

**Files:**
- Modify: `srv/admin-service.js` (add a sibling `after('READ','Tutorials')` immediately after the isolated handler, ~line 483)
- Test: `test/admin-service.test.js` (new it-block) OR a new `test/unit/admin-tutorial-links-read.test.js`

**Interfaces:**
- Consumes: `buildTutorialLinks` from `srv/lib/tutorial-links.js` (Task 1); virtual fields from Task 2.
- Produces: at runtime, each `AdminService.Tutorials` row read for an ACTIVE tutorial carries the populated link fields.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/admin-tutorial-links-read.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Tutorials read: lifecycle source/preview links', () => {
  let activeSlug;

  beforeAll(async () => {
    // Grab any ACTIVE tutorial the in-memory seed provides.
    const { data } = await project.get(
      "/admin/Tutorials?$filter=status eq 'ACTIVE'&$top=1&$select=slug,status", adminAuth);
    activeSlug = data.value?.[0]?.slug;
  });

  it('an ACTIVE tutorial exposes relative QA + main preview links', async () => {
    expect(activeSlug, 'no ACTIVE tutorial in seed data').toBeTruthy();
    const { status, data } = await project.get(
      `/admin/Tutorials?$filter=slug eq '${activeSlug}'` +
      `&$select=slug,status,qaPreviewUrl,mainPreviewUrl,qaPreviewLabel,mainPreviewLabel`,
      adminAuth);
    expect(status).toBe(200);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe(`/tutorials-qa/${activeSlug}`);
    expect(row.mainPreviewUrl).toBe(`/tutorials/${activeSlug}`);
    expect(row.qaPreviewLabel).toBe('View QA Preview');
    expect(row.mainPreviewLabel).toBe('View Live Tutorial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-tutorial-links-read.test.js`
Expected: FAIL — `qaPreviewUrl` etc. come back `null`/absent (decorator not wired yet).

- [ ] **Step 3: Add the decorator**

At the top of `srv/admin-service.js` with the other imports, add:

```js
import { buildTutorialLinks } from './lib/tutorial-links.js';
```

Immediately after the closing `});` of the existing isolated
`this.after('READ', 'Tutorials', ...)` handler (~line 483), add:

```js
    // ─── after(READ, Tutorials) — lifecycle source & preview links ──────
    //
    // Populate the 8 virtual link fields for ACTIVE tutorials only. QA + main
    // preview links are relative (env-correct) and depend only on the slug, so
    // they're set unconditionally for ACTIVE rows. GitHub source/Contributions
    // links need the live repo mapping, read from RepoCatalog in one batched
    // IN-clause query (same shape as the isolated handler above).
    //
    // Fail-quiet: on any RepoCatalog SELECT error, leave the GitHub fields
    // unset (QA/main already set) — never throw to the client. Mirrors the
    // #918 isolated-flag posture.
    //
    // Spec: docs/superpowers/specs/2026-07-28-tutorial-lifecycle-source-preview-links-design.md
    this.after('READ', 'Tutorials', async (rows, req) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const active = arr.filter((r) => r && r.status === 'ACTIVE' && r.slug);
      if (active.length === 0) return;

      // Best-effort RepoCatalog lookup keyed by slug → {owner, repo, branch}.
      const catalog = new Map();
      try {
        const slugs = active.map((r) => r.slug);
        const placeholders = slugs.map(() => '?').join(',');
        const catRows = await cds.tx(req).run(
          `SELECT SLUG, OWNER, REPO, BRANCH FROM "COM_SAP_DEVELOPERS_IMS_REPOCATALOG" ` +
            `WHERE SLUG IN (${placeholders})`,
          slugs,
        );
        for (const c of catRows) {
          catalog.set(c.SLUG, { owner: c.OWNER, repo: c.REPO, branch: c.BRANCH });
        }
      } catch (err) {
        cds.log('admin').warn(
          `tutorial links: RepoCatalog lookup failed; GitHub links left unset (${err?.message ?? err})`,
        );
      }

      for (const r of active) {
        const cat = catalog.get(r.slug) || {};
        Object.assign(
          r,
          buildTutorialLinks({
            status: r.status,
            slug: r.slug,
            owner: cat.owner,
            repo: cat.repo,
            branch: cat.branch,
          }),
        );
      }
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-tutorial-links-read.test.js`
Expected: PASS.

Note: the in-memory unit DB has no `RepoCatalog` rows, so the GitHub links stay
unset in this test — that is the intended "catalog miss" behavior and is why the
test asserts only the slug-derived QA/main links. GitHub-link population is
covered by the pure-helper test in Task 1.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/unit/admin-tutorial-links-read.test.js
git commit -m "feat(admin): populate tutorial lifecycle links on Tutorials read"
```

---

### Task 4: Render the links + labels in the Lifecycle FieldGroup

**Files:**
- Modify: `app/admin-annotations.cds` — the `annotate AdminService.Tutorials with { ... }` block (~line 520-565, add labels + read-only) and the **final** `FieldGroup#Lifecycle` (line 720-729).

**Interfaces:**
- Consumes: the 8 virtual fields (Task 2), populated at read time (Task 3).
- Produces: 4 `UI.DataFieldWithUrl` entries in the Lifecycle FieldGroup, rendered on the Object Page.

- [ ] **Step 1: Write the failing test**

```js
// Append inside describe('Tutorials annotations', ...) in
// test/admin-annotations.test.js
it('Lifecycle FieldGroup carries the 4 DataFieldWithUrl link rows', () => {
  const region = metadata.match(
    /<Annotation Term="UI.FieldGroup" Qualifier="Lifecycle">[\s\S]*?<\/Annotation>/,
  );
  expect(region, 'Lifecycle FieldGroup annotation not found').toBeTruthy();
  const block = region[0];
  expect(block).toContain('UI.DataFieldWithUrl');
  for (const url of ['sourceRepoUrl', 'contribRepoUrl', 'qaPreviewUrl', 'mainPreviewUrl']) {
    expect(block, `${url} missing from Lifecycle FieldGroup`).toContain(url);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "DataFieldWithUrl link rows"`
Expected: FAIL — the Lifecycle FieldGroup has no `DataFieldWithUrl` entries yet.

- [ ] **Step 3: Add labels + field control**

In the `annotate AdminService.Tutorials with { ... }` block (the one starting
`legacyIdStr @Common.Label...` around line 520), before the closing `};`
(after the `isolated` annotation at line 564), add:

```cds
  sourceRepoUrl    @Common.Label: 'Source Repo (GitHub)'        @Common.FieldControl: #ReadOnly;
  sourceRepoLabel  @Common.Label: 'Source Repo'                 @Common.FieldControl: #ReadOnly;
  contribRepoUrl   @Common.Label: 'Contributions Repo (GitHub)' @Common.FieldControl: #ReadOnly;
  contribRepoLabel @Common.Label: 'Contributions Repo'          @Common.FieldControl: #ReadOnly;
  qaPreviewUrl     @Common.Label: 'QA Preview'                  @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'                  @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Tutorial'               @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Tutorial'               @Common.FieldControl: #ReadOnly;
```

- [ ] **Step 4: Add the DataFieldWithUrl rows**

In the **final** `FieldGroup#Lifecycle` (the one at line 720-729 inside the
`annotate AdminService.Tutorials with @UI: { Facets: [...], FieldGroup#Lifecycle: {...} }`
block that also lists the `meta.*` review fields), append the four rows so the
`Data` array ends:

```cds
  FieldGroup#Lifecycle: { Data: [
    { Value: status },
    { Value: deletionReason },
    { Value: redirectTo_ID, Label: 'Redirect To' },
    { Value: meta.reviewedDate, Label: 'Last Reviewed' },
    { Value: meta.monitoredStatus, Label: 'Monitored Status' },
    { Value: meta.notificationNumber, Label: 'Notifications Sent' },
    { Value: meta.lastNotificationDate, Label: 'Last Notification' },
    { Value: meta.repository.name, Label: 'Source Repository' },
    { $Type: 'UI.DataFieldWithUrl', Value: sourceRepoLabel,  Url: sourceRepoUrl,  Label: 'Source Repo (GitHub)' },
    { $Type: 'UI.DataFieldWithUrl', Value: contribRepoLabel, Url: contribRepoUrl, Label: 'Contributions Repo (GitHub)' },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Tutorial' }
  ]}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/admin-annotations.test.js -t "DataFieldWithUrl link rows"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds test/admin-annotations.test.js
git commit -m "feat(admin): render source & preview links in Tutorials Lifecycle group"
```

---

### Task 5: Bust the UI5 fragment cache + full validation

**Files:**
- Modify: `app/admin/tutorials/webapp/manifest.json:9` (applicationVersion bump)

**Interfaces:**
- Consumes: nothing.
- Produces: a version bump that forces the UI5 `ui5-cachemanager-db` IndexedDB cache to re-parse the fragment/annotations post-deploy.

- [ ] **Step 1: Bump applicationVersion**

In `app/admin/tutorials/webapp/manifest.json`, change:

```json
    "applicationVersion": { "version": "0.0.1" },
```
to
```json
    "applicationVersion": { "version": "0.0.2" },
```

- [ ] **Step 2: Compile-guard the CDS model**

Run: `npx cds deploy --to sqlite::memory:`
Expected: completes without error (a "Duplicate assignment" warning on the
Lifecycle FieldGroup is expected and intentional — CDS doesn't merge
collection-valued annotations; the last `annotate` wins).

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the new `tutorial-links`, `admin-tutorial-links-read`,
and the two new `admin-annotations` assertions. Investigate any failure before
proceeding.

- [ ] **Step 4: Commit**

```bash
git add app/admin/tutorials/webapp/manifest.json
git commit -m "chore(admin): bump tutorials applicationVersion to bust fragment cache"
```

---

## Self-Review

**1. Spec coverage:**
- 8 virtual fields → Task 2. ✓
- ACTIVE-only population + fail-quiet + RepoCatalog raw SQL → Task 3. ✓
- Pure URL builder + owner/branch/repo fallbacks + `-Contribution` suffix → Task 1. ✓
- Relative QA/main links → Task 1 (helper) + Task 3 (wiring). ✓
- DataFieldWithUrl rendering with friendly labels → Task 4. ✓
- `$metadata` regression pin → Tasks 2 & 4 test additions. ✓
- cds deploy guard + npm test → Task 5. ✓
- applicationVersion bump + full-deploy note → Task 5 (+ Global Constraints). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — all code blocks are concrete. ✓

**3. Type consistency:** `buildTutorialLinks` signature and its 8 return keys are identical across Task 1 (definition), Task 3 (call), and the field names in Tasks 2 & 4. Field names match verbatim: `sourceRepoUrl/Label`, `contribRepoUrl/Label`, `qaPreviewUrl/Label`, `mainPreviewUrl/Label`. ✓

**Deploy reminder (post-merge, not a plan task):** ship with a full `npm run deploy -- --env <env>` (no `--skip-build`, no `-m` scoping) so the approuter admin bundle + `$metadata` rebuild.
