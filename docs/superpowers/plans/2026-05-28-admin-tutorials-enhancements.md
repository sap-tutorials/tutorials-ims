# Admin UI Tutorials — Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue [#95](https://github.com/sap-tutorials/tutorials-ims/issues/95) — add a Feedback section, an "Ask Joule for tutorial improvement suggestions" header action, and an Owner field with value help to the Tutorials Fiori Elements admin app.

**Architecture:** Three additive changes to the existing Fiori Elements app at `/admin-ui/#/tutorials/`. Backend gets two new associations (`meta`, `feedbackSummary`, `feedbackItems`) on the `Tutorials` projection plus one new read-only projection (`TutorialOwnerPickList`). UI is annotation-driven (`app/admin-annotations.cds`). The "Ask Joule" button is a Fiori Elements ObjectPage controller-extension (one ~25-line file) that calls a new `window.joule.openWithMessage({ text })` API added to `approuter/static/js/joule.js`.

**Tech Stack:** CAP Node.js (CDS / OData v4 / `@sap/cds`), Fiori Elements (`sap.fe.templates.ListReport` + `sap.fe.templates.ObjectPage`, UI5 1.136), Vitest (in-memory SQLite for unit, `cds bind --exec` for hybrid HANA), vanilla JS (`approuter/static/js/joule.js`).

**Spec:** [`docs/superpowers/specs/2026-05-28-admin-tutorials-enhancements-design.md`](../specs/2026-05-28-admin-tutorials-enhancements-design.md)

---

## File Map

