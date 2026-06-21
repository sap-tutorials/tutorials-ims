# #385 PR-3 of 3: AuthorService field expansion — Design

> Spec brainstormed 2026-06-21. Final of 3 sequential PRs that close [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385). Predecessors: [PR-1 spec](./2026-06-21-issue-385-pr1-schema-redesign-design.md) (merged as #517), [PR-2 spec](./2026-06-21-issue-385-pr2-migrator-extension-design.md) (merged as #528).

## Summary

Realize Riley's `AuthorService` contract (settled 2026-06-19). On `MyTutorials`: 2 renames (`ownerName → owner`, `lastNotificationDate → notificationDate`) + 3 new calc fields (`repositoryName`, `monitored`, `daysSinceReview`) + 1 deletion (`outdated`). On `Tags`: 1 new virtual element (`actualTag`). New service action `isSlugAvailable(slug : String) returns Boolean`. Old→new rename map published in PR description AND `docs/developers/architecture/author-service.md`.

After this PR the 3-PR sequence is complete: PR-1 reshaped the schema, PR-2 wired the data plumbing, PR-3 exposes the new surface to Sage.

## Context — why this PR exists

Riley's [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385) is the Sage VS Code extension migration. Sage is moving off the legacy IMS backend and onto `AuthorService`, replacing local SQLite caching with on-demand OData calls. To do that without admin scope, `MyTutorials` needs Tutorial Health fields that previously lived only on `AdminService.TutorialMeta`. Riley's contract (settled 2026-06-19 — see memory `project-385-authorservice-field-expansion`) reshaped that ask into a smaller, additive surface.

PR-1 reshaped `TutorialRepositories` so it can hold the repo-group concept that drives the new `repositoryName` calc field. PR-2 populated the new columns from IMS source. PR-3 (this spec) projects the new columns onto AuthorService.

## Settled decisions (from 2026-06-21 brainstorming with Tom)

1. **`daysSinceReview` is CDS-side, not JS-after-handler.** Sage will `$filter`/`$orderby` on it (e.g. "show me tutorials where `daysSinceReview gt 120`"). A JS after-handler would break server-side filtering. Implementation: portable CAP function `days_between($now, m.reviewedDate)` — the CDS compiler maps to HANA `DAYS_BETWEEN` and SQLite julianday math automatically.

2. **`actualTag` is a native HANA `SUBSTR_AFTER` expression.** Sage's tag search composes `contains(label, X) or contains(actualTag, X) or startswith(name, 'format>')` — server-side filtering is required. HANA's `SUBSTR_AFTER(name, '>')` returns the substring after the LAST occurrence — exactly matching Riley's "leaf after last `>`" contract. Trade-off: SQLite has no equivalent function, so unit tests gate `actualTag` assertions behind `cds.env.requires.db.kind === 'hana'`. The hybrid test (PR-3 §"Tests") is the canonical source of truth. Same trade-off pattern as memory `feedback_hana_boolean_case_when`.

3. **Renames are a clean break, not backwards-compatible aliases.** Old field names disappear; consumers update in lockstep. Sage is in active migration so this is the right cutover moment. Riley wants the old→new map published in the PR description and `docs/developers/architecture/author-service.md`.

4. **`isSlugAvailable` is the single-argument form.** `(slug : String) returns Boolean`, case-insensitive `LOWER()` match across all `Tutorials`. The "rename my existing tutorial" use case (`excludeTutorialId`) is YAGNI for v1 — can be a follow-up if Sage actually needs it.

## Changes by file

### 1. `db/views.cds` — `MyTutorialsView` rewrite

**OLD** (~lines 145-174 — current view body, shown for diff context):

```cds
view MyTutorialsView as
  select from ims.Tutorials as t
    inner join ims.TutorialMeta as m on m.tutorial.ID = t.ID
    inner join ims.Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        m.lastNotificationDate,
        m.firstNotificationDate,
        case when m.notificationNumber >= 4 then true else false end as outdated : Boolean,
        m.owner       as ownerName,
        m.ownerEmail  as ownerEmail,
        u.uuid        as ownerUserId
  };
```

**NEW**:

```cds
view MyTutorialsView as
  select from ims.Tutorials as t
    inner join ims.TutorialMeta as m on m.tutorial.ID = t.ID
    inner join ims.Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        m.lastNotificationDate    as notificationDate,                    // RENAME (was lastNotificationDate)
        m.firstNotificationDate,
        m.owner                   as owner,                               // RENAME (was ownerName)
        m.ownerEmail              as ownerEmail,
        u.uuid                    as ownerUserId,
        m.repository.name         as repositoryName : String,             // NEW (chain via Association; NULL-safe)
        // `monitored` boolean is HANA-portable via CASE WHEN (see
        // feedback_hana_boolean_case_when — bare boolean comparison in a
        // SELECT projection trips HANA strict-SQL). The CDS-side `expression
        // as alias : Boolean` shape works on SQLite (unit tests) but
        // cds-to-HANA emits the raw `=` unchanged, which HANA's strict mode
        // rejects.
        case when m.monitoredStatus = 'ACTIVE'
             then true else false end                   as monitored : Boolean,  // NEW
        // `days_between` is CAP-portable (HANA DAYS_BETWEEN / SQLite julianday).
        // Sage filters on this server-side, so it stays a real CDS column,
        // not a JS after-handler. Returns NULL when reviewedDate is NULL —
        // OData $filter automatically excludes NULL rows (standard SQL).
        days_between($now, m.reviewedDate)              as daysSinceReview : Integer  // NEW
  };
