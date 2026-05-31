# Mixed-Case Slug stepCount Bug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the publisher from creating duplicate `Tutorials` rows when a source markdown filename contains uppercase letters, and repair the existing duplicate(s) on DEV so the group SSR shows the correct step count.

**Architecture:** Adopt the same lowercase-canonical-slug rule already enforced on the read path ([srv/lib/content-store.js:694](srv/lib/content-store.js#L694)) on the write path. Two surfaces upsert `Tutorials` from publish metadata — [srv/lib/content-publish-session.js:259](srv/lib/content-publish-session.js#L259) (chunked path, current) and [srv/lib/content-store.js:405](srv/lib/content-store.js#L405) (legacy single-shot path, still used by some test code). Both must lowercase the slug before any `SELECT/INSERT/UPDATE` against `Tutorials`/`Steps`/`TutorialMeta`. A one-shot `cds bind --exec` repair script copies `stepCount` (and other meta) from any orphan lowercase row onto the canonical mixed-case row referenced by `GroupPathItems`/`CompletionPathItems`, then INACTIVE-flags the orphan. After repair, all reads naturally converge on lowercase.

**Tech Stack:** Node.js (CAP) + CDS QL, vitest in-memory SQLite + hybrid HANA, `cds bind --exec` for the repair script.

**Risk note:** The mixed-case Tutorials rows are seed/legacy data; renaming their `slug` field to lowercase is the cleaner long-term fix but touches more rows and could break inbound bookmarks. We are deliberately NOT renaming slugs in this plan — instead, we copy `stepCount`/metadata onto the existing mixed-case row and INACTIVE the orphan. That preserves all foreign keys (`GroupPathItems.tutorial_ID`) and external links unchanged.

---

## File Structure

**New file:**
- `scripts/repair-mixed-case-tutorial-duplicates.cjs` — one-shot repair, dry-run by default, idempotent

**Modified files:**
- `srv/lib/content-publish-session.js` — lowercase slug at the top of `upsertTutorialMetadata` loop (line 264) before any DB lookup
- `srv/lib/content-store.js` — same canonicalization in the legacy `publishHandler` upsert loop (line 410)
- `srv/__tests__/lib/content-publish-session.test.js` — failing test that publishes mixed-case meta, asserts only one lowercase row exists with the correct `stepCount`
- `srv/__tests__/lib/content-publish-routes.test.js` — only if a route-level test breaks; otherwise unchanged
- `CLAUDE.md` — add a one-line gotcha entry about lowercase canonicalization on the publish write path
- `docs/developers/architecture/build.md` — document the lowercase rule alongside the existing read-path 301 redirect

---

## Task 1: Failing test that exposes the bug in the publisher

**Files:**
- Modify: `srv/__tests__/lib/content-publish-session.test.js`

- [ ] **Step 1: Write the failing test**

Append a new `it(...)` to the existing `describe('content-publish-session')` block:

```javascript
  it('upsertTutorialMetadata canonicalizes mixed-case slugs to lowercase before DB lookup', async () => {
    const { Tutorials } = cds.entities(NS);

    // Seed: a Tutorials row already exists with a MIXED-CASE slug (legacy/seed data
    // shape — the row was created when reference data was imported with the original
    // repo casing, before the lowercase-canonical rule was adopted).
    const seedId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug: 'abap-environment-sbpa-workflow-extend-RAP-App',
      title: 'Original mixed-case row',
      stepCount: null,
      status: 'ACTIVE',
    });

    // Begin/append a publish session that includes metadata for the SAME tutorial
    // keyed by the lowercase slug Hugo produces.
    const begin = await helpers.beginPublishSession({
      trigger: 'test', expectedSlugCount: 1,
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      metadata: {
        'abap-environment-sbpa-workflow-extend-rap-app': {
          title: 'Updated title',
          steps: [
            { number: 1, title: 'Step 1' },
            { number: 2, title: 'Step 2' },
            { number: 3, title: 'Step 3' },
            { number: 4, title: 'Step 4' },
          ],
        },
      },
    });

    // Assertion: still exactly ONE Tutorials row for this tutorial, and the original
    // mixed-case row's stepCount is now 4 (not null/0). The publisher must NOT have
    // inserted a second lowercase row.
    const rows = await SELECT.from(Tutorials).where({
      slug: { in: [
        'abap-environment-sbpa-workflow-extend-RAP-App',
        'abap-environment-sbpa-workflow-extend-rap-app',
      ]}
    }).columns('ID', 'slug', 'stepCount', 'title');

    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe(seedId);
    expect(rows[0].stepCount).toBe(4);
    expect(rows[0].title).toBe('Updated title');
  });
```

- [ ] **Step 2: Run test to verify it fails for the right reason**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "canonicalizes mixed-case"`
Expected: FAIL with `expected 2 to be 1` (because today's code inserts a fresh lowercase row alongside the seed mixed-case row).

If it fails for any other reason (missing table, plugin error), STOP and re-investigate before continuing.

- [ ] **Step 3: Commit the failing test**

```bash
git add srv/__tests__/lib/content-publish-session.test.js
git commit -m "test(content-publish): add failing case for mixed-case slug duplicate"
```

---

## Task 2: Lowercase canonicalization in the chunked publish path

**Files:**
- Modify: `srv/lib/content-publish-session.js:259-293`

- [ ] **Step 1: Add the canonicalization at the top of the upsert loop**

Edit the body of `upsertTutorialMetadata` so the `for (const [slug, meta] of Object.entries(metadata))` loop lowercases the slug into a local before any DB call. The change is one line plus a comment:

```javascript
async function upsertTutorialMetadata(namespace, metadata) {
  const { Tutorials, Steps } = cds.entities(namespace);
  const db = await cds.connect.to('db');
  let metaUpserted = 0;

  for (const [rawSlug, meta] of Object.entries(metadata)) {
    // Canonical slug is lowercase. Source repos sometimes ship folder names with
    // uppercase (e.g. .../extend-RAP-App/) but Hugo emits lowercase URLs and the
    // read path 301-redirects to the lowercase form (see content-store.js
    // serveHandler). Lowercasing here keeps the write path consistent with reads
    // and prevents duplicate Tutorials rows when reference data was originally
    // seeded with mixed case. See plan 2026-05-31-mixed-case-slug-stepcount.md.
    const slug = rawSlug.toLowerCase();

    try {
      const existing = await SELECT.one.from(Tutorials).where({ slug }).columns('ID');
      // ... rest of loop unchanged ...
```

Then **inside the same loop body**, every existing reference to `slug` already matches; do NOT re-introduce `rawSlug`. The TutorialMeta block (lines 329+) and the audit log line (line 380) all reference `slug` — they should keep using the lowercase value.

- [ ] **Step 2: Run the failing test — it must now pass**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "canonicalizes mixed-case"`
Expected: PASS.

- [ ] **Step 3: Run the rest of the file's tests to confirm no regression**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js`
Expected: ALL PASS (12+ tests).

- [ ] **Step 4: Commit**

```bash
git add srv/lib/content-publish-session.js
git commit -m "fix(content-publish): canonicalize Tutorials slug to lowercase in chunked publish

Hugo emits lowercase URLs and the serveHandler 301-redirects mixed-case
inbound paths to lowercase. The publish write path was the only surface
not enforcing the lowercase canonical, which produced duplicate Tutorials
rows when source markdown shipped with uppercase folder names (e.g.
abap-environment-sbpa-workflow-extend-RAP-App). The legacy mixed-case row
referenced by GroupPathItems kept its null stepCount, while a fresh
orphan lowercase row received the publish metadata, causing group SSR
to render '0 steps' for the affected tutorial."
```

---

## Task 3: Apply the same fix to the legacy single-shot publish path

**Files:**
- Modify: `srv/lib/content-store.js:405-470`

The legacy `publishHandler` in `content-store.js` has its own metadata-upsert loop (line 410). Some tests still exercise this path. Mirror the fix there.

- [ ] **Step 1: Apply the canonicalization**

Edit the loop the same way:

```javascript
        for (const [rawSlug, meta] of Object.entries(metadata)) {
          // Same lowercase-canonical rule as content-publish-session.js. Both
          // paths must agree, otherwise legacy single-shot callers reintroduce
          // the duplicate-row bug. See plan 2026-05-31-mixed-case-slug-stepcount.md.
          const slug = rawSlug.toLowerCase();
          try {
            const existing = await SELECT.one.from(Tutorials).where({ slug }).columns('ID');
            // ... rest unchanged ...
```

Apply identically to the `Steps`-upsert sub-block within the same loop and the `recomputeTutorialProgress` call — they all already reference `slug`.

- [ ] **Step 2: Add a parallel failing-then-passing test**

Append to `srv/__tests__/lib/content-publish-routes.test.js` (or the closest test file that exercises `publishHandler` directly). If no such file exists, skip this step and rely on the already-green session-level test from Task 1 plus the hybrid test in Task 5.

```javascript
// Inside an existing describe block that already imports publishHandler / supertest:
it('publishHandler upserts onto the canonical lowercase Tutorials row', async () => {
  const { Tutorials } = cds.entities(NS);
  const seedId = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({
    ID: seedId,
    slug: 'abap-environment-sbpa-workflow-extend-RAP-App',
    title: 'seed mixed-case',
    stepCount: null,
    status: 'ACTIVE',
  });

  // Build the publish payload the legacy path expects (slug → base64gzip)
  // and call the route under test. Use the same supertest agent the file already sets up.
  // ... (mirror the existing publishHandler test pattern) ...

  const rows = await SELECT.from(Tutorials).where({ slug: { like: '%extend-rap%' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].ID).toBe(seedId);
});
```

If your editor cannot reach the existing test fixture cleanly, mark this step skipped with a comment in the commit message — the session-level test from Task 1 is the primary regression net.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: ALL PASS. If any preexisting test relied on the duplicate-row behaviour, treat it as a real regression and update it to assert the new (correct) behaviour.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/content-store.js srv/__tests__/lib/content-publish-routes.test.js
git commit -m "fix(content-publish): apply lowercase-slug canonicalization to legacy publishHandler

Mirrors the chunked-path fix to keep both metadata-upsert surfaces in sync."
```

---

## Task 4: One-shot data-repair script for DEV

**Files:**
- Create: `scripts/repair-mixed-case-tutorial-duplicates.cjs`

- [ ] **Step 1: Write the script**

```javascript
// scripts/repair-mixed-case-tutorial-duplicates.cjs
//
// One-shot repair for tutorials whose Tutorials.slug shipped with mixed case
// (e.g. "abap-environment-sbpa-workflow-extend-RAP-App"). Before the publisher
// was canonicalized, those publishes inserted a parallel lowercase row holding
// the fresh stepCount/title/etc., while the original mixed-case row (still
// referenced by GroupPathItems/CompletionPathItems via tutorial_ID) kept stale
// or null metadata. Result: group SSR rendered "0 steps" for the affected
// tutorial. See plan docs/superpowers/plans/2026-05-31-mixed-case-slug-stepcount.md.
//
// Repair strategy (per duplicate pair {mixedCaseRow, lowerCaseRow}):
//   1. Copy stepCount, title, description, averageTimeToComplete, experienceTag,
//      primaryTag from the lowercase orphan onto the mixed-case row (where the
//      lowercase value is non-null and the mixed-case value is null/empty).
//   2. Re-point any Steps rows that reference the orphan back to the canonical row
//      (only when the canonical row has zero Steps — otherwise leave alone to avoid
//      unique-constraint pain on (tutorial_ID, stepOrder)).
//   3. Mark the orphan lowercase row status='INACTIVE' so it stops appearing in
//      /build/slug-mapping and any catalog reads.
//
// The script is IDEMPOTENT: running twice is a no-op. It is DRY-RUN by default
// (logs the proposed mutations to stdout). Pass --apply to actually write.
//
// Usage:
//   cf login                                                     # DEV space
//   npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs            # dry-run
//   npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs --apply    # mutate

'use strict';

const cds = require('@sap/cds');

const NS = 'com.sap.developers.ims';
const APPLY = process.argv.includes('--apply');

const COPY_FIELDS = [
  'stepCount', 'title', 'description', 'averageTimeToComplete',
  'experienceTag', 'primaryTag',
];

function isEmpty(v) {
  return v === null || v === undefined || v === '' || v === 0;
}

async function main() {
  await cds.connect.to('db');
  const { Tutorials, Steps } = cds.entities(NS);

  console.log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);

  // Pull every tutorial whose slug is non-lowercase. Then for each, look for a
  // companion row whose slug equals slug.toLowerCase() and is not the same row.
  const all = await SELECT.from(Tutorials).columns(
    'ID', 'slug', 'status',
    ...COPY_FIELDS,
  );

  const bySlug = new Map(all.map(r => [r.slug, r]));
  const pairs = [];

  for (const row of all) {
    if (!row.slug) continue;
    const lower = row.slug.toLowerCase();
    if (lower === row.slug) continue;       // already canonical, no orphan possible from this row's perspective
    const orphan = bySlug.get(lower);
    if (!orphan) continue;                  // no duplicate — nothing to repair
    if (orphan.ID === row.ID) continue;     // safety: same physical row
    pairs.push({ canonical: row, orphan });
  }

  if (pairs.length === 0) {
    console.log('no mixed-case duplicate Tutorials rows found — nothing to repair');
    return;
  }

  console.log(`found ${pairs.length} duplicate pair(s):`);
  for (const { canonical, orphan } of pairs) {
    console.log(`  ${canonical.slug} (canonical ID=${canonical.ID.slice(0,8)} stepCount=${canonical.stepCount ?? 'null'})`);
    console.log(`    └─ orphan ${orphan.slug} (ID=${orphan.ID.slice(0,8)} stepCount=${orphan.stepCount ?? 'null'} status=${orphan.status})`);
  }

  let copied = 0, reparented = 0, deactivated = 0;

  for (const { canonical, orphan } of pairs) {
    // 1. Field copy
    const updates = {};
    for (const f of COPY_FIELDS) {
      if (isEmpty(canonical[f]) && !isEmpty(orphan[f])) {
        updates[f] = orphan[f];
      }
    }
    if (Object.keys(updates).length > 0) {
      console.log(`  copy onto ${canonical.slug}: ${JSON.stringify(updates)}`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: canonical.ID }).set(updates);
      copied++;
    }

    // 2. Re-parent Steps only if the canonical row has none
    const canonicalSteps = await SELECT.from(Steps).where({ tutorial_ID: canonical.ID }).columns('ID');
    const orphanSteps = await SELECT.from(Steps).where({ tutorial_ID: orphan.ID }).columns('ID', 'stepOrder', 'title');
    if (canonicalSteps.length === 0 && orphanSteps.length > 0) {
      console.log(`  re-parent ${orphanSteps.length} Steps from orphan → canonical`);
      if (APPLY) {
        await UPDATE(Steps).where({ tutorial_ID: orphan.ID }).set({ tutorial_ID: canonical.ID });
      }
      reparented++;
    } else if (canonicalSteps.length > 0 && orphanSteps.length > 0) {
      console.log(`  WARN ${canonical.slug}: canonical has ${canonicalSteps.length} Steps and orphan has ${orphanSteps.length} — leaving Steps alone`);
    }

    // 3. INACTIVE the orphan
    if (orphan.status !== 'INACTIVE') {
      console.log(`  mark orphan INACTIVE`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: orphan.ID }).set({ status: 'INACTIVE' });
      deactivated++;
    }
  }

  console.log(`\nsummary: copied=${copied} reparented=${reparented} deactivated=${deactivated}  ${APPLY ? '(applied)' : '(dry-run)'}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Dry-run locally against the in-memory test DB to sanity-check the script does not crash**

Run:

```bash
node -e "require('@sap/cds').deploy.to('memory').then(()=>require('./scripts/repair-mixed-case-tutorial-duplicates.cjs'))"
```

Expected: prints "no mixed-case duplicate Tutorials rows found — nothing to repair" and exits 0. (An empty in-memory DB has no rows.)

If `cds.deploy.to('memory')` is not the right local-bootstrap shape, fall back to: skip step 2, rely on the hybrid dry-run in step 3.

- [ ] **Step 3: Dry-run against deployed DEV HANA**

```bash
cf login   # DEV space
npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs
```

Expected output: lists at minimum the `abap-environment-sbpa-workflow-extend-RAP-App` ↔ `...-rap-app` pair, with a non-null `stepCount` on the orphan and null on the canonical. Confirm the proposed mutations look correct **before** proceeding.

- [ ] **Step 4: STOP and ask Tom to review the dry-run output**

Print the dry-run output. Wait for explicit go-ahead before running with `--apply`. The repair touches deployed-DEV HANA, which is irreversible without a backup.

- [ ] **Step 5: Apply against DEV**

After Tom approves:

```bash
npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs --apply
```

Expected: the same per-row "copy / re-parent / deactivate" lines, ending with a non-zero summary.

- [ ] **Step 6: Verify the fix on DEV**

```bash
curl -sf "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/catalog" \
  | jq '.standaloneGroups[] | select(.tutorialSlugs[] | test("extend-rap"; "i"))'

curl -sf "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/slug-mapping" \
  | jq '.flat | map(select(.slug | test("extend-rap"; "i")))'
```

Expected:
- Group `test-two` still lists `abap-environment-sbpa-workflow-extend-RAP-App` (foreign key intact).
- `/build/slug-mapping` `.flat` now contains only ONE entry for the tutorial (the orphan no longer surfaces because it's INACTIVE).
- The DEV `/tutorials/group-test-two/` SSR page renders "4 steps" instead of "0 steps".

- [ ] **Step 7: Commit and push**

```bash
git add scripts/repair-mixed-case-tutorial-duplicates.cjs
git commit -m "feat(scripts): one-shot repair for mixed-case Tutorials slug duplicates

Walks Tutorials and finds rows whose slug is non-lowercase but has an
otherwise-identical lowercase sibling. Copies stepCount/title/etc. from
the orphan lowercase row onto the canonical mixed-case row (where empty),
re-parents Steps when safe, and marks the orphan INACTIVE. Idempotent
and dry-run by default. Companion to the publisher canonicalization fix."
```

---

## Task 5: Hybrid HANA test for the publish path

**Files:**
- Modify: `test/hybrid/content-publish-chunked.test.js` (or sibling — pick whichever already has a `cds bind` HANA harness wired up)

- [ ] **Step 1: Add a hybrid test that publishes a mixed-case slug payload and asserts no duplicate**

The unit test in Task 1 covers the SQLite path. HANA is case-sensitive on `where({ slug })` the same way SQLite is when SQLite is configured for case-sensitive comparisons (it isn't by default — another reason to verify on HANA). Mirror the Task-1 test inside the existing hybrid suite, using `__TEST__` slug prefixes per the existing write-safety guard pattern.

```javascript
it('publishHandler does not create a duplicate Tutorials row for mixed-case publish slugs', async () => {
  // Skip if write-safety guard is not enabled
  if (process.env.ALLOW_HYBRID_WRITES !== 'true') return;

  const { Tutorials } = cds.entities(NS);
  const mixedSlug = '__TEST__abap-EXTEND-rap-MIXED';
  const lowerSlug = mixedSlug.toLowerCase();
  const seedId = cds.utils.uuid();

  await INSERT.into(Tutorials).entries({
    ID: seedId,
    slug: mixedSlug,
    title: '__TEST__ seed mixed',
    stepCount: null,
    status: 'ACTIVE',
  });

  try {
    // ... call publish helpers with metadata keyed by `lowerSlug` and 4 steps ...

    const rows = await SELECT.from(Tutorials)
      .where({ slug: { in: [mixedSlug, lowerSlug] } })
      .columns('ID', 'slug', 'stepCount');

    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe(seedId);
    expect(rows[0].stepCount).toBe(4);
  } finally {
    // Cleanup: remove the seed and any orphan that might have been created
    // (defensive: if the fix regresses, the orphan is created and we still clean up)
    await DELETE.from(Tutorials).where({ slug: { in: [mixedSlug, lowerSlug] } });
  }
});
```

- [ ] **Step 2: Run the hybrid test**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- -t "mixed-case"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/content-publish-chunked.test.js
git commit -m "test(hybrid): assert publisher does not duplicate mixed-case Tutorials rows on HANA"
```

---

## Task 6: Documentation + memory hooks

**Files:**
- Modify: `CLAUDE.md` (Gotchas section)
- Modify: `docs/developers/architecture/build.md`

- [ ] **Step 1: Add a one-line gotcha to CLAUDE.md**

Append to the Gotchas section:

```markdown
- **Tutorial slugs are lowercase canonical** — Hugo emits lowercase URLs and the read path 301-redirects mixed-case inbound paths (`srv/lib/content-store.js` line ~694). The publish write path lowercases too (`srv/lib/content-publish-session.js > upsertTutorialMetadata`). Source markdown filenames may ship with capitals (e.g. `extend-RAP-App.md`); never compare slugs to the publish payload directly without `.toLowerCase()`. Mismatches manifest as "0 steps" on group SSR. Repair script: `scripts/repair-mixed-case-tutorial-duplicates.cjs`.
```

- [ ] **Step 2: Add a paragraph to docs/developers/architecture/build.md near the existing publish section**

Find the publish-content discussion in `build.md` and add:

```markdown
### Slug canonicalization

Tutorial slugs are case-sensitive identifiers in the database (`Tutorials.slug`,
`ContentFiles.slug`, etc.) and the canonical form is **lowercase**. This is
enforced at:

- The read path: `serveHandler` in `srv/lib/content-store.js` 301-redirects any
  inbound mixed-case slug to its lowercase form before lookup.
- The write path: `upsertTutorialMetadata` in `srv/lib/content-publish-session.js`
  (and the legacy duplicate in `srv/lib/content-store.js`) lowercases every
  publish-payload key before `SELECT/INSERT/UPDATE`.

Source markdown filenames in the `sap-tutorials` GitHub org are not policed
for case (some ship with uppercase, e.g. `abap-environment-sbpa-workflow-extend-RAP-App`).
Both surfaces must therefore canonicalize independently.

If you ever see a tutorial display "0 steps" on the group/mission catalog page
while the tutorial itself renders correctly, suspect a case mismatch between
`Tutorials.slug` (catalog FK target) and the slug the publisher wrote
metadata under. The one-shot repair is `scripts/repair-mixed-case-tutorial-duplicates.cjs`.
```

- [ ] **Step 3: Verify VitePress sidebar / build docs still build**

```bash
npm run docs:build
```

Expected: clean build, no broken-link warnings.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/developers/architecture/build.md
git commit -m "docs(slugs): document lowercase-canonical rule on the publish write path"
```

---

## Task 7: PR

**Files:** none

- [ ] **Step 1: Push branch and open PR**

```bash
git branch --show-current   # MUST NOT be main, per [[feedback-verify-branch-before-commit]]
git push -u origin HEAD
gh pr create --title "fix(content-publish): canonicalize Tutorials slug to lowercase + repair DEV duplicates" \
  --body "$(cat <<'EOF'
## Problem

Group SSR rendered '0 steps' for `abap-environment-sbpa-workflow-extend-RAP-App` (and any other tutorial whose source markdown ships with uppercase folder names). Root cause: the publish write path did not enforce the same lowercase-canonical rule as the read path, so a fresh lowercase 'orphan' Tutorials row was inserted on every publish, while the original mixed-case row (the one referenced by GroupPathItems.tutorial_ID) kept null/stale stepCount.

## Fix

- Lowercase the slug at the top of `upsertTutorialMetadata` (chunked path + legacy single-shot path) before any `SELECT/INSERT/UPDATE` against `Tutorials`/`Steps`/`TutorialMeta`.
- Add unit + hybrid tests pinning the canonicalization.
- Ship a one-shot repair script (`scripts/repair-mixed-case-tutorial-duplicates.cjs`) that copies stepCount/title/etc. from any existing lowercase orphan onto the canonical mixed-case row, re-parents Steps when safe, and INACTIVEs the orphan. Idempotent, dry-run by default.

## DEV repair status

`--apply` was run on DEV before merging this PR; `/build/catalog` and the group page now show the correct step counts. Verified at <https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/slug-mapping>.

## Test plan

- [x] `npm test` (unit, in-memory SQLite)
- [x] `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- -t "mixed-case"`
- [x] DEV smoke: group page renders correct step count
EOF
)"
```

- [ ] **Step 2: Wait for CI green**

If smoke tests fail, treat as a real regression and Phase-1 the failure.

---

## Out of scope for this plan

- Renaming the `Tutorials.slug` of legacy mixed-case rows to lowercase. That is a cleaner long-term shape but touches `RedirectEntity` rules and external bookmarks; ship as a separate change after this fix lands.
- Auditing other entity types (`Groups`, `Missions`, `CompletionPaths`) for similar mixed-case duplicates. Their slugs are admin-managed, not author-managed, so the case-drift surface is much smaller; defer until a real symptom appears.
- Adding a `BEFORE INSERT/UPDATE` CDS handler that lowercases `Tutorials.slug`. It would catch any future write surface, but every current writer is named in the plan, and a global handler would also lowercase legacy mixed-case slugs that we explicitly want to preserve until the rename change above ships. Revisit when the rename change is queued.