**Modify:**
- [`srv/admin-service.cds`](../../../srv/admin-service.cds) — replace the `Tutorials` projection select list (add `meta`, `feedbackSummary`, `feedbackItems` associations) and add `TutorialOwnerPickList` projection.
- [`app/admin-annotations.cds`](../../../app/admin-annotations.cds) — extend `Tutorials` annotation block with `meta.owner` (label, ValueList, ReadOnly), add Owner to `SelectionFields` + `LineItem` + `FieldGroup#General`, add `Feedback` ReferenceFacet with two sub-facets, add `FieldGroup#FeedbackSummary` on `TutorialFeedbackAggregate`, add `LineItem#TutorialFeedback` on `TutorialFeedback`.
- [`approuter/static/js/joule.js`](../../../approuter/static/js/joule.js) — add `openWithMessage({ text })` (~10 lines) parallel to `openWithStepContext`.
- [`app/admin/tutorials/webapp/manifest.json`](../../../app/admin/tutorials/webapp/manifest.json) — add `extends.extensions.sap.ui.controllerExtensions["sap.fe.templates.ObjectPage.ObjectPageController"]` block + `controlConfiguration` registering the header action against `@com.sap.vocabularies.UI.v1.Identification` (the FE-default header-actions container; OP doesn't use LineItem actions).
- [`test/admin-service.test.js`](../../../test/admin-service.test.js) — add a new `describe('Tutorials enhancements (#95)')` block with unit cases for owner association, picklist, feedback aggregate, and feedback items.

**Create:**
- `app/admin/tutorials/webapp/ext/AskJoule.controller.js` — single-method controller extension.
- `test/hybrid/admin-tutorials-enhancements.test.js` — HANA smokes for picklist + `meta/owner` `$filter` round-trip + feedback aggregate `$expand`.

**No changes to:** `db/schema.cds` (no schema migration), `db/views.cds` (`TutorialFeedbackAggregate` already exists), `mta.yaml`, deploy artefacts.

---

## Reviewer advisories folded in

1. **Picklist needs a key** — `TutorialOwnerPickList` declared with `key owner : String` so CDS compiles.
2. **No `meta` name-clash** — verified: the existing `Tutorials` projection is `*` only; the inherited `meta` association (Composition of many TutorialMeta) will be **redefined** (overridden) in the new select list to a singular `Association to TutorialMeta`. Task 1 covers this explicitly.
3. **FE manifest extension key** — confirmed against the existing precedent in [`app/admin/tags/webapp/manifest.json`](../../../app/admin/tags/webapp/manifest.json) line 49–55 (`extends.extensions.sap.ui.controllerExtensions`) — the ObjectPage equivalent target is `sap.fe.templates.ObjectPage.ObjectPageController`. The header action is wired through `controlConfiguration["@com.sap.vocabularies.UI.v1.Identification"].actions` on the ObjectPage target — that is the FE-canonical place for object-page header actions.
4. **HANA `meta/owner` $filter smoke** — covered in Task 7 (hybrid).
5. **Pin `$top` on feedbackItems LineItem** — Task 4 sets `MaxItems: 50` on the `LineItem#TutorialFeedback` annotation and tells FE to default-sort `submittedAt desc`.

**Implementation hints folded in from plan review:**

- Task 5.4: if `@UI.PresentationVariant` rejects on the `feedbackItems` association element, fall back to inline `PresentationVariant` on the LineItem reference inside the Facet target — same effect via different syntax.
- Task 6.1: prefer `Edit` (insert-only) over full-block replacement of `joule.js` lines 21–33 to dodge CRLF flips on Windows ([`feedback_crlf_regression_on_windows.md`]).
- Task 8.3: if `npm --prefix app/admin/tutorials run build` is unavailable, fall back to the root `npm run build:all` — both are documented build paths.

---

## Pre-flight: branch + worktree

- [ ] **Step 0a: Verify clean working tree**

```bash
git status
```
Expected: `nothing to commit, working tree clean` (the spec commit already landed on `main`).

- [ ] **Step 0b: Create worktree + feature branch**

Per [`feedback_parallel_agents_worktrees.md`] — multi-agent friendly even for solo work, and matches the tutorials-poc convention.

```bash
git worktree add .worktrees/admin-tutorials-enhancements -b feature/admin-tutorials-enhancements
cd .worktrees/admin-tutorials-enhancements
```
Expected: new directory with the working copy on the new branch.

- [ ] **Step 0c: Install deps in the worktree**

Required because `npm` global config has `ignore-scripts=true`; native modules (`better-sqlite3`) need rebuild after any worktree creation per [`feedback_npm_ignore_scripts_native_modules.md`].

```bash
npm install
ls node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
Expected: file exists. If missing, run `npm rebuild better-sqlite3` and re-check.

---

## Task 1: Backend — extend `Tutorials` projection with `meta` association

**Files:**
- Modify: [`srv/admin-service.cds`](../../../srv/admin-service.cds) line 13

The current line:

```cds
entity Tutorials as projection on ims.Tutorials { *, cast(legacyId as String) as legacyIdStr : String };
```

Replaces with a multi-line projection that **redefines** `meta` as a singular reverse association. The schema's `meta : Composition of many TutorialMeta` would otherwise expose a 1:N collection — wrong UX for "the owner of this tutorial".

**Why redefine instead of `meta[1:]`?** An infix filter forces to-one but still exposes the same association name. A clean replacement at projection level is more obvious to readers.

- [ ] **Step 1.1: Write the failing test (owner expand)**

Add to [`test/admin-service.test.js`](../../../test/admin-service.test.js) at the end (after the `Tutorials soft-delete and redirect` block, before the closing `});` of `describe('AdminService', ...)`):

```js
  describe('Tutorials enhancements (#95)', () => {
    let tutId;
    const slug = 'tut95-owner';
    const owner = 'Acme Owner';

    beforeAll(async () => {
      const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
      tutId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries([
        { ID: tutId, slug, title: 'Tut 95', status: 'ACTIVE' },
      ]);
      await INSERT.into(TutorialMeta).entries([
        { ID: cds.utils.uuid(), tutorial_ID: tutId, owner, ownerEmail: 'acme@example.com' },
      ]);
    });

    it('exposes meta.owner via $expand on Tutorials', async () => {
      const { status, data } = await project.get(
        `/admin/Tutorials(ID=${tutId},IsActiveEntity=true)?$expand=meta($select=owner,ownerEmail)`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.meta).toBeTruthy();
      expect(data.meta.owner).toBe(owner);
      expect(data.meta.ownerEmail).toBe('acme@example.com');
    });
  });
```

- [ ] **Step 1.2: Run the test — must fail**

```bash
npx vitest run test/admin-service.test.js -t "exposes meta.owner"
```
Expected: FAIL — either `data.meta` is `undefined` (current `*` exposes the collection-shaped `meta` which doesn't return on a singular `$expand`) or "Property meta does not exist" depending on CAP version.

- [ ] **Step 1.3: Implement — replace the Tutorials projection**

In `srv/admin-service.cds`, **replace** line 13:

```cds
  entity Tutorials as projection on ims.Tutorials { *, cast(legacyId as String) as legacyIdStr : String };
