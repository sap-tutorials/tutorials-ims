# PROD-namespace `-Contribution` Publish Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent tutorials sourced from `-Contribution` (QA/working) repos from being published into the public content namespace, while leaving the legitimate QA-on-prod channel unaffected.

**Architecture:** Thread a per-slug `sourceRepo` value through the existing publish sidecar/payload chain (fetch → sidecar → `publish-content` payload → `appendToSession` → `ContentFiles` row), then add a skip-guard inside `appendToSession` that fires ONLY when the handler's compile-time `namespace` is the public one (`com.sap.developers.ims`). Blocked slugs are excluded from the write (not aborted, not evicted) and reported. A workflow tripwire closes the CI path as belt-and-suspenders.

**Tech Stack:** CAP Node.js (`@sap/cds`), CDS aspects (`db/_content-shape.cds`), TypeScript build scripts (`scripts/`), GitHub Actions (`.github/workflows/rebuild-content.yml`), Vitest/CAP unit tests (in-memory SQLite).

**Spec:** `docs/superpowers/specs/2026-09-21-prod-publish-contribution-guard-design.md`

## Global Constraints

- **PR targets DEV.** `main` is protected; no hotfix path. Branch from `origin/DEV`.
- **srv-qa cp-list audit (load-bearing):** any change under `srv/lib/` requires re-walking transitive `./` imports from `srv/lib/content-store.js` and confirming every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Missing transitive deps crash QA boot at MTA deploy time. This plan adds NO new `srv/lib/` files (only edits existing ones already in the cp list), but the audit MUST still be run and recorded in the final task.
- **Public namespace constant:** the public content namespace is exactly `com.sap.developers.ims`. QA is `com.sap.developers.ims.qa`. The guard predicate keys on `namespace === 'com.sap.developers.ims'`.
- **`-Contribution` match:** a slug is QA-sourced iff its `sourceRepo` is a non-empty string ending with the literal suffix `-Contribution` (case-sensitive; repo names are canonical case, e.g. `sap-tutorials/developer-advocates-Contribution`).
- **Fail-safe:** null / empty / absent `sourceRepo` is NEVER blocked. Only positively-identified `-Contribution` repos are skipped.
- **New DB column is additive + nullable** (`ContentFiles.sourceRepo : String(255)`); no migration.
- **Do NOT edit `hugo/content/tutorials/`** (generated). Do NOT change QA-channel behavior.

---

### Task 1: Add nullable `sourceRepo` column to `ContentFilesAspect`

**Files:**
- Modify: `db/_content-shape.cds` (the `ContentFilesAspect` block, immediately after the `sourceCommit` line)

**Interfaces:**
- Consumes: nothing.
- Produces: `ContentFiles.sourceRepo` (nullable `String(255)`) available on the CDS model for both prod (`com.sap.developers.ims`) and QA (`com.sap.developers.ims.qa`) namespaces that consume this aspect.

- [ ] **Step 1: Add the column**

In `db/_content-shape.cds`, inside `aspect ContentFilesAspect`, directly below the existing line:

```cds
  sourceCommit              : String(64);   // git commit SHA of source .md at publish time (#2245); null for pre-2245 rows
```

add:

```cds
  sourceRepo                : String(255);  // owner/name of the GitHub repo the source came from (e.g. "sap-tutorials/developer-advocates"); null for pre-guard rows. Used by the public-namespace -Contribution publish guard.
```

- [ ] **Step 2: Verify the model compiles**

Run: `npx cds compile db/_content-shape.cds > /dev/null && echo OK`
Expected: prints `OK` with no compile errors.

- [ ] **Step 3: Commit**

```bash
git add db/_content-shape.cds
git commit -m "feat(content): add nullable ContentFiles.sourceRepo column

Source repo per published slug, for the public-namespace -Contribution
publish guard. Additive + nullable; QA and prod both consume the aspect."
```

---

### Task 2: Persist `sourceRepo` in `appendToSession` and add the public-namespace guard

**Files:**
- Modify: `srv/lib/content-publish-session.js` (`appendToSession`, signature at `:150`; entry push at `:180-198`)
- Modify: `srv/lib/content-store.js` (`appendHandler`, `:2030-2046` — forward `sourceRepos` from request body)
- Test: `test/content-publish-guard.test.js` (new)