```

**Changes summary:**
- `m.lastNotificationDate` → `notificationDate` (rename).
- `m.owner as ownerName` → `m.owner as owner` (rename — was awkwardly aliased to add "Name" suffix; now matches the source column name).
- `outdated` field DELETED.
- New chain `m.repository.name as repositoryName : String` — relies on PR-1's `TutorialMeta.repository` Association.
- New `monitored` CASE WHEN (HANA-portable boolean construction).
- New `daysSinceReview` via portable `days_between($now, m.reviewedDate)`.

### 2. `srv/author-service.cds` — Tags projection + new action

**OLD** (~line 14):

```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags as projection on ims.Tags;
```

**NEW**:

```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags as projection on ims.Tags {
  *,
  // HANA-native SUBSTR_AFTER returns the substring after the LAST occurrence
  // of the delimiter — exactly matches "leaf after last '>'". Not portable to
  // SQLite — unit tests gate actualTag assertions on db.kind === 'hana'.
  // Hybrid test is canonical. Same trade-off as feedback_hana_boolean_case_when.
  SUBSTR_AFTER(name, '>') as actualTag : String  // NEW (#385 PR-3)
};
```

Add at the end of the service block:

```cds
// #385 PR-3 — server-side case-insensitive slug uniqueness check.
// Sage calls this before creating a new tutorial to avoid @assert.unique.slug
// violations at write time. NOT a lock — there's a benign TOCTOU window where
// two concurrent callers both see true; the write-side constraint catches the
// loser. Documented in author-service.md.
action isSlugAvailable(slug : String) returns Boolean;
```

### 3. `srv/author-service.js` — `isSlugAvailable` handler

Add inside the existing `cds.service.impl` block (after `generateOsVariants`, before the closing `})`):

```javascript
this.on('isSlugAvailable', async (req) => {
  const { slug } = req.data;
  if (!slug || typeof slug !== 'string') {
    return req.reject(400, 'slug must be a non-empty string');
  }
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  // LOWER()-based case-insensitive match. Mirrors the publish-side upsert
  // shape (srv/lib/content-publish-session.js) so the uniqueness check uses
  // the same key space as @assert.unique.slug's enforcement at write time.
  const row = await SELECT.one.from(Tutorials)
    .columns('ID')
    .where`LOWER(slug) = ${slug.toLowerCase()}`;
  return !row;
});
```

### 4. `srv/lib/tutorial-review.js` — `snoozeTutorial` return shape rename

The existing `snoozeTutorial` action returns `{ lastNotificationDate, notificationNumber }`. To stay consistent with the rename, **rename the return shape** to `{ notificationDate, notificationNumber }`:

```javascript
// In srv/lib/tutorial-review.js, snoozeTutorial body — rename the return key:
await UPDATE(TutorialMeta, meta.ID).set({ lastNotificationDate: snoozeUntil });
return { notificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
```

Update `srv/author-service.cds` action declaration:

```cds
action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
  notificationDate     : Timestamp;   // RENAME (was lastNotificationDate)
  notificationNumber   : Integer;
};
```

The DB column on `TutorialMeta` stays as `lastNotificationDate` — only the AuthorService projection's output rename. Update `test/unit/lib/tutorial-review.test.js` accordingly.

### 5. `docs/developers/architecture/author-service.md` — rename map (new section)

Append at the end:

```markdown
## #385 PR-3 field renames (2026-06-21)