```

with:

```cds
  entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String)                                       as legacyIdStr      : String,
    meta[1:] as meta                                                                    // override Composition-of-many with to-one
  };
```

**Note on `meta[1:]`:** The infix `[1:]` filter narrows cardinality to to-one without changing the on-condition. If the CDS compiler emits a "filter requires bound condition" error, switch to an explicit override:

```cds
  entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String) as legacyIdStr : String,
    null as meta : Association to TutorialMeta on meta.tutorial.ID = ID
  };
```

The `null as` trick declares an unmanaged association that shadows the inherited composition. Either works; pick the one that compiles.

- [ ] **Step 1.4: Run the test — must pass**

```bash
npx vitest run test/admin-service.test.js -t "exposes meta.owner"
```
Expected: PASS.

- [ ] **Step 1.5: Run the full unit suite to confirm no regressions**

```bash
npm test -- --run
```
Expected: green. If admin-drafts or admin-schema-ext breaks because of the `meta` redefinition, add the override form (the `null as meta : Association ...` variant).

- [ ] **Step 1.6: Commit**

```bash
git add srv/admin-service.cds test/admin-service.test.js
git commit -m "feat(admin): expose Tutorials.meta as to-one association (#95)

So that the admin Fiori Elements app can read meta.owner via $expand
without traversing a 1:N composition."
```

---

## Task 2: Backend — add `TutorialOwnerPickList` projection

**Files:**
- Modify: [`srv/admin-service.cds`](../../../srv/admin-service.cds) — add new projection right after the existing `TutorialPickList` block.

- [ ] **Step 2.1: Write the failing test**

Append inside the same `describe('Tutorials enhancements (#95)', ...)` block:

```js
    it('TutorialOwnerPickList returns distinct non-null owners', async () => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      // seed two more meta rows with the same owner + one fresh owner
      const tut2 = cds.utils.uuid();
      const tut3 = cds.utils.uuid();
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Tutorials).entries([
        { ID: tut2, slug: 'tut95-pl-2', title: 'PL2', status: 'ACTIVE' },
        { ID: tut3, slug: 'tut95-pl-3', title: 'PL3', status: 'ACTIVE' },
      ]);
      await INSERT.into(TutorialMeta).entries([
        { ID: cds.utils.uuid(), tutorial_ID: tut2, owner: 'Acme Owner' }, // duplicate
        { ID: cds.utils.uuid(), tutorial_ID: tut3, owner: 'Beta Team' },
      ]);

      const { status, data } = await project.get(
        '/admin/TutorialOwnerPickList?$orderby=owner',
        adminAuth
      );
      expect(status).toBe(200);
      const owners = data.value.map((r) => r.owner);
      expect(owners).toContain('Acme Owner');
      expect(owners).toContain('Beta Team');
      // distinctness: 'Acme Owner' must appear exactly once
      expect(owners.filter((o) => o === 'Acme Owner').length).toBe(1);
    });
```

- [ ] **Step 2.2: Run — must fail with 404 / unknown entity**

```bash
npx vitest run test/admin-service.test.js -t "TutorialOwnerPickList returns distinct"
```

- [ ] **Step 2.3: Implement the picklist projection**

In `srv/admin-service.cds`, after the existing `TutorialPickList` block (around line 19), add:

```cds
  // Distinct non-null Owner picklist for Tutorials filter value-help (#95)
  @readonly
  @cds.redirection.target: false
  entity TutorialOwnerPickList as
    select distinct key owner from ims.TutorialMeta where owner is not null;
