# serveHandler Slug Case-Insensitive + Repair Hard-Delete Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the second instance of the Tutorials.slug case-sensitivity bug (in `serveHandler`'s soft-delete check) and harden the repair script to hard-delete orphans that have no FK references rather than INACTIVE-flagging them.

**Architecture:** PR #130 introduced `tutorialsTableInfo` + `LOWER("SLUG") = ?` for the publish write path. This PR reuses that helper to fix the **read path** soft-delete check at [srv/lib/content-store.js:831](srv/lib/content-store.js#L831). The serveHandler today does an exact-match `where({ slug })` against `Tutorials` to detect soft-deletes. When the canonical row's slug is mixed-case but the URL is lowercase, the check silently misses, so an admin soft-delete via AdminService would not actually 404 the page. The repair script gets a small upgrade: orphan rows with zero FK references and zero Steps are hard-deleted (cleaner — no landmine for any future case-mismatch read path), and INACTIVE-flagging is reserved for orphans that DO have FK references (where deletion would cascade-break refs).

**Tech Stack:** Node.js (CAP) + CDS QL, vitest in-memory SQLite, raw SQL for HANA case-insensitive lookups via the existing `_tutorials-table.js` helper.

**Background:** PR #130 fixed the publisher. The repair script INACTIVE-flagged the orphan lowercase row on DEV. After the merge, `serveHandler` started returning 404 for `/tutorials/abap-environment-sbpa-workflow-extend-rap-app` because its exact-match status check found the INACTIVE orphan first (line 831–848). Tom hard-deleted the orphan manually on DEV via a one-shot script (no FK refs, no Steps, safe). DEV is healthy. This PR closes the latent bug so a future admin soft-delete on a mixed-case-slug Tutorial actually works, and updates the repair script so we never re-create the landmine.

---

## File Structure

**Modified files:**
- `srv/lib/content-store.js` — apply `tutorialsTableInfo` + raw SQL to the line-831 status check
- `scripts/repair-mixed-case-tutorial-duplicates.cjs` — hard-delete orphans with no FK refs; INACTIVE only when refs exist
- `srv/__tests__/lib/content-publish-routes.test.js` — new tests for serveHandler status check (one for ACTIVE-mixed-case URL-lowercase, one for INACTIVE-canonical case-mismatch returns 404)
- `CLAUDE.md` — extend the existing slug gotcha to mention the read-path fix
- `docs/developers/architecture/build.md` — extend slug-canonicalization sub-section

**No new files.**

---

## Task 1: Failing test for serveHandler case mismatch

**Files:**
- Modify: `srv/__tests__/lib/content-publish-routes.test.js`

- [ ] **Step 1: Write the failing test**

Append a new `it(...)` to the existing `describe('content-publish-routes', ...)` block:

