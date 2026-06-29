# Issue #759 — Homepage Explainers PR 1: Schema + Build Feeds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the data-model foundation for homepage explainer popovers — two new CDS entities (`VerbDefinitions`, `ShelfDefinitions`), three new fields on existing `HomepageShelves` (`tagline`, `whyItMatters`, `authoringStatus`), two new build-feed endpoints, and the build-pipeline wiring that bakes them into `hugo/data/*.json`. **No visitor-observable change** in this PR — Hugo templates still hard-code the verb/shelf labels until PR 2.

**Architecture:** Pure additive HDI deploy (new nullable columns, two new entities). Two new unauthenticated `/build/*` Express routes follow the existing `/build/homepage-shelves` pattern (line 214 of `srv/server.js`). Two new `tsx` fetcher scripts in `scripts/` follow the existing `fetch-homepage-shelves.ts` pattern (3 lines of identical shape). `package.json#build:all` gains two `&&`-chained steps. `AdminService` gets entity projections for the two new entities, with auto-init singleton-set behavior matching the `HomepageConfig` pattern (auto-creates the 6 verb rows and 4 shelf rows on first READ if missing — defensive against fresh subaccounts).

**Tech Stack:** CAP 9 (Node.js), CDS, HANA Cloud (prod) / SQLite (unit tests), Express, TypeScript (`tsx`), Vitest (3 workspaces: unit / hybrid / smoke), Fiori Elements (annotations only in PR 1; admin UI ships in PR 3).

**Spec:** [`docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md`](../specs/2026-06-29-759-homepage-explainers-design.md)

**Related plans (future PRs):**

- PR 2: Vue islands and Hugo wiring — `2026-XX-XX-759-homepage-explainers-pr2-vue-islands.md` (TBW)
- PR 3: Admin UI and AI generation — `2026-XX-XX-759-homepage-explainers-pr3-admin-ai.md` (TBW)
- PR 4: Content seed and editorial pass — operational, not code; runbook in `docs/developers/operations/`
- PR 5: PROD cutover — operational, not code; runbook follows existing reference-data migration shape

---

## File Structure

### New files

- `db/data/com.sap.developers.ims-VerbDefinitions.csv` — seed CSV; 6 rows; labels filled, content blank. Matches today's hard-coded `$verbDefs` in `verb-spine.html`.
- `db/data/com.sap.developers.ims-ShelfDefinitions.csv` — seed CSV; 4 rows; labels filled, content blank. Matches today's hard-coded dict in `verb/list.html`.
- `scripts/fetch-verb-definitions.ts` — 22-line `tsx` fetcher; writes `hugo/data/verb_definitions.json`. Same shape as `scripts/fetch-homepage-shelves.ts`.
- `scripts/fetch-shelf-definitions.ts` — 22-line `tsx` fetcher; writes `hugo/data/shelf_definitions.json`. Same shape as above.
- `test/unit/db/homepage-schema.test.js` — text-grep on `db/homepage.cds` asserting the three new fields exist on `HomepageShelves` and the two new entities exist with the right shape. Cheap pinning test for schema drift.
- `test/unit/srv/build-feeds-explainers.test.js` — unit-tests the two new `/build/*` handler bodies against in-memory SQLite. Asserts shape: `{ verbs: [...] }` and `{ shelves: [...] }` with `sortOrder` ordering and the new fields present.
- `test/hybrid/verb-definitions-crud.test.js` — admin CRUD against real HANA; `@assert.unique.verbKey`; auto-init creates 6 rows on first READ; `verbKey` enum constraint rejects bad values.
- `test/hybrid/shelf-definitions-crud.test.js` — same shape for `ShelfDefinitions`.
- `test/hybrid/homepage-shelves-new-fields.test.js` — read/write the three new fields on `HomepageShelves`; status transition `BLANK → AI_SEEDED → REVIEWED`; new fields default correctly when omitted.
- `test/smoke/build-feeds-explainers.smoke.test.js` — extends existing `test/smoke/*` shape. Two requests against `SMOKE_SRV_URL`: `/build/verb-definitions` and `/build/shelf-definitions`; both return 200 with `verbs[]` / `shelves[]` arrays. Asserts 60s Cache-Control header.

### Modified files

- `db/homepage.cds` — adds `AuthoringStatus` enum type, `VerbDefinitions` entity, `ShelfDefinitions` entity, three new fields on `HomepageShelves`.
- `srv/admin-service.cds:148-167` (the existing homepage block) — adds `VerbDefinitions` and `ShelfDefinitions` projections.
- `srv/admin-service.js:404-422` (the existing `HomepageConfig` auto-init block) — adds analogous auto-init handlers for `VerbDefinitions` (6 rows) and `ShelfDefinitions` (4 rows).
- `srv/server.js:214-227` (the existing `/build/homepage-shelves` handler) — adds two new sibling handlers immediately below it: `/build/verb-definitions` and `/build/shelf-definitions`. Same try/catch shape; same `Cache-Control: public, max-age=60` header.
- `package.json:62` (the `build:all` chain) — inserts ` && npm run fetch-verb-definitions && npm run fetch-shelf-definitions` after `fetch-homepage-shelves`. Inserts two new script entries in the scripts block: `"fetch-verb-definitions": "tsx scripts/fetch-verb-definitions.ts"` and `"fetch-shelf-definitions": "tsx scripts/fetch-shelf-definitions.ts"`.
- `db/last-dev/csn.json` + `db/src/gen/*.hdbtable` + other staged HDI artifacts — regenerated by `cds build --production`. **Memory: [cds build --production for db/last-dev/]** — schema change requires this; the `check-cds-build-staging` guard fires on any srv/ change.
- `.gitignore` — add `hugo/data/verb_definitions.json` and `hugo/data/shelf_definitions.json` (build artifacts, mirror existing `hugo/data/homepage_shelves.json` line).
- `srv/lib/_classify-rebuild-mode.js` — add two new case branches: `VerbDefinitions` → `'catalog-only'` and `ShelfDefinitions` → `'catalog-only'`. `HomepageShelves` already returns `'catalog-only'`; no change needed for the new fields (whole-entity classification).

### Deleted files

None — pure additive PR.

---

## Decisions made during plan-writing

| # | Question raised by spec | Decision | Rationale |
|---|---|---|---|
| 1 | Where does `AuthoringStatus` enum live? | `db/homepage.cds`, top of file alongside existing `HomepageVerb`/`HomepageShelf`/`HomepageBadge` types | Existing enum convention in the same file; no need for a separate `db/types.cds` until a second consumer outside homepage shows up (YAGNI) |
| 2 | Should `VerbDefinitions` and `ShelfDefinitions` auto-init? | Yes — `srv/admin-service.js` `before('READ', ...)` hooks insert the 6 verb + 4 shelf rows if missing | Matches the `HomepageConfig` / `ChatSettings` pattern; defensive against fresh subaccounts where seed CSV import might lag |
| 3 | Auto-init writes use the seed CSVs as source of truth? | No — auto-init writes labels and icons from a hard-coded fallback constant in `srv/admin-service.js`. CSV is still the canonical seed for fresh DB deploys; auto-init is the runtime fallback. Both must agree | Importing the CSV at runtime adds an fs read + parser dependency for a defensive code path that runs at most once per subaccount lifetime |
| 4 | Should `tagline`/`whyItMatters` be searchable? | No — not added to `@cds.search.term` annotations | YAGNI; can be added later if admin needs full-text filter |
| 5 | Should `/build/verb-definitions` filter inactive rows? | N/A — `VerbDefinitions` and `ShelfDefinitions` have no `isActive` field | Cardinality is fixed (6 + 4); CRUD lockdown (PR 3) prevents disable. If a future need arises, add the field then |
| 6 | Build-fetcher behaviour on 5xx? | Match `fetch-homepage-shelves.ts`: log warning + write empty payload. Spec §5.1 says "fail loud" but the existing precedent is warn-and-continue. | Consistency with the established pattern wins. Spec drift documented in §8 of this plan. |
| 7 | Should PR 1 add the `AICORE_EXPLAINER_GENERATOR_DISABLED` env var or kill-switch? | No — pushed to PR 3 where the AI orchestrator lands | Nothing in PR 1 reads it; adding a no-op env var docs entry in this PR creates a forward reference and CI surface area for code that doesn't exist yet |
| 8 | `whyItMatters` field type — `String(800)` or `LargeString`? | `String(800)` per spec §2.2 — popover readability cap | Spec explicitly chose this in brainstorming Q3 follow-up |