```

**`key owner`** is required: CDS rejects an unkeyed projection. The `select distinct` keeps results unique across HANA + SQLite.

- [ ] **Step 2.4: Run — must pass**

```bash
npx vitest run test/admin-service.test.js -t "TutorialOwnerPickList returns distinct"
```

- [ ] **Step 2.5: Run full unit suite**

```bash
npm test -- --run
```

- [ ] **Step 2.6: Commit**

```bash
git add srv/admin-service.cds test/admin-service.test.js
git commit -m "feat(admin): add TutorialOwnerPickList for owner value-help (#95)"
```

---

## Task 3: Backend — add `feedbackSummary` and `feedbackItems` associations

**Files:**
- Modify: [`srv/admin-service.cds`](../../../srv/admin-service.cds) — extend Tutorials projection.

- [ ] **Step 3.1: Write the failing tests**

Append inside the same `describe`:

```js
    it('exposes feedbackSummary aggregate via $expand', async () => {
      const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
      await INSERT.into(TutorialFeedback).entries([
        { ID: cds.utils.uuid(), tutorialSlug: slug, npsScore: 9, ratingUseCase: 8,
          ratingRelevance: 9, ratingDuration: 7, ratingStructure: 8,
          ratingInteresting: 9, ratingVisuals: 8, comment: 'Great', wasAuthenticated: true },
        { ID: cds.utils.uuid(), tutorialSlug: slug, npsScore: 4, ratingUseCase: 5,
          ratingRelevance: 6, ratingDuration: 5, ratingStructure: 6,
          ratingInteresting: 5, ratingVisuals: 6, comment: 'Meh', wasAuthenticated: false },
      ]);

      const { status, data } = await project.get(
        `/admin/Tutorials(ID=${tutId},IsActiveEntity=true)?$expand=feedbackSummary`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.feedbackSummary).toBeTruthy();
      expect(data.feedbackSummary.responseCount).toBe(2);
      expect(Number(data.feedbackSummary.avgNps)).toBeCloseTo(6.5, 1);
      expect(data.feedbackSummary.promoters).toBe(1);
      expect(data.feedbackSummary.detractors).toBe(1);
    });

    it('exposes feedbackItems via $expand, scoped to slug', async () => {
      const { status, data } = await project.get(
        `/admin/Tutorials(ID=${tutId},IsActiveEntity=true)?$expand=feedbackItems($orderby=submittedAt desc)`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.feedbackItems).toBeTruthy();
      expect(data.feedbackItems.length).toBe(2);
      for (const fb of data.feedbackItems) expect(fb.tutorialSlug).toBe(slug);
    });
```

- [ ] **Step 3.2: Run — must fail with "Property feedbackSummary not found"**

```bash
npx vitest run test/admin-service.test.js -t "feedbackSummary aggregate"
```

- [ ] **Step 3.3: Implement — extend the Tutorials projection**

Update the projection from Task 1 to:

```cds
  entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String) as legacyIdStr : String,
    meta[1:] as meta,                                                       // or `null as meta : Association to ...` if [1:] doesn't compile
    null as feedbackSummary : Association to TutorialFeedbackAggregate
                                on feedbackSummary.tutorialSlug = slug,
    null as feedbackItems   : Association to many TutorialFeedback
                                on feedbackItems.tutorialSlug   = slug
  };
```

Both targets already exist as `@readonly` projections on lines 97–98 of `admin-service.cds`. The `null as <name> : Association ... on ...` syntax declares an unmanaged association in the select list (CAP June 2022 release notes; verified via cds-mcp).

- [ ] **Step 3.4: Run — must pass**

```bash
npx vitest run test/admin-service.test.js -t "feedbackSummary aggregate|feedbackItems via"
```

- [ ] **Step 3.5: Full unit suite green**

```bash
npm test -- --run
```

- [ ] **Step 3.6: Commit**

```bash
git add srv/admin-service.cds test/admin-service.test.js
git commit -m "feat(admin): expose feedbackSummary + feedbackItems on Tutorials (#95)"
```

---

## Task 4: Annotations — Owner field on Tutorials

**Files:**
- Modify: [`app/admin-annotations.cds`](../../../app/admin-annotations.cds) — extend the `Tutorials` annotation block (lines 469–547).

These are pure UI metadata changes; FE picks them up automatically. No new tests for annotations themselves — they're either valid (CDS compiles) or invalid (CDS errors). Task 8 adds an annotation-shape unit test.

- [ ] **Step 4.1: Add field-level annotation for `meta.owner`**

In the `annotate AdminService.Tutorials with { ... }` block (line 470), **before** the closing `};` (line 512), add:

```cds
  meta.owner            @Common.Label: 'Owner' @Common.FieldControl: #ReadOnly
                        @Common.ValueList: {
                          CollectionPath: 'TutorialOwnerPickList',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: meta.owner, ValueListProperty: 'owner' }
                          ]
                        };