```javascript
  it('serveHandler finds INACTIVE Tutorials row case-insensitively (returns 404)', async () => {
    const { Tutorials, ContentFiles, ContentManifest } = cds.entities(NS);
    const seedId = cds.utils.uuid();

    // Seed: mixed-case Tutorials.slug, INACTIVE (admin soft-delete).
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug: 'abap-environment-sbpa-workflow-extend-RAP-App',
      title: 'Soft-deleted',
      status: 'INACTIVE',
    });

    // Seed: an active manifest with this slug's content (lowercase, as Hugo would publish).
    const version = 1;
    await INSERT.into(ContentManifest).entries({
      version, status: 'ACTIVE', activatedAt: new Date().toISOString(),
    });
    const html = '<html><body>real content</body></html>';
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentFiles).entries({
      slug: 'abap-environment-sbpa-workflow-extend-rap-app',
      version,
      content: gzipSync(Buffer.from(html)),
      contentHash: 'h',
      mimeType: 'text/html',
      sizeBytes: html.length,
    });

    // Request the URL with lowercase slug (Hugo emits lowercase URLs).
    const req = makeReq({ url: '/content/tutorials/abap-environment-sbpa-workflow-extend-rap-app' });
    const res = makeRes();
    await serveHandler(req, res);

    // Expectation: status check finds the mixed-case INACTIVE row via case-insensitive
    // lookup, returns 404. Today the exact-match where({ slug }) misses, falls through
    // to ContentFiles which serves the HTML — bug.
    expect(res.statusCode).toBe(404);
  });

  it('serveHandler serves ACTIVE Tutorials row when URL slug case differs', async () => {
    const { Tutorials, ContentFiles, ContentManifest } = cds.entities(NS);
    const seedId = cds.utils.uuid();

    // Seed: mixed-case Tutorials.slug, ACTIVE.
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug: 'abap-environment-sbpa-workflow-extend-RAP-App',
      title: 'Active',
      status: 'ACTIVE',
    });

    const version = 1;
    await INSERT.into(ContentManifest).entries({
      version, status: 'ACTIVE', activatedAt: new Date().toISOString(),
    });
    const html = '<html><body>real content</body></html>';
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentFiles).entries({
      slug: 'abap-environment-sbpa-workflow-extend-rap-app',
      version,
      content: gzipSync(Buffer.from(html)),
      contentHash: 'h',
      mimeType: 'text/html',
      sizeBytes: html.length,
    });

    const req = makeReq({ url: '/content/tutorials/abap-environment-sbpa-workflow-extend-rap-app' });
    const res = makeRes();
    await serveHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toContain('real content');
  });
```

If the existing test file uses different fixture helpers (e.g. supertest agent instead of `makeReq`/`makeRes`), mirror the existing pattern. Read the file first.

- [ ] **Step 2: Run the new tests — they should FAIL today**

Run: `npx vitest run srv/__tests__/lib/content-publish-routes.test.js -t "serveHandler"` 

Expected: BOTH tests FAIL — the first because today's serveHandler returns 200 instead of 404 (case mismatch makes the status check miss the INACTIVE row), the second is also expected to FAIL today only if the SQLite default collation happens to be case-insensitive — verify what actually happens. SQLite `BINARY` collation (default for non-TEXT cols, but TEXT defaults to `BINARY` too) is case-sensitive. So both should fail today.

If the second test PASSES today (i.e. SQLite happens to do case-insensitive matching), keep it as a pinning test for HANA behaviour and note in commit message that it's a documentation test on SQLite.

- [ ] **Step 3: Commit the failing tests**

```bash
git branch --show-current   # verify NOT main
git add srv/__tests__/lib/content-publish-routes.test.js
git commit -m "test(content-store): pin serveHandler case-mismatch behaviour for soft-delete"
```

---

## Task 2: Apply case-insensitive lookup at content-store.js:831

**Files:**
- Modify: `srv/lib/content-store.js` (top of file: add import; line 831: replace lookup)

- [ ] **Step 1: Add import**

Near the top of `srv/lib/content-store.js` where the other `srv/lib/*` imports live, add:

```javascript
import { tutorialsTableInfo } from './_tutorials-table.js';
```