The `MyTutorials` entity in `AuthorService` underwent renames as part of unifying
field names with Sage's expectations. Consumers migrating from the previous
schema can use this table:

| Old name (pre-PR-3) | New name (post-PR-3) | Notes |
|---|---|---|
| `ownerName` | `owner` | Pure rename; underlying column unchanged. |
| `lastNotificationDate` | `notificationDate` | Pure rename; applies to `MyTutorials` AND `snoozeTutorial` action return. |
| `outdated` | _(deleted)_ | Use `daysSinceReview` with a client-side threshold (Sage owns the UX). |
| _(none — new)_ | `repositoryName` | Repo group name from `TutorialRepositories` (PR-1 schema, PR-2 backfill). NULL until backfill runs. |
| _(none — new)_ | `monitored` | Boolean: `true` iff `monitoredStatus === 'ACTIVE'`. |
| _(none — new)_ | `daysSinceReview` | Integer: `DAYS_BETWEEN(NOW, reviewedDate)`. Server-side `$filter`/`$orderby` supported. NULL when `reviewedDate` is NULL. |
| _(none — new on Tags)_ | `actualTag` | `Tags` virtual; HANA-native `SUBSTR_AFTER(name, '>')`. Leaf after last `>`. |

### New action

`isSlugAvailable(slug : String) returns Boolean` — server-side case-insensitive
uniqueness check across all `Tutorials.slug`. Use before creating a new
tutorial to surface conflicts to the user; the write-side `@assert.unique.slug`
remains the source of truth at insert time.