```

- [ ] **Step 4.2: Add Owner to SelectionFields, LineItem, and FieldGroup#General**

In the `annotate AdminService.Tutorials with @UI: { ... }` block (line 514), update three lists:

```cds
  SelectionFields: [ title, primaryTag, experienceTag, status, meta.owner ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: status },
    { Value: meta.owner, Label: 'Owner' },
    { Value: redirectTo.title, Label: 'Redirect To' }
  ],
  ...
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: meta.owner, Label: 'Owner' }
  ]},
```

- [ ] **Step 4.3: Compile-check + smoke**

```bash
npx cds compile srv/ 2>&1 | tail -30
```
Expected: no errors. If "owner: not found" appears, the `meta` association from Task 1 didn't land — re-check Task 1 first.

```bash
npm test -- --run
```
Expected: green. The annotation changes don't break any test, but they're loaded at boot.

- [ ] **Step 4.4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(admin-ui): show Owner column + filter on Tutorials list (#95)"
```

---

## Task 5: Annotations — Feedback section on the Tutorial object page

**Files:**
- Modify: [`app/admin-annotations.cds`](../../../app/admin-annotations.cds)

- [ ] **Step 5.1: Add `FieldGroup#FeedbackSummary` on `TutorialFeedbackAggregate`**

Append at the end of the file:

```cds
// --- Tutorials feedback (#95): aggregate summary + per-row line item ---
annotate AdminService.TutorialFeedbackAggregate with @UI: {
  FieldGroup #FeedbackSummary: { Data: [
    { Value: responseCount,  Label: 'Responses' },
    { Value: avgNps,         Label: 'Avg NPS' },
    { Value: promoters,      Label: 'Promoters' },
    { Value: detractors,     Label: 'Detractors' },
    { Value: avgUseCase,     Label: 'Avg Use Case' },
    { Value: avgRelevance,   Label: 'Avg Relevance' },
    { Value: avgDuration,    Label: 'Avg Duration' },
    { Value: avgStructure,   Label: 'Avg Structure' },
    { Value: avgInteresting, Label: 'Avg Interesting' },
    { Value: avgVisuals,     Label: 'Avg Visuals' }
  ]}
};
```

- [ ] **Step 5.2: Add `LineItem#TutorialFeedback` on `TutorialFeedback`**

