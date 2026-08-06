# Publish-Path Owner Stamping (#1501) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the content publish path stamp `TutorialMeta.owner` from the tutorial's frontmatter `author_name`, so the Admin UI owner column and name-based SAGE ownership join stay correct on every publish without an out-of-band script.

**Architecture:** Two changes on the existing chunked-publish authorship path. (1) `scripts/publish-content.ts` already parses the built Hugo page frontmatter into a per-slug payload but omits `author`; add `frontmatterAuthorName`. (2) `srv/lib/content-publish-session.js`'s `linkTutorialAuthorship` already resolves the declared author and writes `author_ID`/`ownerEmail`/`githubLogin` via raw `db.run()`; add one sibling raw-SQL write for `owner`, overwrite-unconditionally (same policy as the adjacent `author_ID` write).

**Tech Stack:** Node.js (CAP/`@sap/cds`), raw HANA SQL via `db.run()`, Vitest (in-memory SQLite for unit, real HANA for hybrid), TypeScript for the publish CLI.

## Global Constraints

- Owner ≠ committer (#862): `owner` is sourced from the declared-author frontmatter `author_name`, NEVER from `contributors[0]`/committer.
- Write policy: **overwrite unconditionally on strong signal** — write `owner` whenever frontmatter carries a non-empty `author_name`; never blank `owner` from a missing/empty value. Mirrors the sibling `Tutorials.author_ID` policy on the same path.
- Only the **chunked** publish path runs `linkTutorialAuthorship`. The deprecated single-shot `/content/publish` handler does NOT — do not attempt to wire owner there.
- Match existing raw-SQL idiom in `linkTutorialAuthorship`: `db.run('UPDATE ... WHERE ...', [params])`, count affected loosely as `(typeof res === 'number' ? res : 1) > 0`.
- No schema change. No `modifiedBy` logic (rejected in the spec — raw writes bypass managed stamping and historical values are ambiguous).

---

### Task 1: Carry `frontmatterAuthorName` into the publish payload

**Files:**
- Modify: `scripts/publish-content.ts` (payload type ~line 388; result object ~line 435)
- Test: `test/unit/publish-content-metadata.test.js` (create if absent; else co-locate with existing publish-content parser tests)

**Interfaces:**
- Produces: publish payload per-slug object gains `frontmatterAuthorName: string | null` (trimmed `fm.author`, or null). Consumed by Task 2 as `meta.frontmatterAuthorName`.

- [ ] **Step 1: Locate the metadata-extraction function and its payload type**

Read `scripts/publish-content.ts` around lines 385–442. Confirm: the payload type declares `frontmatterGithubLogin: string | null` (~388) and the result object sets `frontmatterGithubLogin: trim(fm.githubLogin)` (~437). The built page frontmatter carries `author:` (the display name — emitted by `scripts/parsers/render-frontmatter.ts`). `trim()` is the local helper already used for the sibling fields.

- [ ] **Step 2: Write the failing test**

If no unit test exercises this extractor, add one. If the extractor is not exported, export it (or test via the smallest public entry that returns the payload). Create `test/unit/publish-content-metadata.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
// publish-content.ts is TS; import via the project's TS test runner (tsx/vitest
// handles .ts). If the extractor fn is not exported, export it under a name
// like `extractMetadataForTest` guarded by a comment, mirroring how other
// scripts expose pure helpers for tests.
import { buildMetadataPayload } from '../../scripts/publish-content.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('publish-content metadata payload', () => {
  it('carries frontmatter author display name as frontmatterAuthorName', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'));
    writeFileSync(join(dir, 'my-slug.md'),
      '---\ntitle: My Slug\nauthor: Matthäus Schüle\nauthorProfile: https://github.com/MatthaeusSchuele\ngithubLogin: MatthaeusSchuele\nsteps: []\n---\nbody\n');
    const payload = buildMetadataPayload(dir, ['my-slug']);
    expect(payload['my-slug'].frontmatterAuthorName).toBe('Matthäus Schüle');
  });

  it('sets frontmatterAuthorName null when author is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'));
    writeFileSync(join(dir, 'no-author.md'), '---\ntitle: No Author\nsteps: []\n---\nbody\n');
    const payload = buildMetadataPayload(dir, ['no-author']);
    expect(payload['no-author'].frontmatterAuthorName).toBeNull();
  });
});
```

Note: match the ACTUAL exported function name / signature in `publish-content.ts`. If the extractor takes different args (e.g. reads a fixed content dir), adapt the test to the real interface rather than inventing `buildMetadataPayload`. The behavioral assertions (author present → trimmed value; absent → null) are what matter.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/publish-content-metadata.test.js`
Expected: FAIL — `frontmatterAuthorName` is `undefined` (field not in payload).

- [ ] **Step 4: Add the field to the type and the result object**

In the payload type (~line 388), after `frontmatterGithubLogin: string | null;`:
```ts
  frontmatterAuthorName: string | null;
```
In the result object (~line 437), after `frontmatterGithubLogin,`:
```ts
      frontmatterAuthorName: trim(fm.author),
```
(`trim()` returns null for missing/empty — confirm by reading the local `trim` helper; if it returns `''` rather than null, use `trim(fm.author) || null` to match the null contract.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/publish-content-metadata.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-content.ts test/unit/publish-content-metadata.test.js
git commit -m "feat(publish): carry frontmatter author_name into publish payload (#1501)"
```

---

### Task 2: Write `TutorialMeta.owner` in `linkTutorialAuthorship`

**Files:**
- Modify: `srv/lib/content-publish-session.js` (counter decl ~line 879; owner write in per-slug loop ~after line 1027; summary log ~line 1034)
- Test: `test/lib/content-store-tutorial-meta.test.js` (unit, in-memory) and `test/hybrid/frontmatter-owner.test.js` (hybrid)

**Interfaces:**
- Consumes: `meta.frontmatterAuthorName` from Task 1.
- Produces: after a chunked publish, `TutorialMeta.owner` equals the frontmatter `author_name` for every slug whose payload carries a non-empty `frontmatterAuthorName`.

- [ ] **Step 1: Write the failing unit test**

In `test/lib/content-store-tutorial-meta.test.js`, add a test that drives the chunked publish path (the one that runs `linkTutorialAuthorship`) — NOT the deprecated single-shot `/content/publish`. Mirror how `test/hybrid/frontmatter-owner.test.js` calls `linkTutorialAuthorship(NS, metadata)` directly, but in-memory. Seed a Tutorial + TutorialMeta row first, then:

```js
it('stamps TutorialMeta.owner from frontmatter author_name (#1501)', async () => {
  const { linkTutorialAuthorship } = await import('../../srv/lib/content-publish-session.js');
  const slug = 'owner-stamp-1';
  // seed tutorial + meta with a WRONG existing owner to prove overwrite
  const tutId = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({ ID: tutId, slug, title: 'T', status: 'ACTIVE', legacyId: 90000001 });
  await INSERT.into(TutorialMeta).entries({ ID: cds.utils.uuid(), tutorial_ID: tutId, owner: 'Wrong Person', ownerEmail: null, monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 90000001 });

  await linkTutorialAuthorship('com.sap.developers.ims', {
    [slug]: { frontmatterAuthorName: 'Matthäus Schüle', frontmatterGithubLogin: null, primaryContributorEmail: null }
  });

  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutId });
  expect(meta.owner).toBe('Matthäus Schüle');
});

it('does NOT blank owner when frontmatter author_name is missing (#1501)', async () => {
  const { linkTutorialAuthorship } = await import('../../srv/lib/content-publish-session.js');
  const slug = 'owner-stamp-2';
  const tutId = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({ ID: tutId, slug, title: 'T2', status: 'ACTIVE', legacyId: 90000002 });
  await INSERT.into(TutorialMeta).entries({ ID: cds.utils.uuid(), tutorial_ID: tutId, owner: 'Keep Me', ownerEmail: null, monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 90000002 });

  await linkTutorialAuthorship('com.sap.developers.ims', {
    [slug]: { frontmatterAuthorName: null, frontmatterGithubLogin: null, primaryContributorEmail: null }
  });

  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutId });
  expect(meta.owner).toBe('Keep Me');
});
```

Adapt seeded field names / legacyId acquisition to the file's existing helpers if present (e.g. it may use `getNextLegacyId`). Confirm `linkTutorialAuthorship`'s metadata object shape by reading its body — it reads `meta.frontmatterGithubLogin` and `meta.primaryContributorEmail`; the new field is `meta.frontmatterAuthorName`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/content-store-tutorial-meta.test.js -t "owner"`
Expected: FAIL — first test: `owner` still `'Wrong Person'` (no write yet).

- [ ] **Step 3: Add the counter declaration**

In `srv/lib/content-publish-session.js` ~line 879, after `let linkedOwnerEmails = 0;`:
```js
  let linkedOwners = 0;  // #1501 — TutorialMeta.owner from frontmatter author_name
```

- [ ] **Step 4: Add the owner write in the per-slug loop**

Immediately AFTER the `ownerEmail` write block (the `if (authorUserId) { ... OWNEREMAIL ... }` ending ~line 1027), add:
```js
      // #1501 — TutorialMeta.owner from the declared-author display name.
      // Overwrite-on-strong-signal: frontmatter author_name always wins when
      // present (same policy as Tutorials.author_ID above; both derive from the
      // same declared-author signal). Never blanks owner from an empty value.
      // Raw db.run to match the sibling writes (bypasses managed modifiedBy —
      // intentional; see spec's rejected-modifiedBy note).
      const fmAuthorName = (typeof meta.frontmatterAuthorName === 'string' && meta.frontmatterAuthorName.trim())
        ? meta.frontmatterAuthorName.trim()
        : null;
      if (fmAuthorName) {
        const res = await db.run(
          `UPDATE ${tutorialMetaTable} SET "OWNER" = ? WHERE "TUTORIAL_ID" = ?`,
          [fmAuthorName, tutorialId]
        );
        if (res && (typeof res === 'number' ? res : 1) > 0) linkedOwners++;
      }
```
Note: this block is OUTSIDE the `if (authorUserId)` guard — owner comes straight from frontmatter and does not require the author to resolve to a Users row (unlike ownerEmail). Place it after the ownerEmail block but before the per-slug `catch`. Confirm `tutorialMetaTable` and `tutorialId` are in scope at that point (they are — used by the ownerEmail write just above).

- [ ] **Step 5: Update the summary log**

At ~line 1033, extend the condition and message:
```js
  if (linkedAuthors || linkedContributors || linkedOwnerEmails || linkedOwners) {
    LOG.info(`linkTutorialAuthorship: linked ${linkedAuthors} author(s), ${linkedContributors} contributor(s), ${linkedOwnerEmails} ownerEmail(s), ${linkedOwners} owner(s)`);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/content-store-tutorial-meta.test.js -t "owner"`
Expected: PASS (both: overwrite happens; missing author_name preserved).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/content-publish-session.js test/lib/content-store-tutorial-meta.test.js
git commit -m "feat(publish): stamp TutorialMeta.owner from frontmatter author_name (#1501)"
```

---

### Task 3: Hybrid coverage + regression guard

**Files:**
- Modify: `test/hybrid/frontmatter-owner.test.js` (add owner assertions to the existing `linkTutorialAuthorship` hybrid flow)

**Interfaces:**
- Consumes: `linkTutorialAuthorship` behavior from Task 2.

- [ ] **Step 1: Add a hybrid assertion for owner on real HANA**

In `test/hybrid/frontmatter-owner.test.js`, in a test that already seeds a tutorial + meta and calls `linkTutorialAuthorship`, add a metadata payload with `frontmatterAuthorName` and assert the persisted `owner`. Use the file's `__TEST__` prefix + cleanup arrays. Example addition inside an existing `it(...)` or a new one following the file's pattern:

```js
// #1501: owner stamped from frontmatter author_name on real HANA
await linkTutorialAuthorship(NS, {
  [slug]: { frontmatterAuthorName: `${TEST_PREFIX}Owner Name`, frontmatterGithubLogin: null, primaryContributorEmail: null }
});
const metaRow = await SELECT.one.from(cds.entities(NS).TutorialMeta).where({ tutorial_ID: tutId });
expect(metaRow.owner).toBe(`${TEST_PREFIX}Owner Name`);
```

- [ ] **Step 2: Run the hybrid test (requires cds bind to DEV + ALLOW_HYBRID_WRITES)**

Run: `ALLOW_HYBRID_WRITES=true npx vitest run --project hybrid test/hybrid/frontmatter-owner.test.js`
Expected: PASS. (Self-skips when not bound to HANA — acceptable in CI without the bind; the unit tests are the gating coverage.)

- [ ] **Step 3: Run the full unit suite to confirm no regression**

Run: `npm test`
Expected: PASS — existing `author_ID`/`ownerEmail`/`githubLogin` behavior unchanged; new owner tests green.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/frontmatter-owner.test.js
git commit -m "test(publish): hybrid coverage for owner stamping (#1501)"
```

---

### Task 4: MTA version bump

**Files:**
- Modify: `.deploy/mta.yaml` (`version:` line)

- [ ] **Step 1: Bump the patch version**

Read `.deploy/mta.yaml`, find `version:`, bump the patch component (e.g. `1.11.3` → `1.11.4`). Root `mta.yaml` is legacy — only `.deploy/mta.yaml` matters.

- [ ] **Step 2: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore: bump MTA version for #1501 owner stamping"
```

---

## Post-implementation (operator, not in this plan)
- PR off fresh `origin/main`; code review (core publish path).
- Deploy; then a full content rebuild (`rebuild-content.yml`, mode=full) stamps `owner` across all tutorials through the normal pipeline — converging on the reconciliation-script state and keeping it fresh thereafter.

## Self-Review Notes
- **Spec coverage:** Change 1 → Task 1; Change 2 → Task 2; testing section → Tasks 2–3; rollout MTA bump → Task 4. All spec sections covered.
- **Placeholder scan:** test function names/args flagged as "confirm against real signature" where the exact export is unverified — the behavioral assertions are concrete. No TODO/TBD.
- **Type consistency:** `frontmatterAuthorName: string | null` defined in Task 1, consumed as `meta.frontmatterAuthorName` in Task 2; `linkedOwners` counter declared (Task 2 Step 3), incremented (Step 4), logged (Step 5) — consistent.