**Interfaces:**
- Consumes: `ContentFiles.sourceRepo` from Task 1; the factory-closure `namespace` variable already in scope inside `createContentHandlers` (both `content-store.js` and the session helpers it builds).
- Produces:
  - `appendToSession({ ..., sourceRepos = {} })` — new param, a `Record<slug, string>` (owner/name).
  - `appendToSession` return object gains `blockedContributionSlugs: string[]` — slugs skipped by the guard (empty array when none).
  - Guard predicate: skip a slug iff `namespace === 'com.sap.developers.ims'` AND `typeof sourceRepos[slug] === 'string'` AND `sourceRepos[slug].endsWith('-Contribution')`.

> NOTE on wiring `namespace` into the session helpers: `appendToSession` is defined inside the factory that receives `namespace`. Confirm at implementation time that the session-helper factory (`beginPublishSession/appendToSession/commitSession/abortSession`, returned at `content-publish-session.js:727`) is constructed with `namespace` in scope. If the session helpers are built by a separate factory that does NOT currently receive `namespace`, thread it in as a constructor arg from `content-store.js` where the helpers are created (search `createPublishSession`/`sessionHelpers =`). The guard needs `namespace`; do not read it from any request field.

- [ ] **Step 1: Write the failing tests**

Create `test/content-publish-guard.test.js`:

```javascript
const { describe, it, expect, beforeAll } = require('vitest');
const cds = require('@sap/cds');

// Build the publish-session helpers against an in-memory model for both the
// public and QA namespaces, exercising the guard in appendToSession directly.
// We call the real appendToSession and assert which slugs it wrote.

const { createPublishSessionHelpers } = require('../srv/lib/content-publish-session.js');

async function setup(namespace) {
  // Deploy the content model to in-memory sqlite and connect.
  const model = await cds.load([__dirname + '/../db']);
  await cds.deploy(model).to('sqlite::memory:');
  // Helpers are namespace-bound (mirrors createContentHandlers).
  return createPublishSessionHelpers({ namespace });
}

const gzipB64 = (s) => require('zlib').gzipSync(Buffer.from(s)).toString('base64');

describe('public-namespace -Contribution publish guard', () => {
  it('public namespace: skips -Contribution slug, writes normal slug', async () => {
    const h = await setup('com.sap.developers.ims');
    const { sessionId } = await h.beginPublishSession({ trigger: 'test' });
    const res = await h.appendToSession({
      sessionId,
      files: { 'good-slug': gzipB64('<html>ok</html>'), 'qa-slug': gzipB64('<html>qa</html>') },
      sourceRepos: {
        'good-slug': 'sap-tutorials/developer-advocates',
        'qa-slug':   'sap-tutorials/developer-advocates-Contribution',
      },
    });
    expect(res.blockedContributionSlugs).toEqual(['qa-slug']);
    expect(res.writtenSlugs ?? res.slugs).toContain('good-slug');
    expect(res.writtenSlugs ?? res.slugs).not.toContain('qa-slug');
  });

  it('qa namespace: allows -Contribution slug', async () => {
    const h = await setup('com.sap.developers.ims.qa');
    const { sessionId } = await h.beginPublishSession({ trigger: 'test' });
    const res = await h.appendToSession({
      sessionId,
      files: { 'qa-slug': gzipB64('<html>qa</html>') },
      sourceRepos: { 'qa-slug': 'sap-tutorials/developer-advocates-Contribution' },
    });
    expect(res.blockedContributionSlugs).toEqual([]);
    expect(res.writtenSlugs ?? res.slugs).toContain('qa-slug');
  });

  it('public namespace: null/absent sourceRepo is NOT blocked (fail-safe)', async () => {
    const h = await setup('com.sap.developers.ims');
    const { sessionId } = await h.beginPublishSession({ trigger: 'test' });
    const res = await h.appendToSession({
      sessionId,
      files: { 'legacy-slug': gzipB64('<html>legacy</html>') },
      sourceRepos: {}, // no repo known
    });
    expect(res.blockedContributionSlugs).toEqual([]);
    expect(res.writtenSlugs ?? res.slugs).toContain('legacy-slug');
  });
});
```