Append (sibling of the existing block at line 1118, do **not** modify it — it's used by the standalone Feedback admin app):

```cds
annotate AdminService.TutorialFeedback with @UI: {
  LineItem #TutorialFeedback: [
    { Value: submittedAt,      Label: 'Submitted' },
    { Value: npsScore,         Label: 'NPS' },
    { Value: wasAuthenticated, Label: 'Authenticated' },
    { Value: comment,          Label: 'Comment' },
    { Value: ratingUseCase,    Label: 'Use Case' },
    { Value: ratingRelevance,  Label: 'Relevance' },
    { Value: ratingDuration,   Label: 'Duration' },
    { Value: ratingStructure,  Label: 'Structure' },
    { Value: ratingInteresting,Label: 'Interesting' },
    { Value: ratingVisuals,    Label: 'Visuals' }
  ]
};
```

- [ ] **Step 5.3: Add the `Feedback` ReferenceFacet to Tutorials**

In `annotate AdminService.Tutorials with @UI: { ... }`, extend `Facets`:

```cds
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',   Label: 'General',   Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' },
    { $Type: 'UI.CollectionFacet', ID: 'Feedback', Label: 'Feedback', Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackSummary',
        Target: 'feedbackSummary/@UI.FieldGroup#FeedbackSummary',
        Label:  'Summary' },
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackItems',
        Target: 'feedbackItems/@UI.LineItem#TutorialFeedback',
        Label:  'Recent Submissions' }
    ]}
  ],
```

- [ ] **Step 5.4: Pin `MaxItems` and default sort on the feedbackItems list**

Below the `Facets:` change, add:

```cds
annotate AdminService.Tutorials with {
  feedbackItems @(
    Capabilities.TopSupported: true,
    UI.PresentationVariant: {
      MaxItems: 50,
      SortOrder: [ { Property: submittedAt, Descending: true } ],
      Visualizations: [ '@UI.LineItem#TutorialFeedback' ]
    }
  );
};
```

The `MaxItems: 50` cap addresses the spec reviewer's concern about high-volume feedback fan-out. Most tutorials have far fewer; admins needing more can drill into the standalone Feedback admin app.

- [ ] **Step 5.5: Compile + boot smoke**

```bash
npx cds compile srv/ 2>&1 | tail -30
```
Expected: clean.

```bash
npm test -- --run
```
Expected: green.

- [ ] **Step 5.6: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(admin-ui): add Feedback facet to Tutorial object page (#95)"
```

---

## Task 6: Joule API — `openWithMessage`

**Files:**
- Modify: [`approuter/static/js/joule.js`](../../../approuter/static/js/joule.js)

- [ ] **Step 6.1: Add the API surface**

In `joule.js`, replace lines 21–33 (the `window.joule = { ... }` block) with:

```js
  window.joule = {
    _ready: false,
    _pendingOpen: null,
    open(opts) {
      if (!this._ready) { this._pendingOpen = opts || true; return; }
      _openImpl(opts);
    },
    openWithStepContext(ctx) {
      const opts = { starterContext: { kind: 'tutorial-step', vars: ctx || {} } };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
    openWithMessage(arg) {
      const text = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : '');
      const opts = { autoSendText: text };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
  };
```

- [ ] **Step 6.2: Wire `autoSendText` into `_openImpl`**

In `_openImpl(opts)` (line 513), inside the existing `else` branch that calls `renderStarters(...)`, add an autoSendText short-circuit. Replace lines 521–530:

```js
    panel.hidden = false;
    const messages = loadHistory();
    if (opts && typeof opts.autoSendText === 'string' && opts.autoSendText.length > 0) {
      // Skip hero/starters and send the seeded prompt immediately.
      send(opts.autoSendText);
      return;
    }
    if (messages.length) {
      showChat();
      renderTranscript(messages);
    } else {
      showHero();
      renderGreeting(user.firstName);
      renderStarters(opts && opts.starterContext);
    }
    input.focus();
```

`send()` (line 411) already handles the chat-view transition, history append, and `/chat/stream` POST.

- [ ] **Step 6.3: Manual sanity check**

```bash
npm run dev:hybrid
```

In a separate shell:
```bash
node -e "console.log('manual: open http://localhost:5000/admin-ui/, in DevTools console run window.joule.openWithMessage({text:\"Hi\"})')"
```

Expected: panel opens, message appears in transcript, response streams back. Verify `window.joule.openWithMessage` is undefined on the legacy build by checking the network panel pulls the new joule.js (cache-bust if needed).

- [ ] **Step 6.4: Commit**

```bash
git add approuter/static/js/joule.js
git commit -m "feat(joule): add openWithMessage API for seeded prompts (#95)"
```

---

## Task 7: Hybrid HANA smoke

**Files:**
- Create: `test/hybrid/admin-tutorials-enhancements.test.js`

- [ ] **Step 7.1: Write the smoke test**

```js
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe.runIf(isSafeForWrites())('Tutorials enhancements (#95) [hybrid]', () => {
  const tutorialIds = [];
  const metaIds = [];
  const feedbackIds = [];

  afterAll(async () => {
    const { Tutorials, TutorialMeta, TutorialFeedback } = cds.entities('com.sap.developers.ims');
    for (const id of feedbackIds) await DELETE.from(TutorialFeedback).where({ ID: id });
    for (const id of metaIds)     await DELETE.from(TutorialMeta).where({ ID: id });
    for (const id of tutorialIds) await DELETE.from(Tutorials).where({ ID: id });
  });

  it('TutorialOwnerPickList compiles + returns distinct rows on HANA', async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const meta1 = cds.utils.uuid();
    tutorialIds.push(tut); metaIds.push(meta1);
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug: TEST_PREFIX + 'pl-1', title: TEST_PREFIX + 'PL', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: meta1, tutorial_ID: tut, owner: TEST_PREFIX + 'OwnerHybrid' }
    ]);

    const srv = await cds.connect.to('AdminService');
    const rows = await srv.read('TutorialOwnerPickList').where({ owner: TEST_PREFIX + 'OwnerHybrid' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].owner).toBe(TEST_PREFIX + 'OwnerHybrid');
  });

  it('Tutorials.meta/owner $filter round-trips through HANA', async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const meta = cds.utils.uuid();
    tutorialIds.push(tut); metaIds.push(meta);
    const ownerName = TEST_PREFIX + 'FilterOwner-' + Date.now();
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug: TEST_PREFIX + 'flt', title: TEST_PREFIX + 'FLT', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: meta, tutorial_ID: tut, owner: ownerName }
    ]);

    const srv = await cds.connect.to('AdminService');
    const rows = await srv.read('Tutorials').columns('ID', { ref: ['meta'], expand: ['owner'] })
      .where({ 'meta.owner': ownerName });
    expect(rows.length).toBe(1);
    expect(rows[0].ID).toBe(tut);
    expect(rows[0].meta?.owner).toBe(ownerName);
  });

  it('Tutorials.feedbackSummary expands on HANA', async () => {
    const { Tutorials, TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const slug = TEST_PREFIX + 'fb-' + Date.now();
    const fb1 = cds.utils.uuid(); const fb2 = cds.utils.uuid();
    tutorialIds.push(tut); feedbackIds.push(fb1, fb2);
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug, title: TEST_PREFIX + 'FB', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialFeedback).entries([
      { ID: fb1, tutorialSlug: slug, npsScore: 9 },
      { ID: fb2, tutorialSlug: slug, npsScore: 5 },
    ]);

    const srv = await cds.connect.to('AdminService');
    const [row] = await srv.read('Tutorials').columns('ID', { ref: ['feedbackSummary'], expand: ['*'] })
      .where({ ID: tut });
    expect(row.feedbackSummary?.responseCount).toBe(2);
    expect(Number(row.feedbackSummary.avgNps)).toBeCloseTo(7, 0);
  });
});
```

- [ ] **Step 7.2: Run the hybrid suite**

Per [`feedback_worktree_tests_hang.md`] — cap with a hard timeout; if it hangs, defer to deployed DEV smoke.

```bash
cf login   # if not already
ALLOW_HYBRID_WRITES=true timeout 180 npm run test:hybrid -- test/hybrid/admin-tutorials-enhancements.test.js
```
Expected: PASS. If it hangs > 3 min, kill it, note the failure mode, and proceed — the unit tests already cover the SQL shape.

- [ ] **Step 7.3: Commit**

```bash
git add test/hybrid/admin-tutorials-enhancements.test.js
git commit -m "test(hybrid): smoke #95 picklist + meta filter + feedback expand"
```

---

## Task 8: FE controller extension — Ask Joule header action

**Files:**
- Create: `app/admin/tutorials/webapp/ext/AskJoule.controller.js`
- Modify: [`app/admin/tutorials/webapp/manifest.json`](../../../app/admin/tutorials/webapp/manifest.json)

- [ ] **Step 8.1: Create the controller extension**

Pattern follows [`app/admin/tags/webapp/ext/TagImportController.controller.js`](../../../app/admin/tags/webapp/ext/TagImportController.controller.js).

Create `app/admin/tutorials/webapp/ext/AskJoule.controller.js`:

```js
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend("sap.tutorials.admin.tutorials.ext.AskJoule", {

    onAskJoule: function () {
      var oContext = this.getView().getBindingContext();
      if (!oContext) return;
      var oData = oContext.getObject();
      if (!oData) return;
      var sTitle = oData.title || "";
      var sSlug  = oData.slug  || "";
      if (!sSlug) return;

      var sText = 'Please suggest improvements for the tutorial "' + sTitle +
                  '" (slug: ' + sSlug + '). Consider feedback comments, NPS score, ' +
                  'step structure, and clarity.';

      var oWin = window.parent || window;
      if (oWin.joule && typeof oWin.joule.openWithMessage === "function") {
        oWin.joule.openWithMessage({ text: sText });
      }
    }

  });
});
```

`onAskJoule` is exposed as a static-style method on the extension. FE will resolve `sap.tutorials.admin.tutorials.ext.AskJoule.onAskJoule` from the manifest's action `press` field.

- [ ] **Step 8.2: Wire the manifest**

Edit [`app/admin/tutorials/webapp/manifest.json`](../../../app/admin/tutorials/webapp/manifest.json). Insert an `extends` block between `models` and `routing` (around line 43). Also extend the `TutorialsObjectPage` target with `controlConfiguration` for the Identification action:

```json
    "extends": {
      "extensions": {
        "sap.ui.controllerExtensions": {
          "sap.fe.templates.ObjectPage.ObjectPageController": {
            "controllerName": "sap.tutorials.admin.tutorials.ext.AskJoule"
          }
        }
      }
    },