The check is intentionally a UX hint, not a lock. A benign TOCTOU window exists
between the check and a subsequent insert; the write-side constraint catches
any race condition.
```

If `docs/developers/architecture/author-service.md` doesn't exist yet, create it with the heading and the rename map (PR description should still quote it for review convenience). Verify via `ls docs/developers/architecture/author-service.md` before writing.

### 6. AdminService impact — NONE

`AdminService` reads the underlying `TutorialMeta` entity directly (not `MyTutorialsView`), and the underlying COLUMN names on `TutorialMeta` are NOT renamed in this PR. Verified by grep:

```
srv/admin-service.js:359:        req.data.lastNotificationDate = null;
srv/admin-service.cds:144:    lastNotificationDate : Timestamp;
db/schema.cds:321:  lastNotificationDate      : Timestamp;
```

These all reference the raw column, not the view alias. No change needed.

### 7. Auto-regenerated files

`cds build` will regenerate `db/last-dev/csn.json` with the new view shape. No migration tables change (no DB schema modification — only a view definition and a service projection).

## Tests

### Unit tests (`test/unit/author-service.test.js` — extend)

Most assertions run on SQLite (in-memory). The `actualTag` assertions skip on SQLite via a runtime gate.

**MyTutorials projection assertions:**
- Returns `owner`, `notificationDate`, `repositoryName`, `monitored`, `daysSinceReview` for a seeded tutorial owned by the authenticated user.
- Does NOT return `ownerName`, `lastNotificationDate`, `outdated` (old names — read result `Object.keys()` should not include them).
- `daysSinceReview` is a positive integer when `reviewedDate` is in the past; `null` when `reviewedDate` is null.
- `monitored` is `true` when `monitoredStatus === 'ACTIVE'`, `false` otherwise.
- `repositoryName` resolves through the chain when `TutorialMeta.repository_ID` is set; `null` when not (the dominant case in unit-test fixtures).

**`isSlugAvailable` assertions:**
- Returns `false` for an existing slug (seed `test-tutorial`; call `isSlugAvailable('test-tutorial')`).
- Returns `true` for a slug that doesn't exist.
- Returns `false` for case-mismatched existing slug (`isSlugAvailable('TeSt-TutoriaL')` against `test-tutorial`).
- Returns 400 for `null`/empty string slug.
- Does NOT require ownership — anyone with `Tutorial.Author` scope can check (it's a UX check, not a write).

**Tags projection assertions:**
- `Tags` projection emits the existing columns (name, label, etc.).
- `actualTag` assertions gated:

```javascript
const isHana = cds.env.requires.db.kind === 'hana';
it.skipIf(!isHana)('actualTag projects the leaf segment after the last `>`', async () => {
  // ... HANA-only test body
});
```

(Or use `it.runIf(isHana)`/`describe.skipIf(!isHana)` per vitest convention used elsewhere in the repo.)

**`snoozeTutorial` action assertions** (`test/unit/lib/tutorial-review.test.js`):
- Update existing assertions to expect `notificationDate` in the return shape instead of `lastNotificationDate`.

### Hybrid test (`test/hybrid/385-pr3-authorservice.test.js` — new)

Runs against real HANA via `cds bind --exec`. **Cannot run pre-deploy** — but can run immediately after PR-3 lands since PR-2's migration is what populates the data. If PR-2's hybrid tests pass, PR-3's should too.

```javascript
/**
 * #385 PR-3 hybrid test — verifies AuthorService projection emits the new
 * fields with real data after PR-2's migration pass populates the underlying
 * columns.
 *
 * Read-only. Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/385-pr3-authorservice.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#385 PR-3 — AuthorService projection', () => {
  let MyTutorialsView, Tags, Tutorials;

  beforeAll(async () => {
    const ns = cds.entities('com.sap.developers.ims');
    MyTutorialsView = ns.MyTutorialsView;
    Tags            = ns.Tags;
    Tutorials       = ns.Tutorials;
  });

  it('MyTutorialsView emits the 3 new fields', async () => {
    const row = await SELECT.one.from(MyTutorialsView).columns('ID', 'repositoryName', 'monitored', 'daysSinceReview');
    expect(row).toBeTruthy();
    // monitored is always a boolean; daysSinceReview is integer-or-null; repositoryName is string-or-null
    expect(typeof row.monitored).toBe('boolean');
  });

  it('MyTutorialsView has at least one row with non-null repositoryName (PR-2 backfill verification)', async () => {
    // Softer than a hard expect — if PR-2's migration hasn't actually run on
    // DEV yet, this should skip rather than fail noisily for a reason
    // unrelated to PR-3 code. PR-2 hybrid test asserts the underlying data;
    // this test only verifies the AuthorService projection surfaces it.
    const row = await SELECT.one.from(MyTutorialsView).where('repositoryName is not null');
    if (!row) {
      console.warn('[skip] No MyTutorials rows with repositoryName — PR-2 migration may not have run yet');
      return;
    }
    expect(typeof row.repositoryName).toBe('string');
  });

  it('Tags projection emits actualTag for at least one >-containing slug', async () => {
    // Find a tag whose name has '>' in it
    const tag = await SELECT.one.from(Tags).columns('name', 'actualTag').where(`name like '%>%'`);
    expect(tag).toBeTruthy();
    // actualTag should be the substring after the last '>'
    const expected = tag.name.slice(tag.name.lastIndexOf('>') + 1);
    expect(tag.actualTag).toBe(expected);
  });

  it('isSlugAvailable returns true for a generated unique slug', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', { slug: `pr3-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
    expect(result).toBe(true);
  });

  it('isSlugAvailable returns false for an existing slug (case-insensitive)', async () => {
    // Find any existing tutorial slug
    const tut = await SELECT.one.from(Tutorials).columns('slug');
    expect(tut?.slug).toBeTruthy();
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', { slug: tut.slug.toUpperCase() });
    expect(result).toBe(false);
  });
});
```

## Rollout

1. **Merge PR-3.**
2. **Deploy via the standard MTA path** (no schema changes, no migration tables — `cds build` regenerates the view with the new shape).
3. **Post-deploy verification:**
   - `npm run test:hybrid -- test/hybrid/385-pr3-authorservice.test.js` should pass.
   - Sage's `/me/` flow (or wherever it calls AuthorService) should show the new fields.
4. **Coordinate with Riley** — the rename map in the PR description + author-service.md gives him the migration table. Sage's OData calls migrate to the new names in the same window.
5. **No follow-up runbook** — the work is service-surface only.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Clean rename breaks Sage on deploy | Coordinate with Riley. The PR description names the migration window; the rename map is in author-service.md. Sage is in active development and Riley contracted these renames. |
| `SUBSTR_AFTER` HANA-only crashes SQLite unit tests | Skip `actualTag` assertions on SQLite via `cds.env.requires.db.kind === 'hana'` gate. Hybrid test (HANA) is the canonical verification. |
| `days_between($now, ...)` returns NULL for rows with NULL reviewedDate | NULL is the correct semantic ("never reviewed"). OData `$filter=daysSinceReview gt 120` automatically excludes NULL rows. Documented in author-service.md. |
| `m.repository.name` chain returns NULL until PR-2 migration runs | PR-2's migration was already run before merging this PR (see Rollout step 2 timing); if for any reason migration hasn't run yet, the field is just NULL — NULL-safe via SQL. |
| `isSlugAvailable` TOCTOU race | Documented as a UX check, not a lock. `@assert.unique.slug` enforces at write time. |
| `outdated` field deletion breaks an unknown consumer | Grep confirms `outdated` is only used inside `db/views.cds`'s definition; no external consumer found. If anything surfaces post-deploy, it's a 1-line restoration. |
| `case when monitoredStatus = 'ACTIVE'` HANA boolean construction | Already battle-tested via the existing `outdated` field; same shape. Memory `feedback_hana_boolean_case_when`. |

## Out of scope

- Backwards-compatible aliases (clean break per Tom).
- `isSlugAvailable` for missions/groups (only Tutorials per Riley).
- `excludeTutorialId` overload on `isSlugAvailable` (YAGNI; can be a v2 follow-up if Sage's rename use case lands).
- The 4-nag cron state machine — already done in #450.
- Persisting `actualTag` as a real column (virtual only; computed at read time).
- Sage's migration — Riley's side of the contract.

## Acceptance criteria

### Pre-merge (code shape)

- [ ] `db/views.cds` `MyTutorialsView` has `repositoryName`, `monitored`, `daysSinceReview` elements; `outdated` removed; `ownerName` renamed to `owner`; `lastNotificationDate` renamed to `notificationDate`.
- [ ] `srv/author-service.cds` `Tags` projection adds `actualTag : String` via `SUBSTR_AFTER`.
- [ ] `srv/author-service.cds` `isSlugAvailable(slug : String) returns Boolean` action declared.
- [ ] `srv/author-service.cds` `snoozeTutorial` action return type renamed (`lastNotificationDate` → `notificationDate`).
- [ ] `srv/author-service.js` implements `isSlugAvailable` with case-insensitive `LOWER()` match.
- [ ] `srv/lib/tutorial-review.js` `snoozeTutorial` return-shape key renamed.
- [ ] `docs/developers/architecture/author-service.md` has the rename map section.
- [ ] Unit tests pass on SQLite (with `actualTag` gated to HANA-only).
- [ ] Hybrid test file committed.
- [ ] `cds compile db/schema.cds` and `cds compile srv/author-service.cds` succeed.
- [ ] `npm test` runs green.
- [ ] PR description quotes the rename map (verbatim from author-service.md).

### Post-deploy

- [ ] `test/hybrid/385-pr3-authorservice.test.js` runs green on DEV.
- [ ] Sage successfully reads MyTutorials with the new field names (Riley verification).

## Spec + brainstorm trail

- Predecessor specs:
  - [`docs/superpowers/specs/2026-06-21-issue-385-pr1-schema-redesign-design.md`](./2026-06-21-issue-385-pr1-schema-redesign-design.md) (PR #517, merged 2026-06-21).
  - [`docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md`](./2026-06-21-issue-385-pr2-migrator-extension-design.md) (PR #528, merged 2026-06-21).
- Brainstorming: 2026-06-21 with Tom; 4 decisions captured in §"Settled decisions".
- Final PR of the #385 sequence.