> The test calls `createPublishSessionHelpers` and expects `appendToSession` to return `writtenSlugs` (or existing `slugs`) plus `blockedContributionSlugs`. If the real factory export name differs, adjust the `require` and the setup call to match the actual export used by `content-store.js` — verify by grepping `content-publish-session.js` for its `module.exports` / `export`. Keep the three assertions unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/content-publish-guard.test.js`
Expected: FAIL — `sourceRepos` param ignored / `blockedContributionSlugs` undefined / qa slug written in public ns but no guard exists yet.

- [ ] **Step 3: Add `sourceRepos` param + guard to `appendToSession`**

In `srv/lib/content-publish-session.js`, change the signature at `:150`:

```javascript
  async function appendToSession({ sessionId, files = {}, metadata = {}, bodyTexts = {}, branchSpecs = {}, sources = {}, sourceCommits = {}, sourceRepos = {} }) {
```

Immediately after `const slugs = Object.keys(files);`, add the partition:

```javascript
    // Public-namespace -Contribution guard. QA/working repos (owner/name ending
    // in "-Contribution") must never be published into the PUBLIC content
    // namespace. The QA channel (namespace com.sap.developers.ims.qa) is a
    // legitimate home for -Contribution content, so the guard is dormant there.
    // Fail-safe: a slug with null/absent/empty sourceRepo is NOT blocked — only
    // positively-identified -Contribution repos are skipped. Blocked slugs are
    // excluded from this write; existing rows are left untouched (no eviction).
    const isPublicNamespace = namespace === 'com.sap.developers.ims';
    const blockedContributionSlugs = isPublicNamespace
      ? slugs.filter((s) => {
          const repo = sourceRepos[s];
          return typeof repo === 'string' && repo.endsWith('-Contribution');
        })
      : [];
    const blockedSet = new Set(blockedContributionSlugs);
    for (const s of blockedContributionSlugs) {
      console.warn(`[content-publish] BLOCKED -Contribution slug from public namespace: ${s} (repo=${sourceRepos[s]})`);
    }
    const writeSlugs = slugs.filter((s) => !blockedSet.has(s));
```

Change the loop that builds `entries` to iterate `writeSlugs` instead of `slugs` (the `for (const slug of slugs)` at `:164`):

```javascript
    for (const slug of writeSlugs) {
```

Set `sourceRepo` on the pushed entry, directly after the `sourceCommit` line at `:196`:

```javascript
        sourceCommit: sourceCommits[slug] || null,
        sourceRepo: sourceRepos[slug] || null,
```

Update the DELETE-before-INSERT chunk loop (`:210`, `for (let i = 0; i < slugs.length; ...)`) to use `writeSlugs`:

```javascript
      for (let i = 0; i < writeSlugs.length; i += 500) {
        const chunk = writeSlugs.slice(i, i + 500);
```

At the `appendToSession` return statement, add `blockedContributionSlugs` to the returned object (find the existing `return { ... }` in `appendToSession`; add the field alongside whatever it already reports, e.g. `slugs`/`writtenSlugs`/`totalSizeBytes`):

```javascript
      // ... existing return fields ...
      blockedContributionSlugs,
```

> If `appendToSession` does not currently return a written-slug list, add `writtenSlugs: writeSlugs` to the return object so callers and tests can see what actually landed.

- [ ] **Step 4: Forward `sourceRepos` through `appendHandler`**

In `srv/lib/content-store.js` at `:2035`, add `sourceRepos` to the destructure and the forwarded call at `:2046`:

```javascript
      const { sessionId, files, metadata, bodyTexts, branchSpecs, sources, sourceCommits, sourceRepos } = req.body || {};
```
```javascript
      const result = await sessionHelpers.appendToSession({ sessionId, files, metadata, bodyTexts, branchSpecs, sources, sourceCommits, sourceRepos });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/content-publish-guard.test.js`
Expected: PASS (all three).

- [ ] **Step 6: Run the existing publish/content test suite for regressions**

Run: `npx vitest run test/ --reporter=dot 2>&1 | tail -20` (or the project's `npm test` scoped to content tests — check `jq '.scripts.test' package.json`)
Expected: no new failures vs baseline. If a pre-existing unrelated failure appears, note it and continue.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/content-publish-session.js srv/lib/content-store.js test/content-publish-guard.test.js
git commit -m "feat(content): guard public namespace against -Contribution slugs

appendToSession skips any slug whose sourceRepo ends in -Contribution when
bound to the public namespace (com.sap.developers.ims); QA namespace is
unaffected. Fail-safe: null sourceRepo passes. Blocked slugs reported via
blockedContributionSlugs and a WARN log; existing rows untouched."
```

---

### Task 3: Emit `<slug>.source-repo` sidecar in fetch-tutorials

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (both sidecar-write sites, `:1028` and `:1042`, where `.commit-sha` is written)

**Interfaces:**
- Consumes: `t.slug`, `t.repo` (the discovered `{slug, repo, branch}` — `repo` is the owner/name string, already carried on each discovered tutorial per `scripts/parsers/github.ts:629`), and `CACHE_DIR`.
- Produces: a `<slug-lowercase>.source-repo` file in `CACHE_DIR` containing the repo owner/name string, alongside the existing `<slug-lowercase>.commit-sha`.

> Verify at implementation time that the tutorial object in scope at `:1028`/`:1042` exposes the repo as `t.repo` (owner/name). If it is stored differently (e.g. `t.repoFullName`, or `owner`+`name` split), use the correct field(s) to compose the `owner/name` string. The value written MUST match what GitHub reports as the repo full name so the `.endsWith('-Contribution')` guard fires correctly.

- [ ] **Step 1: Write the sidecar next to `.commit-sha` (site 1, `:1028`)**

After the existing:

```javascript
          writeFileSync(join(CACHE_DIR, `${t.slug.toLowerCase()}.commit-sha`), ghMeta.lastCommitSha, 'utf-8')
```

add:

```javascript
          if (t.repo) writeFileSync(join(CACHE_DIR, `${t.slug.toLowerCase()}.source-repo`), t.repo, 'utf-8')
```

- [ ] **Step 2: Write the sidecar next to `.commit-sha` (site 2, `:1042`)**

Apply the same addition after the second `.commit-sha` write at `:1042`.

- [ ] **Step 3: Type-check the script**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i fetch-tutorials || echo "no fetch-tutorials type errors"`
Expected: `no fetch-tutorials type errors` (or the project's script-lint passes). If `t.repo` is not a known property, correct the field per the interface note above until this passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(fetch): emit <slug>.source-repo sidecar

Records the GitHub repo owner/name per tutorial alongside .commit-sha, so
publish-content can carry sourceRepo into the publish payload for the
public-namespace -Contribution guard."
```

---

### Task 4: Carry `sourceRepo` into the publish payload in publish-content

**Files:**
- Modify: `scripts/publish-content.ts` (add `buildSourceReposPayload` near `buildSourceCommitsPayload` at `:260`; wire it in at `:1366` and into the batch body at `:1416`)
- Test: `test/publish-content-sidecars.test.js` (new)

**Interfaces:**
- Consumes: `<slug>.source-repo` sidecars from Task 3; the `appendToSession`/`appendHandler` `sourceRepos` param from Task 2.
- Produces: `buildSourceReposPayload(slugs: string[], cacheDir: string): Record<string, string>` (exported), and a `sourceRepos` field on each append batch body.

- [ ] **Step 1: Write the failing test**

Create `test/publish-content-sidecars.test.js`:

```javascript
const { describe, it, expect } = require('vitest');
const { mkdtempSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { buildSourceReposPayload } = require('../scripts/publish-content.ts');

describe('buildSourceReposPayload', () => {
  it('reads <slug>.source-repo sidecars (lowercase filename), keyed by original-case slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srp-'));
    writeFileSync(join(dir, 'my-slug.source-repo'), 'sap-tutorials/developer-advocates-Contribution\n', 'utf-8');
    const out = buildSourceReposPayload(['My-Slug'], dir);
    expect(out['My-Slug']).toBe('sap-tutorials/developer-advocates-Contribution');
  });

  it('skips slugs with no sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srp-'));
    const out = buildSourceReposPayload(['absent'], dir);
    expect(out.absent).toBeUndefined();
  });
});
```

> If the project runs TS tests via `tsx`/`vitest` with a different import form for `.ts` modules, mirror however `buildSourceCommitsPayload` is imported in existing tests (grep `buildSourceCommitsPayload` under `test/`). Keep the assertions unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publish-content-sidecars.test.js`
Expected: FAIL — `buildSourceReposPayload` is not exported.

- [ ] **Step 3: Add `buildSourceReposPayload` (mirror `buildSourceCommitsPayload`)**

In `scripts/publish-content.ts`, directly after `buildSourceCommitsPayload` (ends ~`:271`), add:

```typescript
/**
 * Parallel to buildSourceCommitsPayload: reads `<slug>.source-repo` sidecars
 * (owner/name of the GitHub repo the source came from) written by
 * fetch-tutorials. Keyed by ORIGINAL-CASE slug so the server's
 * sourceRepos[slug] lookup lands on the correct entry; the file lookup uses
 * slug.toLowerCase() to match the lowercase-canonical sidecar filename.
 * Feeds the public-namespace -Contribution publish guard.
 */
export function buildSourceReposPayload(
  slugs: string[],
  cacheDir: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const slug of slugs) {
    const repoPath = join(cacheDir, `${slug.toLowerCase()}.source-repo`);
    if (!existsSync(repoPath)) continue;
    const repo = readFileSync(repoPath, 'utf-8').trim();
    if (repo) result[slug] = repo;
  }
  return result;
}
```

- [ ] **Step 4: Wire it into the publish flow**

At `:1366`, next to the `sourceCommitsAll` build, add:

```typescript
  const sourceReposAll = buildSourceReposPayload(tutorialOnlySlugs, cacheDir);
  log(`Source repo payload: ${Object.keys(sourceReposAll).length}/${tutorialOnlySlugs.length} slugs have source repos`);
```

In the batch append body (`:1416`, next to `sourceCommits: pickEntries(sourceCommitsAll, batch),`), add:

```typescript
          sourceRepos: pickEntries(sourceReposAll, batch),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/publish-content-sidecars.test.js`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-content.ts test/publish-content-sidecars.test.js
git commit -m "feat(publish): carry sourceRepo into the publish payload

buildSourceReposPayload reads <slug>.source-repo sidecars and includes a
sourceRepos map on each append batch, feeding the public-namespace
-Contribution guard in appendToSession."
```

---

### Task 5: Workflow tripwire — fail a public prod publish that would include `-Contribution` repos

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` (add a guard step before the publish step at `~:835`, using `steps.env.outputs.target`)

**Interfaces:**
- Consumes: `steps.env.outputs.target` (`dev|qa|prod`) and whatever env/flag controls `-Contribution` inclusion in the fetch step (`INCLUDE_CONTRIBUTION_REPOS`, and the `--channel qa` → `ONLY_CONTRIBUTION_REPOS` path). This workflow drives the PUBLIC channel; the QA channel is a separate workflow (`rebuild-content-qa.yml`), so on this workflow `-Contribution` inclusion during a `prod` target is always illegitimate.
- Produces: a failing run (non-zero) before any publish when the illegitimate combination is detected.

> Verify at implementation time how/whether this public workflow ever sets `INCLUDE_CONTRIBUTION_REPOS`/`ONLY_CONTRIBUTION_REPOS` or passes `--channel qa` to the fetch step. The tripwire asserts the public workflow never fetches `-Contribution` repos while targeting prod. If the workflow has no such input at all, the tripwire is a static assertion documenting the invariant (still valuable) — implement it as a check on the fetch step's resolved env, not an unconditional failure.

- [ ] **Step 1: Add the guard step**

In `.github/workflows/rebuild-content.yml`, immediately before the `Publish content` step (`run: | npx tsx scripts/publish-content.ts ...`, ~`:835`), add:

```yaml
      - name: Guard — no -Contribution repos in a public prod publish
        if: ${{ steps.mode.outputs.effective_mode != 'catalog-only' }}
        env:
          TARGET: ${{ steps.env.outputs.target }}
          INCLUDE_CONTRIB: ${{ env.INCLUDE_CONTRIBUTION_REPOS }}
          ONLY_CONTRIB: ${{ env.ONLY_CONTRIBUTION_REPOS }}
        run: |
          set -euo pipefail
          if [ "$TARGET" = "prod" ] && { [ "${INCLUDE_CONTRIB:-}" = "true" ] || [ "${ONLY_CONTRIB:-}" = "true" ]; }; then
            echo "::error title=Contribution-in-prod guard::A public PROD publish must not include -Contribution repos (INCLUDE_CONTRIBUTION_REPOS=$INCLUDE_CONTRIB ONLY_CONTRIBUTION_REPOS=$ONLY_CONTRIB). QA content belongs on the QA channel (rebuild-content-qa.yml)."
            exit 1
          fi
          echo "Contribution-in-prod guard passed (target=$TARGET)."
```

- [ ] **Step 2: Lint the workflow YAML**

Run: `npx yaml-lint .github/workflows/rebuild-content.yml 2>/dev/null || python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rebuild-content.yml')); print('YAML OK')"`
Expected: `YAML OK` (or clean lint). If `actionlint` is available in the repo, run it and fix any findings.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "ci(rebuild-content): tripwire blocking -Contribution repos in prod publish

Belt-and-suspenders for the server-side guard: fail a public PROD publish
if the fetch step would include -Contribution repos. QA content flows only
through rebuild-content-qa.yml."
```

---

### Task 6: srv-qa cp-list audit + full verification + PR

**Files:**
- Read: `.deploy/mta.yaml` (`srv-qa` module `cp` list)
- Read: `srv/lib/content-store.js`, `srv/lib/content-publish-session.js` (transitive `./` imports)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a rebased-on-DEV branch and an open PR to DEV.

- [ ] **Step 1: srv-qa cp-list audit**

Re-walk transitive `./` (relative) imports starting from `srv/lib/content-store.js` and `srv/lib/content-publish-session.js`. This plan added NO new `srv/lib/` files, so the set of files to package is unchanged — confirm that. Run:

```bash
grep -nE "require\('\./|from '\./" srv/lib/content-store.js srv/lib/content-publish-session.js
```

Confirm every relative dep is already present in `.deploy/mta.yaml`'s `srv-qa` `cp` list (search the `tutorials-srv-qa` module block). Record in the PR body: "srv-qa cp-list audit: no new srv/lib files added; existing cp list unchanged and complete."

- [ ] **Step 2: Full content test suite**

Run: `npm test 2>&1 | tail -30` (unit, in-memory SQLite)
Expected: green, or only pre-existing unrelated failures (note them). The three guard tests + two sidecar tests pass.

- [ ] **Step 3: Rebase onto DEV**

```bash
git fetch origin DEV
git rebase origin/DEV
```
Resolve any conflicts (unlikely — additive changes). Re-run `npm test` after rebase.

- [ ] **Step 4: Push and open PR to DEV**

```bash
git push -u origin HEAD
gh pr create --base DEV --title "feat: guard public namespace against -Contribution publishes" \
  --body "$(cat <<'EOF'
## What
Prevents tutorials sourced from `-Contribution` (QA/working) repos from being published into the PUBLIC content namespace, closing the gap that let `devtoberfest2026-ai-week1-validation` (source only in `developer-advocates-Contribution`) go live on the public site.

## How
- `appendToSession` skips any slug whose `sourceRepo` ends in `-Contribution` when bound to the public namespace (`com.sap.developers.ims`); the QA namespace (`...ims.qa`, srv-qa on prod) is unaffected. Fail-safe: null `sourceRepo` passes. Blocked slugs reported + WARN-logged; existing rows untouched (no eviction).
- New nullable `ContentFiles.sourceRepo`, threaded fetch → `<slug>.source-repo` sidecar → publish payload → row.
- Workflow tripwire fails a public PROD publish that would include `-Contribution` repos.

## Spec / design
`docs/superpowers/specs/2026-09-21-prod-publish-contribution-guard-design.md`

## srv-qa cp-list audit
No new `srv/lib/` files added; existing `cp` list unchanged and complete.

## Not in scope
Evicting the existing contaminated `devtoberfest2026-ai-week1-validation` row (skip-leave-existing keeps it). Follow-up: promote ai-week* QA→public, or manual evict.

## Testing
Unit (in-memory SQLite): public-ns blocks -Contribution, qa-ns allows it, null-repo passes; sidecar round-trip. Full `npm test` green.
EOF
)"
```

- [ ] **Step 5: Report the PR URL**

State the opened PR URL and the follow-up (evict/promote the existing ai-week1 row) back to the user.

## Self-Review

- **Spec coverage:** §1 payload threading → Tasks 1,3,4; §2 guard → Task 2; §3 tripwire → Task 5; constraints (srv-qa audit, DEV target) → Task 6. Out-of-scope (eviction, provenance-envelope hardcode) explicitly deferred, not implemented. ✎ Covered.
- **Placeholder scan:** No TBD/TODO. Each code step shows concrete edits; the three implementation-time verification notes (namespace threading, `t.repo` field, workflow contrib-env) are bounded "confirm the exact symbol" checks with a fallback, not open-ended work.
- **Type consistency:** `sourceRepos` (Record<slug,string>) consistent across `appendToSession` param (T2), `appendHandler` forward (T2), payload build (T4). `blockedContributionSlugs: string[]` returned by `appendToSession` and asserted in T2 test. `buildSourceReposPayload(slugs, cacheDir)` signature matches its test (T4) and `buildSourceCommitsPayload`. Column `sourceRepo` (T1) matches entry field (T2) and sidecar value (T3/T4). Guard predicate identical in spec and T2.