(Confirm the helper module exists from PR #130. If the import is already present from another usage, reuse it.)

- [ ] **Step 2: Replace the line-831 lookup**

Find the block (currently around line 829-833):

```javascript
    // Status-aware lookup: a soft-deleted tutorial may either redirect or 404.
    // We do this before the cache hit so an admin status change takes effect immediately.
    const [tutMeta] = await SELECT.from(Tutorials)
      .where({ slug })
      .columns('status', 'redirectTo_ID');
```

Replace with:

```javascript
    // Status-aware lookup: a soft-deleted tutorial may either redirect or 404.
    // We do this before the cache hit so an admin status change takes effect immediately.
    //
    // Case-insensitive: legacy Tutorials.slug rows may be mixed-case (seeded
    // from GitHub repo names before the lowercase-canonical rule was adopted),
    // while inbound URLs are always lowercase (Hugo emits lowercase + the
    // upstream rawSlug-canonicalization 301 redirects mixed-case bookmarks).
    // Same pattern as upsertTutorialMetadata in content-publish-session.js.
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const { table, idCol, slugCol } = tutorialsTableInfo(namespace, isHana);
    const tutHits = await db.run(
      `SELECT "STATUS" AS status, "REDIRECTTO_ID" AS redirectTo_ID FROM ${table} WHERE LOWER(${slugCol}) = ?`,
      [slug]
    );
    // Defensive: if the case-insensitive lookup matches multiple rows (which
    // should not happen after the publish-write canonicalization but could
    // exist as legacy data), prefer the ACTIVE one.
    const tutMeta = tutHits.find(r => (r.status ?? r.STATUS) !== 'INACTIVE')
                 ?? tutHits[0]
                 ?? null;
```

Verify the column-alias pattern works on both HANA and SQLite — HANA's `AS status` returns lowercase, SQLite returns lowercase too because the SELECT alias is unquoted (folds to lowercase). The `r.status ?? r.STATUS` defends against the dialect difference.

(If the codebase has a cleaner shape for HANA/SQLite column-name normalization in this file, follow it.)

- [ ] **Step 3: Run the failing tests — they must now pass**

Run: `npx vitest run srv/__tests__/lib/content-publish-routes.test.js -t "serveHandler"`
Expected: BOTH tests PASS.

- [ ] **Step 4: Run the full lib suite**

Run: `npx vitest run srv/__tests__/lib/`
Expected: same green count as before + the 2 new tests passing. No regressions.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # verify NOT main
git add srv/lib/content-store.js
git commit -m "fix(content-store): case-insensitive Tutorials soft-delete lookup in serveHandler

When a Tutorials row's slug is mixed-case (legacy seed data) but the inbound
URL is lowercase (Hugo emits lowercase URLs), the line-831 status check
silently missed via exact-match where({ slug }). Symptoms manifested two
ways:
  1. After PR #130's repair script INACTIVE-flagged a lowercase orphan,
     the exact-match check found the orphan first and returned 404 even
     though the canonical row was ACTIVE.
  2. An admin soft-delete (status=INACTIVE) via AdminService on the
     canonical mixed-case row would silently not 404 the URL.

Reuses the tutorialsTableInfo helper introduced in PR #130 and the same
LOWER(\"SLUG\") = ? pattern. Multi-row defensive: prefers ACTIVE if both
exist (handles legacy data drift)."
```

---

## Task 3: Repair script — hard-delete safe orphans

**Files:**
- Modify: `scripts/repair-mixed-case-tutorial-duplicates.cjs`

The current repair script INACTIVE-flags orphan rows even when they have zero FK references. That leaves a landmine: any read path that does `where({ slug })` (exact-match) finds the orphan first and behaves as if the tutorial is soft-deleted. Better: hard-delete safe orphans, INACTIVE-flag unsafe ones (with a clear log).

- [ ] **Step 1: Update the per-pair logic**

In `scripts/repair-mixed-case-tutorial-duplicates.cjs`, find the third action ("INACTIVE the orphan") in the per-pair loop. Today it looks like:

```javascript
    // 3. INACTIVE the orphan
    if (orphan.status !== 'INACTIVE') {
      console.log(`  mark orphan INACTIVE`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: orphan.ID }).set({ status: 'INACTIVE' });
      deactivated++;
    }
```

Change it to:

```javascript
    // 3. Resolve the orphan: hard-delete when safe, INACTIVE-flag otherwise.
    //
    // After step 2 reparented Steps onto the canonical row, the orphan row should
    // have no Steps. Combined with the fact that orphans are never referenced by
    // GroupPathItems / CompletionPathItems (those FKs always point at the canonical
    // mixed-case row, which is the original seed), the orphan is usually
    // disposable. Only when an unexpected FK reference shows up do we keep the row
    // around as INACTIVE so an admin can reconcile manually.
    const ngds = (await SELECT.from(NgdsResults).where({ tutorial_ID: orphan.ID }).columns('ID')).length;
    const taskRecs = (await SELECT.from(TaskRecords).where({ tutorial_ID: orphan.ID }).columns('ID')).length;
    const remainingSteps = (await SELECT.from(Steps).where({ tutorial_ID: orphan.ID }).columns('ID')).length;
    const remainingGpi = (await SELECT.from(GroupPathItems).where({ tutorial_ID: orphan.ID }).columns('ID')).length;
    const remainingCpi = (await SELECT.from(CompletionPathItems).where({ tutorial_ID: orphan.ID }).columns('ID')).length;
    const refs = ngds + taskRecs + remainingSteps + remainingGpi + remainingCpi;

    if (refs === 0) {
      console.log(`  hard-delete orphan (0 FK refs)`);
      if (APPLY) await DELETE.from(Tutorials).where({ ID: orphan.ID });
      deleted++;
    } else if (orphan.status !== 'INACTIVE') {
      console.log(`  WARN ${orphan.slug}: orphan has refs (Steps=${remainingSteps} GPI=${remainingGpi} CPI=${remainingCpi} ngds=${ngds} taskRec=${taskRecs}); marking INACTIVE`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: orphan.ID }).set({ status: 'INACTIVE' });
      deactivated++;
    }