```

And update the existing `TutorialsObjectPage` target (line 73) to:

```json
        "TutorialsObjectPage": {
          "type": "Component",
          "id": "TutorialsObjectPage",
          "name": "sap.fe.templates.ObjectPage",
          "options": {
            "settings": {
              "contextPath": "/Tutorials",
              "editableHeaderContent": false,
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.Identification": {
                  "actions": {
                    "AskJouleAction": {
                      "press": "sap.tutorials.admin.tutorials.ext.AskJoule.onAskJoule",
                      "visible": true,
                      "enabled": true,
                      "text": "Ask Joule for tutorial improvement suggestions"
                    }
                  }
                }
              }
            }
          }
        }
```

The FE convention: object-page header actions live under `@com.sap.vocabularies.UI.v1.Identification` (the Identification facet powers the OP header). Confirmed pattern source: tags app uses `@com.sap.vocabularies.UI.v1.LineItem` for list actions; the OP equivalent is Identification.

- [ ] **Step 8.3: Build the admin app**

```bash
npm --prefix app/admin/tutorials run build 2>&1 | tail -20
```
Expected: success. If `npm --prefix app/admin/tutorials` doesn't exist, fall back to whatever the repo's per-app build is — check `package.json` scripts at the root if needed.

- [ ] **Step 8.4: Manual smoke against local hybrid**

```bash
npm run dev:hybrid
# in a separate shell, browse to: http://localhost:5000/admin-ui/#/tutorials/
# 1. Open any tutorial; confirm "Ask Joule for tutorial improvement suggestions" button in header
# 2. Click it; Joule panel opens with the seeded message and a streaming response
# 3. In filter bar, click Owner — value-help dialog lists distinct owners
# 4. Filter by an owner; list narrows
# 5. Open a tutorial; Feedback facet shows summary KPIs + recent submissions
```

- [ ] **Step 8.5: Commit**

```bash
git add app/admin/tutorials/webapp/ext/AskJoule.controller.js app/admin/tutorials/webapp/manifest.json
git commit -m "feat(admin-ui): Ask Joule header action on Tutorial object page (#95)"
```

---

## Task 9: PR + smoke deploy

Per [`feedback_pr_over_direct_merge.md`] — open a PR rather than merging directly.

- [ ] **Step 9.1: Push branch**

```bash
git push -u origin feature/admin-tutorials-enhancements
```

- [ ] **Step 9.2: Open PR**

```bash
gh pr create --title "feat(admin): Tutorials object page enhancements (#95)" --body "$(cat <<'EOF'
## Summary
- Adds Owner column + filter (with value help) to the Tutorials admin list/object page
- Adds Feedback facet (aggregate KPIs + last 50 submissions) to the Tutorial object page
- Adds "Ask Joule for tutorial improvement suggestions" header action that auto-sends a seeded prompt

