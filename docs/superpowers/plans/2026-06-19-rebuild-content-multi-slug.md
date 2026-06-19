# Multi-slug rebuild input — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `rebuild-content.yml` to refresh exactly N specified slugs in one run via a new `slugs` workflow_dispatch input. Existing single-slug `slug` input stays. Both inputs are unioned into a `Set<string>` filter inside `fetch-tutorials.ts`.

**Architecture:** New `slugs` input on the workflow + new exported pure function `parseSlugFilter(slug?, slugs?): Set<string> | null` in `fetch-tutorials.ts`. Replace the existing single-string `tutorialSlugFilter: string | null` with `Set<string> | null`. Every `t.slug === filter` becomes `filter.has(t.slug)`. No publish-side or backend change — `publish-content.ts`'s delta protocol handles the upload naturally.

**Tech Stack:** TypeScript, Vitest, GitHub Actions YAML. Tests live alongside `fetch-tutorials-qa.test.ts` and exercise the pure parser.

**Spec:** [docs/superpowers/specs/2026-06-19-rebuild-content-multi-slug-design.md](../specs/2026-06-19-rebuild-content-multi-slug-design.md)

**Issue:** [#433](https://github.com/sap-tutorials/tutorials-ims/issues/433)

**Branch:** `fix/issue-433-rebuild-content-multi-slug` (already created; spec committed as `ed0f4f1a`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/fetch-tutorials.ts` | Modify | Export `parseSlugFilter()`. Change `tutorialSlugFilter` type from `string \| null` to `Set<string> \| null`. Update validation, cache busting, regenerate-skip, and log lines. |
| `scripts/__tests__/fetch-tutorials-slug-filter.test.ts` | Create | Unit tests for `parseSlugFilter()` covering all input shapes from the spec. |
| `.github/workflows/rebuild-content.yml` | Modify | Add `slugs` input. Pipe `TUTORIAL_SLUGS: ${{ inputs.slugs }}` to fetch step. Update Summary step to print the slug list when present. |
| `CLAUDE.md` | Modify | Update the existing `rebuild-content.yml` mention in the CI/CD section: `slug` → `slug` / `slugs`. |

---

## Task 1: Add the failing unit tests for `parseSlugFilter()`

**Files:**
- Create: `scripts/__tests__/fetch-tutorials-slug-filter.test.ts`

The tests must fail because `parseSlugFilter` doesn't exist yet. TDD red-first.

- [ ] **Step 1: Create the test file with the full test suite**

Paste verbatim:

```ts
import { describe, it, expect } from 'vitest'
import { parseSlugFilter } from '../fetch-tutorials'

describe('parseSlugFilter', () => {
  it('returns null when both inputs are empty/undefined', () => {
    expect(parseSlugFilter()).toBeNull()
    expect(parseSlugFilter('', '')).toBeNull()
    expect(parseSlugFilter(undefined, undefined)).toBeNull()
    expect(parseSlugFilter('   ', '  ,  ,  ')).toBeNull()
  })

  it('returns a 1-element Set for a single `slug` (back-compat)', () => {
    const filter = parseSlugFilter('foo', '')
    expect(filter).toBeInstanceOf(Set)
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })

  it('parses comma-separated `slugs` into a multi-element Set', () => {
    const filter = parseSlugFilter('', 'foo,bar,baz')
    expect(filter!.size).toBe(3)
    expect([...filter!].sort()).toEqual(['bar', 'baz', 'foo'])
  })

  it('tolerates spaces around commas: `foo, bar , baz`', () => {
    const filter = parseSlugFilter('', 'foo, bar , baz')
    expect(filter!.size).toBe(3)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
    expect(filter!.has('baz')).toBe(true)
  })

  it('drops empty tokens: `foo,, bar`', () => {
    const filter = parseSlugFilter('', 'foo,, bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('unions both `slug` and `slugs` when both are provided', () => {
    const filter = parseSlugFilter('alpha', 'beta,gamma')
    expect(filter!.size).toBe(3)
    expect(filter!.has('alpha')).toBe(true)
    expect(filter!.has('beta')).toBe(true)
    expect(filter!.has('gamma')).toBe(true)
  })

  it('dedupes when `slug` overlaps with `slugs`', () => {
    const filter = parseSlugFilter('foo', 'foo,bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('trims whitespace inside `slug` too', () => {
    const filter = parseSlugFilter('  foo  ', '')
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, confirm it FAILS (red)**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/__tests__/fetch-tutorials-slug-filter.test.ts --reporter=default
```

Expected: import error / `parseSlugFilter is not a function` — the export doesn't exist yet. All 8 tests fail.

- [ ] **Step 3: Commit the failing test**

```bash
git -c core.autocrlf=false add scripts/__tests__/fetch-tutorials-slug-filter.test.ts
git -c core.autocrlf=false commit -m "test(fetch-tutorials): parseSlugFilter unit tests [RED] (#433)"
```

---

## Task 2: Implement `parseSlugFilter()` and pivot the filter to `Set`

**Files:**
- Modify: `scripts/fetch-tutorials.ts`

This is the meat of the change. Five edits in one file — apply them in order.

- [ ] **Step 1: Add the exported `parseSlugFilter()` function**

Find the existing exported helpers near the top of the file (search for `export function parseChannel` or `export function parseTarget`). Add `parseSlugFilter` next to them:

```ts
/**
 * Parse the single-slug `slug` input + the comma-separated `slugs` input
 * into a unified `Set<string>` filter, or `null` for full rebuild.
 *
 * - Both empty → `null` (full rebuild).
 * - `slug=foo` → `Set(['foo'])` (back-compat with #157 single-slug refresh).
 * - `slugs=foo,bar,baz` → `Set(['foo','bar','baz'])`.
 * - `slugs="foo, bar , baz"` → `Set(['foo','bar','baz'])` (spaces tolerated).
 * - Both provided → union with dedupe.
 * - Empty tokens (`"foo,,bar"`) silently dropped.
 *
 * Spec: docs/superpowers/specs/2026-06-19-rebuild-content-multi-slug-design.md (#433).
 */
export function parseSlugFilter(slug?: string, slugs?: string): Set<string> | null {
  const set = new Set<string>()
  const single = (slug ?? '').trim()
  if (single) set.add(single)
  for (const tok of (slugs ?? '').split(',')) {
    const t = tok.trim()
    if (t) set.add(t)
  }
  return set.size > 0 ? set : null
}
```

- [ ] **Step 2: Run the unit tests, confirm GREEN**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/__tests__/fetch-tutorials-slug-filter.test.ts --reporter=default
```

Expected: all 8 tests pass.

- [ ] **Step 3: Pivot `tutorialSlugFilter` to use the new function**

Find the existing line (around `scripts/fetch-tutorials.ts:467`):

```ts
const tutorialSlugFilter = (process.env.TUTORIAL_SLUG ?? '').trim() || null
```

Replace with:

```ts
const tutorialSlugFilter = parseSlugFilter(process.env.TUTORIAL_SLUG, process.env.TUTORIAL_SLUGS)
```

Note: this now returns `Set<string> | null` instead of `string | null`. The next steps update every consumer.

- [ ] **Step 4: Update the validation + cache-busting block**

Find the existing block (around lines 573–588):

```ts
if (tutorialSlugFilter) {
  const match = allTutorials.find(t => t.slug === tutorialSlugFilter)
  if (!match) {
    console.error(`ERROR: TUTORIAL_SLUG="${tutorialSlugFilter}" not found in discovered tutorials.`)
    console.error(`  Discovery returned ${allTutorials.length} slugs from source: ${discovery.source}`)
    process.exit(1)
  }
  const targetCacheFile = join(CACHE_DIR, `${tutorialSlugFilter}.md`)
  if (existsSync(targetCacheFile)) {
    unlinkSync(targetCacheFile)
    console.log(`[slug-filter] busted cache for ${tutorialSlugFilter} (${match.repo}@${match.branch}) — will be re-fetched`)
  } else {
    console.log(`[slug-filter] no cache to bust for ${tutorialSlugFilter} — fresh fetch will run`)
  }
  console.log(`[slug-filter] ${allTutorials.length - 1} other tutorials will be regenerated from cache\n`)
}
```

Replace with:

```ts
if (tutorialSlugFilter) {
  // Validate every requested slug exists; fail-fast and list ALL unknowns
  // so the author fixes typos in one rerun (per spec).
  const discoveredSlugs = new Set(allTutorials.map(t => t.slug))
  const unknown = [...tutorialSlugFilter].filter(s => !discoveredSlugs.has(s))
  if (unknown.length > 0) {
    console.error(`ERROR: ${unknown.length} unknown slug(s) in filter: ${unknown.join(', ')}`)
    console.error(`  Discovery returned ${allTutorials.length} slugs from source: ${discovery.source}`)
    process.exit(1)
  }
  // Source-attributed log line (matches spec verification expectations).
  const fromSlug = (process.env.TUTORIAL_SLUG ?? '').trim()
  const fromSlugs = (process.env.TUTORIAL_SLUGS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
  if (fromSlug && fromSlugs.length > 0) {
    console.log(`[slug-filter] ${tutorialSlugFilter.size} slug(s) (1 from slug, ${fromSlugs.length} from slugs): ${[...tutorialSlugFilter].join(', ')}`)
  } else {
    console.log(`[slug-filter] ${tutorialSlugFilter.size} slug(s): ${[...tutorialSlugFilter].join(', ')}`)
  }
  // Bust each requested slug's markdown cache so it gets re-fetched.
  for (const slug of tutorialSlugFilter) {
    const match = allTutorials.find(t => t.slug === slug)!  // already validated above
    const targetCacheFile = join(CACHE_DIR, `${slug}.md`)
    if (existsSync(targetCacheFile)) {
      unlinkSync(targetCacheFile)
      console.log(`[slug-filter] busted cache for ${slug} (${match.repo}@${match.branch}) — will be re-fetched`)
    } else {
      console.log(`[slug-filter] no cache to bust for ${slug} — fresh fetch will run`)
    }
  }
  const remaining = allTutorials.length - tutorialSlugFilter.size
  console.log(`[slug-filter] ${remaining} other tutorials will be regenerated from cache\n`)
}
```

- [ ] **Step 5: Update the regenerate-skip check**

Find the existing line (around line 641):

```ts
if (regenerateMode || (tutorialSlugFilter && t.slug !== tutorialSlugFilter)) {
```

Replace with:

```ts
if (regenerateMode || (tutorialSlugFilter && !tutorialSlugFilter.has(t.slug))) {
```

- [ ] **Step 6: Verify nothing else references the old single-string filter**

```bash
cd D:/projects/tutorials-poc
grep -n "tutorialSlugFilter" scripts/fetch-tutorials.ts
```

Expected matches (no others):
- The `const tutorialSlugFilter = parseSlugFilter(...)` line.
- The `if (channel !== 'prod')` / `discovery.source === 'github' && !tutorialSlugFilter` line — `!tutorialSlugFilter` (truthy null check) still works as-is; **no edit needed**.
- The `} else if (tutorialSlugFilter)` line in the same chunk — same; **no edit needed**.
- The validation+cache-busting block (just rewritten).
- The regenerate-skip line (just rewritten).

If any other site uses the variable as if it were a string (e.g. interpolated into a path), update it to iterate the set.

- [ ] **Step 7: Run the full test suite for `scripts/`**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/__tests__ --reporter=default
```

Expected: all tests pass (the new 8 + the existing channel/dir tests in `fetch-tutorials-qa.test.ts`).

- [ ] **Step 8: Commit**

```bash
git -c core.autocrlf=false add scripts/fetch-tutorials.ts
git -c core.autocrlf=false commit -m "feat(fetch-tutorials): support multi-slug filter via TUTORIAL_SLUGS env (#433)

parseSlugFilter() unions TUTORIAL_SLUG (single, back-compat) and
TUTORIAL_SLUGS (comma-list) into Set<string>. Validation fails fast
listing ALL unknown slugs at once. Cache busting loops over the set;
regenerate-skip uses Set.has() instead of string equality."
```

---

## Task 3: Wire the new input through the workflow

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`

- [ ] **Step 1: Add the `slugs` input**

Find the existing `slug` input (around line 17–20):

```yaml
      slug:
        description: Refresh a single tutorial slug only (leave blank for full rebuild)
        required: false
        type: string
```

Add a sibling `slugs` input directly below it:

```yaml
      slug:
        description: Refresh a single tutorial slug only (leave blank for full rebuild)
        required: false
        type: string
      slugs:
        description: 'Refresh multiple slugs (comma-separated, e.g. "foo,bar,baz"). Unioned with `slug` if both set; full rebuild if both blank. Spec: #433.'
        required: false
        type: string
```

- [ ] **Step 2: Pipe `TUTORIAL_SLUGS` to the fetch step**

Find the env block on the `Fetch tutorials` step (around line 162–178) — it has `TUTORIAL_SLUG: ${{ inputs.slug }}`. Add a sibling line:

```yaml
          TUTORIAL_SLUG: ${{ inputs.slug }}
          TUTORIAL_SLUGS: ${{ inputs.slugs }}
```

- [ ] **Step 3: Update the Summary step**

Find the existing block (around lines 299–301):

```yaml
          if [ -n "${{ inputs.slug }}" ]; then
            echo "- **Slug filter:** ${{ inputs.slug }} (single-tutorial refresh)" >> "$GITHUB_STEP_SUMMARY"
          fi
```

Replace with:

```yaml
          if [ -n "${{ inputs.slug }}" ] || [ -n "${{ inputs.slugs }}" ]; then
            FILTER="${{ inputs.slug }}"
            if [ -n "${{ inputs.slugs }}" ]; then
              if [ -n "$FILTER" ]; then FILTER="$FILTER,${{ inputs.slugs }}"
              else FILTER="${{ inputs.slugs }}"
              fi
            fi
            echo "- **Slug filter:** $FILTER (partial refresh)" >> "$GITHUB_STEP_SUMMARY"
          fi
```

- [ ] **Step 4: YAML sanity check**

```bash
cd D:/projects/tutorials-poc
yq eval '.on.workflow_dispatch.inputs | keys' .github/workflows/rebuild-content.yml
```

Expected output includes both `slug` and `slugs` as keys.

```bash
yq eval '.jobs.rebuild.steps[] | select(.name == "Fetch tutorials") | .env' .github/workflows/rebuild-content.yml | head -10
```

Expected: `TUTORIAL_SLUGS: ${{ inputs.slugs }}` line appears alongside `TUTORIAL_SLUG`.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=false add .github/workflows/rebuild-content.yml
git -c core.autocrlf=false commit -m "ci(rebuild-content): add `slugs` workflow input (#433)"
```

---

## Task 4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the existing `rebuild-content.yml` paragraph**

```bash
cd D:/projects/tutorials-poc
grep -n "rebuild-content.yml" CLAUDE.md | head -5
```

Locate the line that mentions "Authors can force-refresh a single tutorial by running the workflow with the optional `slug` input filled in".

- [ ] **Step 2: Update the wording**

Find the existing sentence:

```markdown
- **`rebuild-content.yml`** — Re-fetches tutorials, rebuilds Hugo, and publishes content to HANA (triggered manually or on tutorial source changes). Authors can force-refresh a single tutorial by running the workflow with the optional `slug` input filled in — the fetch step honors `TUTORIAL_SLUG` env var, busts that slug's markdown cache, regenerates the rest from cache, and skips the HANA `RepoCatalog` upload so the partial run doesn't overwrite the catalog. Leave `slug` blank for a full rebuild.
```

Replace with:

```markdown
- **`rebuild-content.yml`** — Re-fetches tutorials, rebuilds Hugo, and publishes content to HANA (triggered manually or on tutorial source changes). Authors can force-refresh a single tutorial via the optional `slug` input, OR a comma-separated list via the `slugs` input (#433) — the fetch step honors `TUTORIAL_SLUG` + `TUTORIAL_SLUGS` env vars, busts those slugs' markdown caches, regenerates the rest from cache, and skips the HANA `RepoCatalog` upload so the partial run doesn't overwrite the catalog. If both `slug` and `slugs` are set, the union is used. Leave both blank for a full rebuild.
```

- [ ] **Step 3: Commit**

```bash
git -c core.autocrlf=false add CLAUDE.md
git -c core.autocrlf=false commit -m "docs(claude): document `slugs` rebuild-content input (#433)"
```

---

## Task 5: Push branch and open PR

- [ ] **Step 1: Verify branch state**

```bash
cd D:/projects/tutorials-poc
git branch --show-current
git log --oneline main..HEAD
```

Expected: branch `fix/issue-433-rebuild-content-multi-slug`, log shows 5 commits (1 spec + 1 test + 1 fetch + 1 workflow + 1 CLAUDE).

- [ ] **Step 2: Push**

```bash
git push -u origin fix/issue-433-rebuild-content-multi-slug
```

- [ ] **Step 3: Open PR**

```bash
gh pr create \
  --repo sap-tutorials/tutorials-ims \
  --base main \
  --title "feat(rebuild-content): batched per-slug refresh via `slugs` input (#433)" \
  --body "$(cat <<'EOF'
## What

Extend \`rebuild-content.yml\` to refresh exactly N specified slugs in one run. Adds a new \`slugs\` workflow_dispatch input (comma-separated). The existing \`slug\` input stays unchanged. If both are provided, the union is used.

## Why

Per #433: today's options for refreshing N>1 tutorials in the same PR are (a) fire N separate workflow runs (~5–8 min each, N× pipeline overhead) or (b) fire one full 1380-tutorial rebuild (~10–13 min). Neither fits the small-multi-tutorial case. Surfaced 2026-06-19 by a 4-tutorial chore PR.

## Changes

- **\`scripts/fetch-tutorials.ts\`**: new exported \`parseSlugFilter()\` pure function. \`tutorialSlugFilter\` is now \`Set<string> | null\` instead of \`string | null\`. Validation fails fast and lists ALL unknown slugs at once. Cache busting loops over the set; regenerate-skip uses \`Set.has()\` instead of string equality.
- **\`scripts/__tests__/fetch-tutorials-slug-filter.test.ts\`**: 8 unit tests for \`parseSlugFilter()\` (single, multi, comma+space, empty tokens, union, dedupe, whitespace trim).
- **\`.github/workflows/rebuild-content.yml\`**: new \`slugs\` input + \`TUTORIAL_SLUGS\` env wiring. Summary step shows the combined filter.
- **\`CLAUDE.md\`**: docs the new input.

## Backward compatibility

- \`slug=foo\` keeps working unchanged (1-element set).
- \`slug\` blank, \`slugs\` blank → full rebuild as today.
- \`repository_dispatch\` (admin-write debounce) is unaffected — it doesn't pass either input.

## Test plan

- ✅ All 8 new \`parseSlugFilter\` unit tests pass.
- ✅ Existing \`fetch-tutorials-qa.test.ts\` still passes.
- The first multi-slug workflow_dispatch run will exercise the live path; CI delta-publish handles uploads naturally.

## Refs

- Spec: [docs/superpowers/specs/2026-06-19-rebuild-content-multi-slug-design.md](docs/superpowers/specs/2026-06-19-rebuild-content-multi-slug-design.md)
- Plan: [docs/superpowers/plans/2026-06-19-rebuild-content-multi-slug.md](docs/superpowers/plans/2026-06-19-rebuild-content-multi-slug.md)
- Related (deferred): #429 (broader mission/group/category-level rebuild scope)

Closes #433.
EOF
)"
```

Expected: PR URL printed.

---

## Out of scope (per spec)

- Multi-slug for `repository_dispatch` (admin-write debounce). Single-slug is sufficient.
- Mission/group/category-level batch refresh (#429, broader scope).
- Regex / glob expansion of slug patterns.
- Parallelizing per-slug fetch beyond the existing `runWithConcurrency()` cap of 3.

## Notes for the implementer

- **TDD order matters.** Task 1 produces a RED state — the import fails because `parseSlugFilter` doesn't exist. Task 2 Step 1 turns it GREEN before any other change. Task 2 Step 7 confirms no existing tests broke.
- **Re-issue `git checkout` if a session is long.** If you've been working past 2026-06-19's session, verify `git branch --show-current` returns `fix/issue-433-rebuild-content-multi-slug` BEFORE every commit — long sessions can silently slip HEAD back to main (memory: `feedback_branch_slip_after_long_session`). Pair the checkout with the commit invocation when in doubt.
- **5 commits expected on the branch.** Don't squash — spec → red test → fetch impl → workflow → CLAUDE.md is a clean reviewable story.