```

You will need to:
- Add `NgdsResults`, `TaskRecords`, `GroupPathItems`, `CompletionPathItems` to the `cds.entities(NS)` destructure at the top of `main()` (alongside the existing `Tutorials, Steps`)
- Add `let deleted = 0;` to the counters
- Update the summary line:
  ```javascript
  console.log(`\nsummary: copied=${copied} reparented=${reparented} deleted=${deleted} deactivated=${deactivated}  ${APPLY ? '(applied)' : '(dry-run)'}`);
  ```
- Update the script's leading doc-comment to reflect the new behaviour: "Marks the orphan lowercase row INACTIVE only when it has surviving FK references; hard-deletes it otherwise."

- [ ] **Step 2: Verify the script still parses**

```bash
node --check scripts/repair-mixed-case-tutorial-duplicates.cjs
```

Expected: clean exit. If it errors, fix syntax.

- [ ] **Step 3: (Optional) dry-run on DEV**

```bash
npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs
```

Expected: "no mixed-case duplicate Tutorials rows found — nothing to repair" (because Tom already deleted the orphan via the one-shot script). If anything else, STOP and surface.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add scripts/repair-mixed-case-tutorial-duplicates.cjs
git commit -m "fix(repair-script): hard-delete safe orphans instead of INACTIVE-flagging

When the orphan row has zero FK references (Steps, GroupPathItems,
CompletionPathItems, NgdsResults, TaskRecords) the safe action is hard-
delete: it removes the row from /build/slug-mapping cleanly and prevents
read-path lookups (e.g. serveHandler status check, before its companion
fix in this PR) from finding a landmine row.

Falls back to INACTIVE-flagging only when FK references exist, so admins
can reconcile manually."
```

---

## Task 4: Documentation update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/developers/architecture/build.md`

- [ ] **Step 1: Extend the existing CLAUDE.md gotcha**