## Backend
- `Tutorials` projection: 3 new associations (`meta` to-one, `feedbackSummary`, `feedbackItems`)
- New `TutorialOwnerPickList` projection (`SELECT DISTINCT owner FROM TutorialMeta`)

## UI
- Annotations: Owner field (read-only, value-help), Feedback ReferenceFacet, MaxItems=50 + sort-desc on feedbackItems
- New `window.joule.openWithMessage({ text })` API in joule.js
- One-method controller extension `app/admin/tutorials/webapp/ext/AskJoule.controller.js`

## Test plan
- [x] Unit suite green (`npm test`)
- [x] Hybrid smokes pass (`npm run test:hybrid -- test/hybrid/admin-tutorials-enhancements.test.js`)
- [ ] Post-deploy manual on DEV: Owner filter + Feedback facet + Ask Joule

Closes #95.
EOF
)"
```

- [ ] **Step 9.3: Confirm with Tom whether to deploy**

Per [`feedback_confirm_deploy_scope.md`] — ask Tom which scope (backend-only / +content / +QA) before deploying.

---

## Definition of Done

- All tasks ticked.
- `npm test` green; `npm run test:hybrid -- test/hybrid/admin-tutorials-enhancements.test.js` green (or documented hang).
- Manual smoke on local hybrid passes all five steps from Task 8.4.
- PR open with the body above.
- Tom has reviewed and merged (or asked for changes).