---

## Task 1: Add the `AuthoringStatus` enum type

**Files:**

- Modify: `db/homepage.cds` (after line 22, before the `@assert.unique.verbUrl: [verb, url]` line — group with the other enum types)

- [ ] **Step 1: Read the existing enum types block in `db/homepage.cds`**

Run:

```bash
sed -n '8,22p' db/homepage.cds
```

Expected: see `HomepageVerb`, `HomepageShelf`, `HomepageBadge`, `HomepageLinkStatus` declared as `type X : String enum { ... }`. New enum will follow the same shape immediately after `HomepageLinkStatus`.

- [ ] **Step 2: Write the failing schema-pinning test**

Create `test/unit/db/homepage-schema.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = readFileSync(join(import.meta.dirname, '../../../db/homepage.cds'), 'utf8');

describe('db/homepage.cds — explainer additions (issue #759 PR 1)', () => {
  describe('AuthoringStatus enum', () => {
    it('declares the type with three values', () => {
      expect(SCHEMA).toMatch(/type\s+AuthoringStatus\s*:\s*String\s+enum\s*\{/);
      expect(SCHEMA).toMatch(/BLANK\s*;/);
      expect(SCHEMA).toMatch(/AI_SEEDED\s*;/);
      expect(SCHEMA).toMatch(/REVIEWED\s*;/);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — "declares the type with three values" — regex doesn't match because the type doesn't exist yet.

- [ ] **Step 4: Add the enum type to `db/homepage.cds`**

In `db/homepage.cds`, after the existing `type HomepageLinkStatus` block (line 22) and before the `@assert.unique.verbUrl` annotation (line 24), insert:

```cds
// (#759) Authoring lifecycle for explainer content. AI bulk-fill skips
// REVIEWED rows; per-row regenerate works on all statuses (with confirm
// dialog for REVIEWED). Spec §2.1.
type AuthoringStatus : String enum {
  BLANK;      // never seeded
  AI_SEEDED;  // last write was the AI generator
  REVIEWED;   // human has confirmed; bulk-fill skips
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS — 1 test (AuthoringStatus enum).

- [ ] **Step 6: Commit**

```bash
git add db/homepage.cds test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): add AuthoringStatus enum for explainer authoring lifecycle"
```

---

## Task 2: Add the three new fields to `HomepageShelves`

**Files:**

- Modify: `db/homepage.cds` (existing `HomepageShelves` entity body, lines 25-37)
- Modify: `test/unit/db/homepage-schema.test.js` (extend with a new `describe` block)

- [ ] **Step 1: Extend the failing test with assertions for the new fields**

In `test/unit/db/homepage-schema.test.js`, after the existing `describe('AuthoringStatus enum', ...)` block but inside the top-level `describe`, append:

```js
  describe('HomepageShelves new fields', () => {
    it('declares tagline : String(140) nullable', () => {
      expect(SCHEMA).toMatch(/tagline\s*:\s*String\(140\)\s*;/);
    });
    it('declares whyItMatters : String(800) nullable', () => {
      expect(SCHEMA).toMatch(/whyItMatters\s*:\s*String\(800\)\s*;/);
    });
    it('declares authoringStatus with default BLANK and @assert.range', () => {
      expect(SCHEMA).toMatch(/authoringStatus\s*:\s*AuthoringStatus\s+default\s+'BLANK'\s+@assert\.range\s*;/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — 3 of the new tests in `HomepageShelves new fields`. AuthoringStatus enum test still passes.

- [ ] **Step 3: Add the three new fields to `HomepageShelves`**

In `db/homepage.cds`, edit the `HomepageShelves` entity. Insert these three lines after the existing `linkStatus` field (currently the last field, around line 36):

```cds
  // (#759) Explainer content — see spec §2.4. tagline + whyItMatters
  // fill the popover; description stays as a third paragraph for
  // graceful fallback during phased rollout.
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
```

The final entity body should be (full block for clarity):

```cds
@assert.unique.verbUrl: [verb, url]
entity HomepageShelves : cuid, managed {
  verb        : HomepageVerb       @mandatory @assert.range;
  shelf       : HomepageShelf      @mandatory @assert.range;
  sortOrder   : Integer            default 100;
  title       : String(120)        @mandatory;
  url         : String(500)        @mandatory;
  description : String(280);
  badge       : HomepageBadge      @assert.range;
  isExternal  : Boolean            default true;
  isActive    : Boolean            default true;
  lastChecked : Timestamp;
  linkStatus  : HomepageLinkStatus default 'UNKNOWN' @assert.range;
  // (#759) Explainer content — see spec §2.4.
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS — 4 tests total.

- [ ] **Step 5: Commit**

```bash
git add db/homepage.cds test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): add tagline/whyItMatters/authoringStatus to HomepageShelves"
```

---

## Task 3: Add the `VerbDefinitions` entity

**Files:**

- Modify: `db/homepage.cds` (append after `HomepageShelves` entity)
- Modify: `test/unit/db/homepage-schema.test.js`

- [ ] **Step 1: Extend the failing test**

In `test/unit/db/homepage-schema.test.js`, after the `HomepageShelves new fields` describe block, append:

```js
  describe('VerbDefinitions entity', () => {
    it('declares the entity with verbKey unique constraint', () => {
      expect(SCHEMA).toMatch(/@assert\.unique\.verbKey:\s*\[verbKey\]/);
      expect(SCHEMA).toMatch(/entity\s+VerbDefinitions\s*:\s*cuid,\s*managed\s*\{/);
    });
    it('declares verbKey : HomepageVerb mandatory with @assert.range', () => {
      expect(SCHEMA).toMatch(/verbKey\s*:\s*HomepageVerb\s+@mandatory\s+@assert\.range\s*;/);
    });
    it('declares label : String(40) mandatory', () => {
      expect(SCHEMA).toMatch(/label\s*:\s*String\(40\)\s+@mandatory\s*;/);
    });
    it('declares iconName : String(40)', () => {
      expect(SCHEMA).toMatch(/iconName\s*:\s*String\(40\)\s*;/);
    });
    it('declares sortOrder : Integer default 100', () => {
      expect(SCHEMA).toMatch(/sortOrder\s*:\s*Integer\s+default\s+100\s*;/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — 5 new tests in `VerbDefinitions entity`.

- [ ] **Step 3: Append the `VerbDefinitions` entity to `db/homepage.cds`**

At the very end of `db/homepage.cds` (after the `HomepageConfig` entity), append:

```cds

// (#759) Per-verb explainer content. Cardinality is fixed (6 rows, one
// per HomepageVerb enum value). CRUD lockdown in admin UI prevents
// row creation/deletion; only content fields are mutable. Spec §2.2.
@assert.unique.verbKey: [verbKey]
entity VerbDefinitions : cuid, managed {
  verbKey         : HomepageVerb @mandatory @assert.range;
  label           : String(40)   @mandatory;
  iconName        : String(40);
  sortOrder       : Integer      default 100;
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS — 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add db/homepage.cds test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): add VerbDefinitions entity for per-verb explainer content"
```

---

## Task 4: Add the `ShelfDefinitions` entity

**Files:**

- Modify: `db/homepage.cds`
- Modify: `test/unit/db/homepage-schema.test.js`

- [ ] **Step 1: Extend the failing test**

Append to `test/unit/db/homepage-schema.test.js`:

```js
  describe('ShelfDefinitions entity', () => {
    it('declares the entity with shelfKey unique constraint', () => {
      expect(SCHEMA).toMatch(/@assert\.unique\.shelfKey:\s*\[shelfKey\]/);
      expect(SCHEMA).toMatch(/entity\s+ShelfDefinitions\s*:\s*cuid,\s*managed\s*\{/);
    });
    it('declares shelfKey : HomepageShelf mandatory with @assert.range', () => {
      expect(SCHEMA).toMatch(/shelfKey\s*:\s*HomepageShelf\s+@mandatory\s+@assert\.range\s*;/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — 2 new tests in `ShelfDefinitions entity`.

- [ ] **Step 3: Append the `ShelfDefinitions` entity to `db/homepage.cds`**

At the end of `db/homepage.cds`, append:

```cds

// (#759) Per-shelf-category explainer content. Cardinality is fixed
// (4 rows, one per HomepageShelf enum value). Content is shared across
// all 6 verb sub-pages — REFERENCE means the same thing on /learn/ and
// /operate/. Spec §2.3.
@assert.unique.shelfKey: [shelfKey]
entity ShelfDefinitions : cuid, managed {
  shelfKey        : HomepageShelf @mandatory @assert.range;
  label           : String(40)    @mandatory;
  sortOrder       : Integer       default 100;
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS — 11 tests total.

- [ ] **Step 5: Commit**

```bash
git add db/homepage.cds test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): add ShelfDefinitions entity for per-shelf-category explainer content"
```

---

## Task 5: Stage HDI artifacts with `cds build --production`

**Files:**

- Modify: `db/last-dev/csn.json` and other staged HDI artifacts under `db/src/` and `db/last-dev/` — regenerated by the build command, not hand-edited.

**Background.** Per memory [cds build --production for db/last-dev/] and [Plans for schema changes need cds build step]: every `db/*.cds` change requires running `cds build --production` and committing the regenerated artifacts. The `check-cds-build-staging` guard fires on any srv/ change.

- [ ] **Step 1: Run `cds build --production`**

Run:

```bash
npx cds build --production
```

Expected: completes without errors. Watch for any "missing reference" or "unresolved type" output — those indicate a typo in the .cds file.

- [ ] **Step 2: Stage the regenerated HDI artifacts**

Run:

```bash
git status --short db/last-dev/ db/src/
```

Expected: shows modifications under `db/last-dev/csn.json` (the canonical CSN snapshot) and likely new `.hdbtable` / `.hdbview` files under `db/src/gen/`.

- [ ] **Step 3: Verify the staged CSN reflects all three new entity additions**

Run:

```bash
node -e "
const csn = JSON.parse(require('fs').readFileSync('db/last-dev/csn.json','utf8'));
const defs = csn.definitions || {};
const checks = [
  ['com.sap.developers.ims.VerbDefinitions', 'VerbDefinitions entity'],
  ['com.sap.developers.ims.ShelfDefinitions', 'ShelfDefinitions entity'],
  ['com.sap.developers.ims.AuthoringStatus', 'AuthoringStatus type'],
];
checks.forEach(([k,desc]) => {
  console.log(defs[k] ? 'OK  ' : 'MISS', desc, '—', k);
});
const shelves = defs['com.sap.developers.ims.HomepageShelves'];
const newFields = ['tagline','whyItMatters','authoringStatus'];
newFields.forEach(f => {
  console.log(shelves?.elements?.[f] ? 'OK  ' : 'MISS', 'HomepageShelves.'+f);
});
"
```

Expected: 6 lines, all starting with `OK`. If any show `MISS`, the .cds change didn't make it into the staged CSN — re-run `cds build --production`.

- [ ] **Step 4: Stage and commit**

```bash
git add db/last-dev/ db/src/
git -c core.autocrlf=false commit -m "build(#759): regenerate HDI staging for new entities and fields

Runs cds build --production after the three .cds changes in
db/homepage.cds (Tasks 1-4 of PR 1):
- new AuthoringStatus enum type
- new tagline/whyItMatters/authoringStatus fields on HomepageShelves
- new VerbDefinitions entity (6 rows when seeded)
- new ShelfDefinitions entity (4 rows when seeded)

Required by check-cds-build-staging guard. Pure additive migration —
no destructive ALTER, no data loss."
```

---

## Task 6: Seed CSV for `VerbDefinitions`

**Files:**

- Create: `db/data/com.sap.developers.ims-VerbDefinitions.csv`
- Modify: `test/unit/db/homepage-schema.test.js`

**Background.** The seed CSV is the canonical source of truth for fresh DB deploys. Values must match the hard-coded `$verbDefs` slice in `hugo/layouts/partials/homepage/verb-spine.html:6-13`. Content fields (`tagline`, `whyItMatters`) ship blank — the AI bulk-fill in PR 3 seeds them.

UUIDs are stable (sequential, deterministic) following the same convention as `db/data/com.sap.developers.ims-Categories.csv`. For verbs we use namespace `66333900-0759-0001-0001-00000000000X` (read: issue 759, file 0001, X = verb ordinal).

- [ ] **Step 1: Write the failing seed-content test**

Append to `test/unit/db/homepage-schema.test.js`:

```js
  describe('VerbDefinitions seed CSV', () => {
    const csv = readFileSync(
      join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-VerbDefinitions.csv'),
      'utf8'
    );
    const lines = csv.trim().split(/\r?\n/);
    it('has header + 6 rows', () => {
      expect(lines.length).toBe(7);
    });
    it('header uses ID;verbKey;label;iconName;sortOrder;tagline;whyItMatters;authoringStatus', () => {
      expect(lines[0]).toBe('ID;verbKey;label;iconName;sortOrder;tagline;whyItMatters;authoringStatus');
    });
    it.each([
      ['LEARN', 'Learn', 'learning-assistant', 10],
      ['BUILD', 'Build', 'developer-settings', 20],
      ['INTEGRATE', 'Integrate', 'chain-link', 30],
      ['OPERATE', 'Operate', 'settings', 40],
      ['AI', 'Extend with AI', 'da', 50],
      ['CONNECT', 'Connect', 'customer-and-contacts', 60],
    ])('row for %s has correct label + icon + sortOrder', (verbKey, label, icon, sort) => {
      const row = lines.find(l => l.includes(`;${verbKey};`));
      expect(row).toBeDefined();
      expect(row).toContain(`;${verbKey};${label};${icon};${sort};`);
    });
    it('every row has authoringStatus=BLANK and empty tagline/whyItMatters', () => {
      lines.slice(1).forEach(line => {
        expect(line).toMatch(/;;;BLANK$/);
      });
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — file doesn't exist yet → `ENOENT`.

- [ ] **Step 3: Create the seed CSV**

Create `db/data/com.sap.developers.ims-VerbDefinitions.csv` with **CRLF line endings** (matches other seed CSVs in `db/data/` — per memory [CRLF Regression on Windows], be explicit):

```text
ID;verbKey;label;iconName;sortOrder;tagline;whyItMatters;authoringStatus
66333900-0759-0001-0001-000000000001;LEARN;Learn;learning-assistant;10;;;BLANK
66333900-0759-0001-0001-000000000002;BUILD;Build;developer-settings;20;;;BLANK
66333900-0759-0001-0001-000000000003;INTEGRATE;Integrate;chain-link;30;;;BLANK
66333900-0759-0001-0001-000000000004;OPERATE;Operate;settings;40;;;BLANK
66333900-0759-0001-0001-000000000005;AI;Extend with AI;da;50;;;BLANK
66333900-0759-0001-0001-000000000006;CONNECT;Connect;customer-and-contacts;60;;;BLANK
```

Verify the line endings after writing:

```bash
file db/data/com.sap.developers.ims-VerbDefinitions.csv
```

Expected: `ASCII text, with CRLF line terminators`. If `LF`, run `unix2dos db/data/com.sap.developers.ims-VerbDefinitions.csv`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS — all schema + CSV tests pass.

- [ ] **Step 5: Commit**

```bash
git add db/data/com.sap.developers.ims-VerbDefinitions.csv test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): seed CSV for VerbDefinitions with 6 rows"
```

---

## Task 7: Seed CSV for `ShelfDefinitions`

**Files:**

- Create: `db/data/com.sap.developers.ims-ShelfDefinitions.csv`
- Modify: `test/unit/db/homepage-schema.test.js`

**Background.** Labels match the hard-coded dict in `hugo/layouts/verb/list.html:17`. UUID namespace: `66333900-0759-0002-0001-00000000000X`.

- [ ] **Step 1: Write the failing seed-content test**

Append to `test/unit/db/homepage-schema.test.js`:

```js
  describe('ShelfDefinitions seed CSV', () => {
    const csv = readFileSync(
      join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-ShelfDefinitions.csv'),
      'utf8'
    );
    const lines = csv.trim().split(/\r?\n/);
    it('has header + 4 rows', () => {
      expect(lines.length).toBe(5);
    });
    it('header uses ID;shelfKey;label;sortOrder;tagline;whyItMatters;authoringStatus', () => {
      expect(lines[0]).toBe('ID;shelfKey;label;sortOrder;tagline;whyItMatters;authoringStatus');
    });
    it.each([
      ['START_HERE', 'Start here', 10],
      ['REFERENCE', 'Reference', 20],
      ['TOOLS', 'Tools & samples', 30],
      ['KEEP_CURRENT', 'Keep current', 40],
    ])('row for %s has correct label + sortOrder', (shelfKey, label, sort) => {
      const row = lines.find(l => l.includes(`;${shelfKey};`));
      expect(row).toBeDefined();
      expect(row).toContain(`;${shelfKey};${label};${sort};`);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Create the seed CSV**

Create `db/data/com.sap.developers.ims-ShelfDefinitions.csv` with **CRLF line endings**:

```text
ID;shelfKey;label;sortOrder;tagline;whyItMatters;authoringStatus
66333900-0759-0002-0001-000000000001;START_HERE;Start here;10;;;BLANK
66333900-0759-0002-0001-000000000002;REFERENCE;Reference;20;;;BLANK
66333900-0759-0002-0001-000000000003;TOOLS;Tools & samples;30;;;BLANK
66333900-0759-0002-0001-000000000004;KEEP_CURRENT;Keep current;40;;;BLANK
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/db/homepage-schema.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/data/com.sap.developers.ims-ShelfDefinitions.csv test/unit/db/homepage-schema.test.js
git -c core.autocrlf=false commit -m "feat(#759): seed CSV for ShelfDefinitions with 4 rows"
```

---

## Task 8: Expose new entities on AdminService

**Files:**

- Modify: `srv/admin-service.cds` (insert after the existing `HomepageConfig` projection, currently around line 164)
- Create: `test/unit/srv/admin-service-explainer-projections.test.js`

**Background.** Per spec §3.1, both new entities expose on `AdminService` with `@odata.draft.enabled` for the Fiori Elements draft editing experience. CRUD lockdown lives in PR 3's admin app annotations — not in the projection.

- [ ] **Step 1: Read the existing homepage projection block**

```bash
sed -n '148,167p' srv/admin-service.cds
```

Expected: see `HomepageShelves`, `LegacyRedirects`, `HomepageConfig` projections in that order.

- [ ] **Step 2: Write the failing test**

Create `test/unit/srv/admin-service-explainer-projections.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer projections (issue #759 PR 1)', () => {
  it('exposes VerbDefinitions with @odata.draft.enabled', () => {
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+VerbDefinitions\s+as\s+projection\s+on\s+ims\.VerbDefinitions\s*;/);
  });
  it('exposes ShelfDefinitions with @odata.draft.enabled', () => {
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+ShelfDefinitions\s+as\s+projection\s+on\s+ims\.ShelfDefinitions\s*;/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/unit/srv/admin-service-explainer-projections.test.js
```

Expected: FAIL — both regex misses.

- [ ] **Step 4: Add the two projections**

In `srv/admin-service.cds`, after the existing `entity HomepageConfig as projection on ims.HomepageConfig;` line, insert. **Verify the insertion point is inside the same `service { ... }` block** — a stray `}` between `HomepageConfig` and end-of-service would silently push the new projections out of the service. Sanity-check by running `grep -n '^service\|^}' srv/admin-service.cds | tail -10` after editing.

```cds

  // (#759) Per-verb and per-shelf explainer content. Both have fixed
  // cardinality (6 verbs / 4 shelves); CRUD lockdown lives in the
  // Fiori admin app annotations (PR 3). Projection itself is
  // unconstrained — same shape as HomepageConfig.
  @odata.draft.enabled
  entity VerbDefinitions as projection on ims.VerbDefinitions;

  @odata.draft.enabled
  entity ShelfDefinitions as projection on ims.ShelfDefinitions;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/unit/srv/admin-service-explainer-projections.test.js
```

Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds test/unit/srv/admin-service-explainer-projections.test.js
git -c core.autocrlf=false commit -m "feat(#759): expose VerbDefinitions and ShelfDefinitions on AdminService"
```

---

## Task 9: Auto-init handlers for the two singleton-set entities

**Files:**

- Modify: `srv/admin-service.js` (insert after the existing `HomepageConfig` auto-init block at line 410-422)
- Create: `test/unit/srv/admin-service-explainer-autoinit.test.js`
- Create: `test/hybrid/verb-definitions-crud.test.js`
- Create: `test/hybrid/shelf-definitions-crud.test.js`

**Background.** Per Decision 2 in this plan, the seed CSV is canonical for fresh deploys, but defensive auto-init (matching `HomepageConfig` and `ChatSettings`) inserts the rows on first READ if missing — covers fresh subaccounts where seed CSV import lags. Per Decision 3, auto-init writes use hard-coded fallback constants. **Both must agree** with the seed CSVs.

- [ ] **Step 1: Read the existing `HomepageConfig` auto-init handler as template**

```bash
sed -n '404,425p' srv/admin-service.js
```

Expected: see `before('READ', 'HomepageConfig', async () => { ... })` that auto-creates the singleton.

- [ ] **Step 2: Write the failing unit test (SQLite path)**

Create `test/unit/srv/admin-service-explainer-autoinit.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AdminService — VerbDefinitions/ShelfDefinitions auto-init (#759 PR 1)', () => {
  beforeAll(async () => {
    cds.test(import.meta.dirname + '/../../../');
  });

  it('auto-creates 6 VerbDefinitions rows when reading an empty table', async () => {
    const admin = await cds.connect.to('AdminService');
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    const rows = await admin.run(SELECT.from('AdminService.VerbDefinitions'));
    expect(rows.length).toBe(6);
    const keys = rows.map(r => r.verbKey).sort();
    expect(keys).toEqual(['AI', 'BUILD', 'CONNECT', 'INTEGRATE', 'LEARN', 'OPERATE']);
    expect(rows.every(r => r.authoringStatus === 'BLANK')).toBe(true);
  });

  it('auto-creates 4 ShelfDefinitions rows when reading an empty table', async () => {
    const admin = await cds.connect.to('AdminService');
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    const rows = await admin.run(SELECT.from('AdminService.ShelfDefinitions'));
    expect(rows.length).toBe(4);
    const keys = rows.map(r => r.shelfKey).sort();
    expect(keys).toEqual(['KEEP_CURRENT', 'REFERENCE', 'START_HERE', 'TOOLS']);
  });

  it('idempotent — second read does not duplicate', async () => {
    const admin = await cds.connect.to('AdminService');
    await admin.run(SELECT.from('AdminService.VerbDefinitions'));
    await admin.run(SELECT.from('AdminService.VerbDefinitions'));
    const db = await cds.connect.to('db');
    const count = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions').columns('count(*) as n'));
    expect(count[0].n).toBe(6);
  });
});
```

- [ ] **Step 3: Run unit test to verify it fails**

```bash
npx vitest run test/unit/srv/admin-service-explainer-autoinit.test.js
```

Expected: FAIL — auto-init handlers don't exist yet; rows stay at 0 after DELETE.

- [ ] **Step 4: Add the auto-init handlers**

In `srv/admin-service.js`, after the closing of the `HomepageConfig` auto-init (around line 422), insert:

```js
    // #759: VerbDefinitions auto-init. Cardinality is exactly 6 — one
    // per HomepageVerb enum value. Seed CSV in
    // db/data/com.sap.developers.ims-VerbDefinitions.csv is canonical;
    // this handler is the defensive runtime fallback (matches
    // HomepageConfig pattern above). Values MUST agree with the CSV.
    const VERB_DEFAULTS = [
      { verbKey: 'LEARN',     label: 'Learn',          iconName: 'learning-assistant',    sortOrder: 10 },
      { verbKey: 'BUILD',     label: 'Build',          iconName: 'developer-settings',    sortOrder: 20 },
      { verbKey: 'INTEGRATE', label: 'Integrate',      iconName: 'chain-link',            sortOrder: 30 },
      { verbKey: 'OPERATE',   label: 'Operate',        iconName: 'settings',              sortOrder: 40 },
      { verbKey: 'AI',        label: 'Extend with AI', iconName: 'da',                    sortOrder: 50 },
      { verbKey: 'CONNECT',   label: 'Connect',        iconName: 'customer-and-contacts', sortOrder: 60 },
    ];
    this.before('READ', 'VerbDefinitions', async () => {
      const existing = await SELECT.from('com.sap.developers.ims.VerbDefinitions').columns('verbKey');
      if (existing.length >= 6) return;
      const have = new Set(existing.map(r => r.verbKey));
      const missing = VERB_DEFAULTS
        .filter(d => !have.has(d.verbKey))
        .map(d => ({ ...d, authoringStatus: 'BLANK' }));
      if (missing.length > 0) {
        await INSERT.into('com.sap.developers.ims.VerbDefinitions').entries(missing);
      }
    });

    // #759: ShelfDefinitions auto-init. Cardinality is exactly 4.
    // Same pattern as VerbDefinitions. Values MUST agree with
    // db/data/com.sap.developers.ims-ShelfDefinitions.csv.
    const SHELF_DEFAULTS = [
      { shelfKey: 'START_HERE',   label: 'Start here',      sortOrder: 10 },
      { shelfKey: 'REFERENCE',    label: 'Reference',       sortOrder: 20 },
      { shelfKey: 'TOOLS',        label: 'Tools & samples', sortOrder: 30 },
      { shelfKey: 'KEEP_CURRENT', label: 'Keep current',    sortOrder: 40 },
    ];
    this.before('READ', 'ShelfDefinitions', async () => {
      const existing = await SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('shelfKey');
      if (existing.length >= 4) return;
      const have = new Set(existing.map(r => r.shelfKey));
      const missing = SHELF_DEFAULTS
        .filter(d => !have.has(d.shelfKey))
        .map(d => ({ ...d, authoringStatus: 'BLANK' }));
      if (missing.length > 0) {
        await INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries(missing);
      }
    });
```

- [ ] **Step 5: Run unit test to verify it passes**

```bash
npx vitest run test/unit/srv/admin-service-explainer-autoinit.test.js
```

Expected: PASS — 3 tests.

- [ ] **Step 6: Write the hybrid tests (HANA path)**

Create `test/hybrid/verb-definitions-crud.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { guardWrites } from './_guard.js';

guardWrites();

describe('VerbDefinitions — admin CRUD on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('AdminService.VerbDefinitions returns 6 rows after auto-init', async () => {
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.run(SELECT.from('AdminService.VerbDefinitions'));
    expect(rows.length).toBe(6);
  });

  it('all 6 enum values are represented exactly once', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions'));
    const keys = rows.map(r => r.verbKey).sort();
    expect(keys).toEqual(['AI', 'BUILD', 'CONNECT', 'INTEGRATE', 'LEARN', 'OPERATE']);
  });

  it('@assert.unique.verbKey rejects duplicate insert', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries({
        verbKey: 'LEARN',
        label: '__TEST__ duplicate',
      }))
    ).rejects.toThrow();
  });

  it('@assert.range rejects invalid verbKey value', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries({
        verbKey: 'BOGUS_VALUE',
        label: '__TEST__ bogus',
      }))
    ).rejects.toThrow();
  });
});
```

Create `test/hybrid/shelf-definitions-crud.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { guardWrites } from './_guard.js';

guardWrites();

describe('ShelfDefinitions — admin CRUD on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('AdminService.ShelfDefinitions returns 4 rows after auto-init', async () => {
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.run(SELECT.from('AdminService.ShelfDefinitions'));
    expect(rows.length).toBe(4);
  });

  it('all 4 enum values are represented exactly once', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions'));
    const keys = rows.map(r => r.shelfKey).sort();
    expect(keys).toEqual(['KEEP_CURRENT', 'REFERENCE', 'START_HERE', 'TOOLS']);
  });

  it('@assert.unique.shelfKey rejects duplicate insert', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries({
        shelfKey: 'START_HERE',
        label: '__TEST__ duplicate',
      }))
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run the hybrid tests (requires `cf login` to DEV)**

```bash
npm run test:hybrid -- verb-definitions-crud shelf-definitions-crud
```

Expected: PASS — 7 tests across both files. If they fail with "table not found", `npx cds deploy --to hana` first to push the new schema.

- [ ] **Step 8: Commit**

```bash
git add srv/admin-service.js test/unit/srv/admin-service-explainer-autoinit.test.js test/hybrid/verb-definitions-crud.test.js test/hybrid/shelf-definitions-crud.test.js
git -c core.autocrlf=false commit -m "feat(#759): auto-init handlers for VerbDefinitions and ShelfDefinitions

Matches the existing HomepageConfig auto-init pattern. Inserts the 6
verb rows / 4 shelf rows on first READ when the table is empty.
Defensive against fresh subaccounts where seed CSV import may lag.
Idempotent — subsequent reads no-op if rows exist.

Unit test exercises the SQLite path (default npm test); hybrid tests
gate on cf login to DEV."
```

---

## Task 10: Hybrid test for new `HomepageShelves` fields

**Files:**

- Create: `test/hybrid/homepage-shelves-new-fields.test.js`

**Background.** The unit-side schema pinning (Tasks 1-4) verifies the .cds source. This hybrid test verifies the columns actually exist on HANA after `cds deploy` and that the defaults + status transitions work end-to-end.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/homepage-shelves-new-fields.test.js`:

```js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';
import { guardWrites } from './_guard.js';

guardWrites();

const TEST_TITLE_PREFIX = '__TEST__759_';

describe('HomepageShelves new fields on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  afterEach(async () => {
    await db.run(
      DELETE.from('com.sap.developers.ims.HomepageShelves')
        .where("title LIKE '" + TEST_TITLE_PREFIX + "%'")
    );
  });

  it('authoringStatus defaults to BLANK when omitted', async () => {
    const id = await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'LEARN', shelf: 'START_HERE',
      title: TEST_TITLE_PREFIX + 'default-status',
      url: 'https://example.com/759-test-1',
      sortOrder: 999,
    }));
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'default-status' }));
    expect(row.authoringStatus).toBe('BLANK');
    expect(row.tagline).toBeNull();
    expect(row.whyItMatters).toBeNull();
  });

  it('accepts tagline up to 140 chars and rejects 141', async () => {
    const ok140 = 'x'.repeat(140);
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'BUILD', shelf: 'REFERENCE',
      title: TEST_TITLE_PREFIX + 'tagline-140',
      url: 'https://example.com/759-test-2',
      tagline: ok140,
    }));
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'tagline-140' }));
    expect(row.tagline?.length).toBe(140);
  });

  it('@assert.range rejects bogus authoringStatus', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
        verb: 'AI', shelf: 'TOOLS',
        title: TEST_TITLE_PREFIX + 'bad-status',
        url: 'https://example.com/759-test-3',
        authoringStatus: 'NOPE',
      }))
    ).rejects.toThrow();
  });

  it('status transition BLANK → AI_SEEDED → REVIEWED persists', async () => {
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'CONNECT', shelf: 'KEEP_CURRENT',
      title: TEST_TITLE_PREFIX + 'transitions',
      url: 'https://example.com/759-test-4',
    }));
    await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
      .set({ authoringStatus: 'AI_SEEDED', tagline: 'auto-tagline' })
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    let row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    expect(row.authoringStatus).toBe('AI_SEEDED');
    expect(row.tagline).toBe('auto-tagline');

    await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
      .set({ authoringStatus: 'REVIEWED' })
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    expect(row.authoringStatus).toBe('REVIEWED');
  });
});
```

- [ ] **Step 2: Run the hybrid test**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- homepage-shelves-new-fields
```

Expected: PASS — 4 tests. (`ALLOW_HYBRID_WRITES=true` per the test/hybrid/_guard.js convention — this test writes test rows that it cleans up afterEach.)

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/homepage-shelves-new-fields.test.js
git -c core.autocrlf=false commit -m "test(#759): hybrid test for new HomepageShelves fields on HANA

Verifies the three new columns (tagline, whyItMatters, authoringStatus)
deploy correctly to HANA via cds deploy, that authoringStatus defaults
to BLANK, that String(140) cap holds, and that the BLANK -> AI_SEEDED
-> REVIEWED transition persists. Uses __TEST__759_ prefix and afterEach
cleanup per the project's hybrid test discipline."
```

---

## Task 11: Build-feed endpoint `/build/verb-definitions`

**Files:**

- Modify: `srv/server.js` (insert new route handler after the existing `/build/homepage-shelves` block at lines 214-227)
- Create: `test/unit/srv/build-feeds-explainers.test.js`

**Background.** Per spec §3.2, mirrors the existing `/build/homepage-shelves` pattern (unauthenticated, 60s Cache-Control, structured `{ verbs: [...], buildAt }` payload).

- [ ] **Step 1: Read the existing handler as template**

```bash
sed -n '212,229p' srv/server.js
```

Expected: see the `/build/homepage-shelves` handler with try/catch, `Cache-Control: public, max-age=60`, `SELECT.from(...).where({ isActive: true }).orderBy(...)`, error JSON-payload on 500.

- [ ] **Step 2: Write the failing unit test**

Create `test/unit/srv/build-feeds-explainers.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import request from 'supertest';

describe('/build/verb-definitions + /build/shelf-definitions (#759 PR 1)', () => {
  let app;
  beforeAll(async () => {
    const test = cds.test(import.meta.dirname + '/../../../');
    await test;
    app = test.app;
  });

  describe('/build/verb-definitions', () => {
    it('returns 200 with verbs array', async () => {
      const res = await request(app).get('/build/verb-definitions');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.verbs)).toBe(true);
    });

    it('returns 6 rows after auto-init', async () => {
      const res = await request(app).get('/build/verb-definitions');
      expect(res.body.verbs.length).toBe(6);
    });

    it('sets 60s Cache-Control header', async () => {
      const res = await request(app).get('/build/verb-definitions');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('orders by sortOrder ascending', async () => {
      const res = await request(app).get('/build/verb-definitions');
      const sortOrders = res.body.verbs.map(v => v.sortOrder);
      expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
    });

    it('includes new fields tagline, whyItMatters, authoringStatus', async () => {
      const res = await request(app).get('/build/verb-definitions');
      const row = res.body.verbs[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
      expect(row.authoringStatus).toBe('BLANK');
    });

    it('returns buildAt ISO timestamp', async () => {
      const res = await request(app).get('/build/verb-definitions');
      expect(res.body.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('/build/shelf-definitions', () => {
    it('returns 200 with shelves array of 4', async () => {
      const res = await request(app).get('/build/shelf-definitions');
      expect(res.status).toBe(200);
      expect(res.body.shelves.length).toBe(4);
    });

    it('sets 60s Cache-Control header', async () => {
      const res = await request(app).get('/build/shelf-definitions');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('includes new fields tagline, whyItMatters, authoringStatus', async () => {
      const res = await request(app).get('/build/shelf-definitions');
      const row = res.body.shelves[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
    });
  });

  describe('/build/homepage-shelves extended payload', () => {
    it('row includes the three new fields (#759)', async () => {
      const res = await request(app).get('/build/homepage-shelves');
      expect(res.status).toBe(200);
      // Auto-init doesn't seed HomepageShelves; if no rows, the assertion
      // is moot. Skip in that case.
      if (res.body.shelves.length === 0) return;
      const row = res.body.shelves[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/unit/srv/build-feeds-explainers.test.js
```

Expected: FAIL — all 11 tests fail with 404 because the routes don't exist yet.

- [ ] **Step 4: Add the two route handlers**

In `srv/server.js`, after the closing `});` of the `/build/homepage-shelves` block (around line 227), insert:

```js
  // (#759) Build-time data for the homepage explainer popovers. Mirrors
  // /build/homepage-shelves above — unauthenticated, 60s Cache-Control,
  // structured payload. Consumed by scripts/fetch-verb-definitions.ts
  // and scripts/fetch-shelf-definitions.ts at build time.
  app.get('/build/verb-definitions', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from('com.sap.developers.ims.VerbDefinitions').orderBy('sortOrder')
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ verbs: rows, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/verb-definitions]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/build/shelf-definitions', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from('com.sap.developers.ims.ShelfDefinitions').orderBy('sortOrder')
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ shelves: rows, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/shelf-definitions]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/unit/srv/build-feeds-explainers.test.js
```

Expected: PASS — 11 tests (10 explainer + 1 extended-homepage-shelves).

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/unit/srv/build-feeds-explainers.test.js
git -c core.autocrlf=false commit -m "feat(#759): /build/verb-definitions and /build/shelf-definitions endpoints

Unauthenticated build-feed routes returning all VerbDefinitions /
ShelfDefinitions rows ordered by sortOrder. 60s Cache-Control matches
the existing /build/homepage-shelves pattern. Consumed by the two
new fetcher scripts (next task) and baked into hugo/data/*.json at
build time."
```

---

## Task 12: Fetcher scripts for the two new feeds

**Files:**

- Create: `scripts/fetch-verb-definitions.ts`
- Create: `scripts/fetch-shelf-definitions.ts`

**Background.** Per spec §5.1 and Decision 6 of this plan, the new fetchers follow `scripts/fetch-homepage-shelves.ts` exactly — warn-and-continue on error rather than fail-loud, for consistency with the established precedent.

- [ ] **Step 1: Read the existing fetcher as the template**

```bash
cat scripts/fetch-homepage-shelves.ts
```

Expected: see the 22-line script with `CAP_BASE`, `OUT_PATH`, `main()` that fetches + writes JSON + warns on error.

- [ ] **Step 2: Create `scripts/fetch-verb-definitions.ts`**

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'verb_definitions.json');

async function main() {
  let payload = { verbs: [], buildAt: new Date().toISOString(), error: null as string | null };
  try {
    const res = await fetch(`${CAP_BASE}/build/verb-definitions`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    payload = await res.json();
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-verb-definitions] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-verb-definitions] wrote ${payload.verbs?.length ?? 0} verbs to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Create `scripts/fetch-shelf-definitions.ts`**

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'shelf_definitions.json');

async function main() {
  let payload = { shelves: [], buildAt: new Date().toISOString(), error: null as string | null };
  try {
    const res = await fetch(`${CAP_BASE}/build/shelf-definitions`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    payload = await res.json();
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-shelf-definitions] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-shelf-definitions] wrote ${payload.shelves?.length ?? 0} shelves to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Smoke-run both scripts (requires local CAP running on :4004)**

If you have local CAP running (`cds watch` in another terminal):

```bash
npx tsx scripts/fetch-verb-definitions.ts
npx tsx scripts/fetch-shelf-definitions.ts
```

Expected:

```text
[fetch-verb-definitions] wrote 6 verbs to hugo/data/verb_definitions.json
[fetch-shelf-definitions] wrote 4 shelves to hugo/data/shelf_definitions.json
```

If CAP is not running, both should still exit 0 with a WARN about connection refused, writing empty-payload files. That is the intended graceful-degradation behavior.

- [ ] **Step 5: Verify the generated JSON shape**

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('hugo/data/verb_definitions.json','utf8')), null, 2))" | head -20
```

Expected: `{ "verbs": [...6 rows...], "buildAt": "...", "error": null }`.

- [ ] **Step 6: Commit (do not commit the generated JSON — gitignored next task)**

```bash
git add scripts/fetch-verb-definitions.ts scripts/fetch-shelf-definitions.ts
git -c core.autocrlf=false commit -m "feat(#759): fetcher scripts for verb_definitions and shelf_definitions

Mirror the existing scripts/fetch-homepage-shelves.ts shape. Warn and
continue on error (consistent with the precedent — see plan Decision 6)
rather than fail-loud as the spec originally suggested.

Each writes hugo/data/<name>.json which Hugo reads as Site.Data.<name>
in the templates that PR 2 will update."
```

---

## Task 13: Wire the fetchers into `build:all`

**Files:**

- Modify: `package.json` (scripts block)
- Modify: `.gitignore`

- [ ] **Step 1: Read the current `build:all` chain**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts['build:all'])"
```

Expected: a long `&&`-chained command. Note the position of `fetch-homepage-shelves` — the two new fetchers go immediately after it.

- [ ] **Step 2: Add the two new script entries and update `build:all`**

Edit `package.json`. In the `scripts` block, add (after the existing `fetch-homepage-shelves` entry around line 16):

```json
    "fetch-verb-definitions": "tsx scripts/fetch-verb-definitions.ts",
    "fetch-shelf-definitions": "tsx scripts/fetch-shelf-definitions.ts",
```

And in the `build:all` value (around line 62), find `&& npm run fetch-homepage-shelves` and replace with:

```text
&& npm run fetch-homepage-shelves && npm run fetch-verb-definitions && npm run fetch-shelf-definitions
```

- [ ] **Step 3: Verify the JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('OK')"
```

Expected: `OK`. If parse error, fix the comma/quote.

- [ ] **Step 4: Add the two generated files to `.gitignore`**

Find the line containing `hugo/data/homepage_shelves.json` in `.gitignore`. Add immediately below:

```text
hugo/data/verb_definitions.json
hugo/data/shelf_definitions.json
```

If `hugo/data/homepage_shelves.json` is itself not yet in `.gitignore` (it should be — confirm with `grep homepage_shelves .gitignore`), then add all three together.

- [ ] **Step 5: Verify gitignore takes effect**

```bash
git check-ignore -v hugo/data/verb_definitions.json hugo/data/shelf_definitions.json
```

Expected: each prints a `.gitignore:NN:<pattern>` line, confirming the file is ignored.

- [ ] **Step 6: Smoke-test the fetch chain locally**

If local CAP is running:

```bash
npm run fetch-verb-definitions && npm run fetch-shelf-definitions
```

Expected: both succeed with the JSON line counts. `git status hugo/data/` shows untracked changes only for these two files (which are gitignored, so they shouldn't show at all — `git status --short` should be quiet about them).

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore
git -c core.autocrlf=false commit -m "build(#759): wire new fetchers into build:all + gitignore generated JSON

Inserts fetch-verb-definitions and fetch-shelf-definitions immediately
after fetch-homepage-shelves in the build:all chain. The generated
hugo/data/verb_definitions.json and hugo/data/shelf_definitions.json
are gitignored as build artifacts (mirrors homepage_shelves.json)."
```

---

## Task 14: Smoke test for the two new build feeds

**Files:**

- Create: `test/smoke/build-feeds-explainers.smoke.test.js`

**Background.** Per spec §6, this verifies the deployed srv actually serves these routes. Runs in CI as part of `npm run test:smoke` against the deployed approuter + srv URLs (env vars `SMOKE_BASE_URL` and `SMOKE_SRV_URL`).

- [ ] **Step 1: Read an existing smoke test as the template**

```bash
ls test/smoke/ | head && echo '---' && head -30 test/smoke/build-feeds.test.js 2>/dev/null || head -30 test/smoke/public-endpoints.test.js
```

Expected: see the imports + the `SMOKE_SRV_URL` env-var pattern + a `fetch(...)` call + status/body assertions.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/build-feeds-explainers.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
if (!SRV) throw new Error('SMOKE_SRV_URL not set — smoke tests need a deployed srv URL');

describe('Smoke — build feeds for homepage explainers (#759 PR 1)', () => {
  describe('/build/verb-definitions', () => {
    it('returns 200 with 6 verbs', async () => {
      const res = await fetch(`${SRV}/build/verb-definitions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.verbs)).toBe(true);
      expect(body.verbs.length).toBe(6);
    });

    it('sets 60s Cache-Control', async () => {
      const res = await fetch(`${SRV}/build/verb-definitions`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    });
  });

  describe('/build/shelf-definitions', () => {
    it('returns 200 with 4 shelves', async () => {
      const res = await fetch(`${SRV}/build/shelf-definitions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shelves.length).toBe(4);
    });
  });

  describe('/build/homepage-shelves — extended payload (#759)', () => {
    it('rows include tagline/whyItMatters/authoringStatus fields', async () => {
      const res = await fetch(`${SRV}/build/homepage-shelves`);
      expect(res.status).toBe(200);
      const body = await res.json();
      if (body.shelves.length === 0) return; // no rows in this env
      const row = body.shelves[0];
      // Field can be null but property must exist after JSON serialisation
      expect('tagline' in row).toBe(true);
      expect('whyItMatters' in row).toBe(true);
      expect('authoringStatus' in row).toBe(true);
    });
  });
});
```

- [ ] **Step 3: Run the smoke test (requires deployed srv URL)**

After PR 1 is deployed to DEV:

```bash
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run --config test/smoke/vitest.config.js build-feeds-explainers
```

Expected: PASS — 4 tests.

If running before deploy, this will fail with connection-refused — that's fine; the test gets exercised post-deploy in CI per the existing smoke pattern.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/build-feeds-explainers.smoke.test.js
git -c core.autocrlf=false commit -m "test(#759): smoke test for new build feeds + extended HomepageShelves payload

Asserts /build/verb-definitions returns 6 rows, /build/shelf-definitions
returns 4, both 200 with 60s Cache-Control, and that /build/homepage-shelves
now includes the three new fields (tagline, whyItMatters, authoringStatus)
in each row. Runs against SMOKE_SRV_URL post-deploy."
```

---

## Task 15: Update rebuild-mode classifier

**Files:**

- Modify: `srv/lib/_classify-rebuild-mode.js`

**Background.** Per spec §5.2 and memory [check-cds-build-staging fires on ANY srv/ change]: admin writes to `VerbDefinitions` and `ShelfDefinitions` need to trigger the same 60s-debounced `rebuild-content.yml` workflow (catalog-only mode) that `HomepageShelves` writes do. The classifier is where this mapping lives.

- [ ] **Step 1: Read the existing classifier**

```bash
cat srv/lib/_classify-rebuild-mode.js
```

Expected: a function that returns `{ mode: 'none' | 'catalog-only' | 'slug-targeted' | 'full' }` based on the entity name. Look for the existing `HomepageShelves` branch — the two new entities go alongside it.

- [ ] **Step 2: Write the failing test for the new entities**

Find the existing classifier test (likely `test/unit/srv/lib/classify-rebuild-mode.test.js` or similar). Run:

```bash
fd 'classify-rebuild-mode' test/
```

Then read the file shown. Append:

```js
  describe('explainer entities (#759 PR 1)', () => {
    it('VerbDefinitions write → catalog-only', () => {
      const result = classifyRebuildMode({ entityName: 'VerbDefinitions' });
      expect(result.mode).toBe('catalog-only');
    });
    it('ShelfDefinitions write → catalog-only', () => {
      const result = classifyRebuildMode({ entityName: 'ShelfDefinitions' });
      expect(result.mode).toBe('catalog-only');
    });
  });
```

(Adjust the `classifyRebuildMode` import + invocation shape to match what the existing test file uses — read the existing `HomepageShelves` test in the same file as the template.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/unit/srv/lib/classify-rebuild-mode.test.js
```

Expected: FAIL — the two new entity-name branches don't exist yet.

- [ ] **Step 4: Add the new branches to the classifier**

In `srv/lib/_classify-rebuild-mode.js`, find the existing `HomepageShelves` case. Add `VerbDefinitions` and `ShelfDefinitions` as siblings with the same return value (`{ mode: 'catalog-only' }`). The exact code shape depends on the existing implementation — if it's a switch statement, add two `case` lines. If it's a Map or object literal, add two entries.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/unit/srv/lib/classify-rebuild-mode.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/_classify-rebuild-mode.js test/unit/srv/lib/classify-rebuild-mode.test.js
git -c core.autocrlf=false commit -m "feat(#759): classify VerbDefinitions/ShelfDefinitions writes as catalog-only rebuild

Admin saves to either new entity trigger the same 60s-debounced
rebuild-content.yml workflow that HomepageShelves writes do. Catalog-only
mode is correct — they affect baked hugo/data/*.json, not slug content."
```

---

## Task 16: Full local build smoke

**Files:** none (verification only)

**Background.** Before declaring PR 1 done, run the full local build chain end-to-end to catch any integration issues between the new fetchers and the rest of the Hugo build. This is the cheapest catch for "did I break `build:all`?"

- [ ] **Step 1: Ensure local CAP is running**

In a separate terminal (or background):

```bash
cds watch
```

Wait for `[cds] - serving ... at http://localhost:4004`.

- [ ] **Step 2: Run the relevant slice of build:all**

```bash
CAP_BASE_URL=http://localhost:4004 npm run fetch-homepage-shelves \
  && CAP_BASE_URL=http://localhost:4004 npm run fetch-verb-definitions \
  && CAP_BASE_URL=http://localhost:4004 npm run fetch-shelf-definitions
```

Expected: three successful fetches with row counts (60 / 6 / 4). Skim the resulting JSON:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('hugo/data/verb_definitions.json','utf8')).verbs.map(v=>v.verbKey).join(','))"
```

Expected: `LEARN,BUILD,INTEGRATE,OPERATE,AI,CONNECT` (in some sort order).

- [ ] **Step 3: Confirm Hugo can read the new data files (smoke)**

```bash
npm run build:hugo 2>&1 | tail -10
```

(The `build:hugo` script wraps the project's Hugo binary invocation — see `package.json#scripts`. Goal is to verify Hugo doesn't error on the presence of the new `hugo/data/*.json` files. Since PR 1 doesn't change any templates, success = Hugo emits its usual stats and exits 0.)

Expected: no errors; Hugo logs page count + build time. The new JSON files are present but unread by templates (PR 2 wires them in).

- [ ] **Step 4: Run full unit test suite**

```bash
npm test
```

Expected: PASS — all new unit tests + existing unit tests (no regressions).

- [ ] **Step 5: No commit (verification step). Move to plan-review handoff.**

---

## Out-of-scope reminders for the implementer

These are explicitly NOT in PR 1 — do not add them, even if it feels natural:

- **No Hugo template changes.** `verb-spine.html`, `directory-footer.html`, `verb/list.html` stay hard-coded until PR 2. The new data files are present but unread.
- **No Vue island code.** `hugo-apps/src/homepage-explainers/` doesn't exist yet — it ships in PR 2.
- **No admin Fiori apps.** `app/admin/verb-definitions/` and `app/admin/shelf-definitions/` don't exist yet — they ship in PR 3.
- **No AI generation.** `srv/lib/explainer-generator.js`, the three AdminService actions, the system prompts, the `AICORE_EXPLAINER_GENERATOR_DISABLED` env var — all PR 3.
- **No CRUD lockdown.** `VerbDefinitions` and `ShelfDefinitions` are admin-mutable in PR 1 (they need to be — to support testing). Lockdown annotations ship in PR 3 alongside the admin apps.
- **No Playwright E2E.** That ships in PR 2 with the Vue islands.
- **No documentation page.** `docs/developers/architecture/homepage-explainers.md` is written in PR 2 (it's most useful after the user-facing UI lands).

---

## Definition of done

- [ ] All 16 tasks committed with their tests passing locally
- [ ] `npm test` passes (no regressions on the existing 800+ unit tests)
- [ ] `npm run test:hybrid -- verb-definitions-crud shelf-definitions-crud homepage-shelves-new-fields` passes against a logged-in DEV cf
- [ ] `git log --oneline` shows ~16 commits, each with a `feat(#759)` / `test(#759)` / `build(#759)` prefix
- [ ] `git status --short` is clean
- [ ] No visitor-observable change verifiable by visiting `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/` after deploy (no flip cards, no popovers, no ⓘ icons; verb-spine + directory footer + verb sub-pages all look exactly as they do today)
- [ ] Plan reviewer subagent approves (see plan-review loop below)
- [ ] PR opened against `main` with the standard PR body template; spec doc linked in description

---

## Plan-review loop

After the implementer finishes all 16 tasks above, the plan-execution skill dispatches a plan-document-reviewer subagent to verify completion. If issues are found, the implementer iterates. Loop max 3 iterations.

This plan itself is reviewed by a plan-document-reviewer subagent before execution starts — see the next step in the writing-plans skill.
 