Find the "Tutorial slugs are lowercase canonical" bullet (added in PR #130). Add a sentence:

```
The serveHandler's soft-delete status check at srv/lib/content-store.js
also reuses the tutorialsTableInfo + LOWER("SLUG") = ? pattern so admin
soft-deletes via AdminService apply correctly even when the canonical
slug is mixed-case.
```

- [ ] **Step 2: Extend the build.md sub-section**

Find the "Slug canonicalization" sub-section in `docs/developers/architecture/build.md` (added in PR #130). Append:

```markdown
The same case-insensitive pattern is applied to `serveHandler`'s
soft-delete status check ([srv/lib/content-store.js](srv/lib/content-store.js)
around the `tutMeta = await SELECT.from(Tutorials).where({ slug })` block).
This closes the latent bug where an admin soft-delete (`status=INACTIVE`)
via AdminService on a mixed-case-slugged Tutorials row would silently fail
to 404 the URL.

The repair script `scripts/repair-mixed-case-tutorial-duplicates.cjs`
hard-deletes orphan rows that have zero FK references and INACTIVE-flags
only when FK references exist. This avoids leaving INACTIVE landmines
that exact-match `where({ slug })` lookups might find.
```

- [ ] **Step 3: docs build sanity check**

```bash
timeout 240 npm run docs:build 2>&1 | tail -10
```

Expected: clean. Same flakiness gates as PR #130 — pre-existing font / network noise is fine.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add CLAUDE.md docs/developers/architecture/build.md
git commit -m "docs(slugs): extend canonicalization notes with serveHandler + repair-script behaviour"
```

---

## Task 5: PR

- [ ] **Step 1: Push + open PR**

```bash
git branch --show-current   # MUST be fix/servehandler-slug-case
git push -u origin HEAD
gh pr create --base main --head fix/servehandler-slug-case \
  --title "fix(content-store): case-insensitive Tutorials slug in serveHandler + repair-script hard-delete" \
  --body-file <(cat <<'EOF'
## Problem

After PR #130 merged, `/tutorials/abap-environment-sbpa-workflow-extend-rap-app` returned 404 on DEV. Diagnosis: PR #130's repair script INACTIVE-flagged the lowercase orphan Tutorials row. The serveHandler's soft-delete check at `srv/lib/content-store.js:831` does an exact-match `where({ slug })` against `Tutorials`, found the lowercase orphan (the URL is lowercase too), saw `status === 'INACTIVE'`, returned 404 — even though the canonical mixed-case row was ACTIVE.

DEV was unblocked manually by hard-deleting the orphan (verified safe: 0 FK refs, 0 Steps). This PR closes the latent bug at the source so it cannot recur, and updates the repair script to hard-delete safe orphans rather than INACTIVE-flag them.

## Fix

**serveHandler:** the line-831 status check now uses `tutorialsTableInfo` (introduced in PR #130) + raw SQL `LOWER("SLUG") = ?`. Same pattern as the publisher's `upsertTutorialMetadata`. Defensive: if the case-insensitive lookup somehow returns multiple rows, prefers ACTIVE.

**Repair script:** when an orphan row has zero references in Steps / GroupPathItems / CompletionPathItems / NgdsResults / TaskRecords (re-checked after the Steps reparenting), hard-deletes it. INACTIVE-flagging is reserved for orphans that *do* have references, where deletion would cascade-break refs.

## Risk

- **Low.** serveHandler change mirrors PR #130's pattern, schema unchanged. The repair-script change reduces blast radius (hard-delete is more durable than INACTIVE-flag because it removes the row from any future case-insensitive read query). Idempotent.

## Test plan

- [x] **Unit:** two new tests in `srv/__tests__/lib/content-publish-routes.test.js` pin both directions (INACTIVE mixed-case row + lowercase URL → 404; ACTIVE mixed-case row + lowercase URL → 200).
- [x] **Manual on DEV:** the URL `/tutorials/abap-environment-sbpa-workflow-extend-rap-app` already returns 200 because Tom hard-deleted the orphan. The serveHandler change is regression net for any future case-mismatch.
- [x] **Documentation:** extended the slug-canonicalization gotcha in CLAUDE.md and the architecture sub-section in build.md.

## Out of scope

- Auditing for other case-sensitive `where({ slug })` calls beyond the line-831 status check. The other slug-keyed lookups in content-store.js (`__nav__`, `__404__`, `ContentFiles`, `TutorialBodyText`) are already lowercase-canonical because the publisher writes lowercase. The publisher fix in PR #130 closes the upstream surface; this PR closes the only remaining downstream surface.

🤖 Plan: [docs/superpowers/plans/2026-05-31-servehandler-slug-case.md](docs/superpowers/plans/2026-05-31-servehandler-slug-case.md)
EOF
)
```

- [ ] **Step 2: Wait for CI green**

If smoke tests fail, treat as a real regression and Phase-1 the failure.

---

## Out of scope

- The latent case-sensitivity in `recomputeProgressForChangedTutorials` was already fixed in PR #130. No work here.
- Renaming legacy `Tutorials.slug` to lowercase: still deferred. The deletion of the lowercase orphan on DEV means there's only ONE row for the affected tutorial now (the mixed-case one), so the case-mismatch surface is essentially zero on data side. The code-side fixes in PR #130 + this PR are what protect against future mixed-case slugs.
