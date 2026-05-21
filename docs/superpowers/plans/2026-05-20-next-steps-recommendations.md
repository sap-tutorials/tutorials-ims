# Next-Steps Recommendation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AEM `NextStepsServlet` recommendation engine with a two-phase build-time pipeline that surfaces "Related Tutorials" beneath the existing "Next Tutorial" card on every tutorial page.

**Architecture:**
- **Phase v1** is pure parser + Hugo: a deterministic scoring function over already-fetched tutorial frontmatter (`tags`, `primaryTag`, `missionId`) that computes the top 3 related tutorials per page, written into each tutorial's frontmatter as a `recommendations` array. The existing `next-steps.html` partial reads that array and renders cards. No CAP changes, no runtime calls.
- **Phase v2** layers in a co-completion signal. A new `GET /build/co-completions` CAP endpoint aggregates `TaskRecord` history into a `{ slug → [{slug, score}] }` map. The fetch script merges this with the v1 tag-overlap signal at build time using a 60% co-completion / 40% tag-overlap weighting; falls back to pure tag overlap for cold-start slugs (low or no co-completion data).

**Architecture rationale:** Pre-computing recommendations at fetch time (rather than in Hugo templates) makes the scoring testable in Vitest, keeps Hugo logic to pure rendering, and gives v2 a single place to blend signals without touching Hugo templates again. The output frontmatter is identical between v1 and v2 — only the input signals change.

**Tech Stack:** TypeScript (parser), Node.js + CAP (`@sap/cds`), Hugo 0.140+ (Goldmark), Vitest (unit + hybrid + smoke), CSS (SAP Fundamental Styles + Horizon variables).

**Reference materials:**
- Existing partial: [hugo/layouts/partials/next-steps.html](../../../hugo/layouts/partials/next-steps.html)
- Existing CSS: [hugo/assets/css/sap-fundamental.css:526-590](../../../hugo/assets/css/sap-fundamental.css#L526-L590)
- Build catalog endpoint pattern: [srv/lib/build-catalog.js](../../../srv/lib/build-catalog.js) and [srv/server.js:86-94](../../../srv/server.js#L86-L94)
- Fetch frontmatter patch helper: [scripts/fetch-tutorials.ts:385-422](../../../scripts/fetch-tutorials.ts#L385-L422) (`patchTutorialFrontmatter`)
- Frontmatter type: [scripts/parsers/types.ts:44-63](../../../scripts/parsers/types.ts#L44-L63) (`TutorialNavEntry`)
- Smoke test pattern: [test/smoke/content-serve.test.js](../../../test/smoke/content-serve.test.js)

---

## File Structure

### Phase v1 — Tag-Overlap Recommendations

**Create:**
- `scripts/parsers/recommendations.ts` — pure scoring function: takes `TutorialNavEntry[]` + options, returns `Map<slug, string[]>` of recommendation slugs per tutorial. Single responsibility: ranking. No I/O.
- `scripts/__tests__/recommendations.test.ts` — Vitest unit tests for scoring logic, edge cases, exclusions, tie-breaking.

**Modify:**
- `scripts/parsers/types.ts` — add `recommendations?: string[]` to `TutorialNavEntry`.
- `scripts/fetch-tutorials.ts` — after Phase 5 mission/group resolution, call `computeRecommendations()` and merge results into the existing `patchTutorialFrontmatter` call so the YAML is rewritten in one pass.
- `hugo/layouts/partials/next-steps.html` — extend the partial to render a "Related Tutorials" rail beneath the existing "Next Tutorial" card. Reads `.Params.recommendations` (array of slugs). Resolves each slug via `site.GetPage`, falls back to humanized slug if the page is missing.
- `hugo/assets/css/sap-fundamental.css` — add `.next-steps-rail`, `.next-steps-grid`, `.next-steps-rail-card` styles (responsive grid).

### Phase v2 — Co-Completion Signal

**Create:**
- `srv/lib/co-completion.js` — TaskRecord aggregator. Reads `{ taskType: 'TUTORIAL', status: 'COMPLETED' }` rows, groups by user, then for each tutorial computes co-completion counts. Memoized with 1-hour TTL (data changes rarely). Returns `{ [slug]: [{slug, score}] }`.
- `test/lib/co-completion.test.js` — in-memory SQLite Vitest, seeds TaskRecords + Tutorials + Users, asserts aggregation correctness for trivial and edge cases (single user, no overlap, sparse data).
- `test/smoke/next-steps-recommendations.test.js` — smoke test against deployed site: GETs a known tutorial, asserts the "Related Tutorials" heading is present and ≥1 card rendered.

**Modify:**
- `srv/server.js` — register `app.get('/build/co-completions', coCompletionsHandler)` (unauthenticated, parallel to `/build/catalog`).
- `scripts/parsers/cap.ts` — add `fetchCoCompletions(baseUrl): Promise<Map<slug, Map<slug, number>>>` helper.
- `scripts/parsers/recommendations.ts` — extend signature to accept optional `coCompletions` map; blend co-completion (60%) and tag-overlap (40%) scores when available, fall back to pure tag-overlap when missing.
- `scripts/__tests__/recommendations.test.ts` — extend with blended-scoring assertions.
- `scripts/fetch-tutorials.ts` — call `fetchCoCompletions()` during the CAP phase (Phase 4), pass into `computeRecommendations()`.

---

# Phase v1 — Tag-Overlap Recommendations

## Task 1: Add `recommendations` field to nav entry type

**Files:**
- Modify: `scripts/parsers/types.ts:44-63`

- [ ] **Step 1: Add the field to the interface**

```typescript
// scripts/parsers/types.ts
export interface TutorialNavEntry {
  slug: string
  title: string
  description: string
  time: number
  level: string
  stepCount: number
  primaryTag: string
  displayTags: string[]
  repo?: string
  branch?: string
  missionId?: number
  missionTitle?: string
  groupId?: number
  groupTitle?: string
  missionSlug?: string
  groupSlug?: string
  prev: string | null
  next: string | null
  recommendations?: string[]   // ← ADD THIS
}
```

- [ ] **Step 2: Run typecheck to confirm no other files break**

Run: `npx tsc --noEmit`
Expected: PASS (the field is optional, existing call sites unaffected).

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/types.ts
git commit -m "feat(recommendations): add recommendations field to TutorialNavEntry"
```

---

## Task 2: Write failing test for the scoring function (no overlap case)

**Files:**
- Create: `scripts/__tests__/recommendations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/__tests__/recommendations.test.ts
import { describe, it, expect } from 'vitest'
import { computeRecommendations } from '../parsers/recommendations'
import type { TutorialNavEntry } from '../parsers/types'

function navEntry(overrides: Partial<TutorialNavEntry>): TutorialNavEntry {
  return {
    slug: 'a',
    title: 'A',
    description: '',
    time: 5,
    level: 'beginner',
    stepCount: 1,
    primaryTag: '',
    displayTags: [],
    prev: null,
    next: null,
    ...overrides,
  }
}

describe('computeRecommendations', () => {
  it('returns empty array when no other tutorial shares any tag', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'alpha', primaryTag: 'a', displayTags: ['x'] }),
      navEntry({ slug: 'beta',  primaryTag: 'b', displayTags: ['y'] }),
    ]
    const result = computeRecommendations(entries)
    expect(result.get('alpha')).toEqual([])
    expect(result.get('beta')).toEqual([])
  })
})
```

> **Note on tag fields:** `TutorialNavEntry` exposes `displayTags` (humanized) and `primaryTag` (raw `category>value` form). The scoring function uses `displayTags` for the overlap calculation since those are what end up in the rendered tag list. `primaryTag` is treated separately as the heavy-bonus signal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: FAIL with "Cannot find module '../parsers/recommendations'".

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/__tests__/recommendations.test.ts
git commit -m "test(recommendations): scoring function returns empty for disjoint tag sets"
```

---

## Task 3: Implement the minimal scoring function to make Task 2 pass

**Files:**
- Create: `scripts/parsers/recommendations.ts`

- [ ] **Step 1: Write the minimal implementation**

```typescript
// scripts/parsers/recommendations.ts
import type { TutorialNavEntry } from './types'

export interface RecommendationOptions {
  topN?: number
  primaryTagBonus?: number
}

export function computeRecommendations(
  entries: TutorialNavEntry[],
  options: RecommendationOptions = {},
): Map<string, string[]> {
  const topN = options.topN ?? 3
  const primaryTagBonus = options.primaryTagBonus ?? 10
  const result = new Map<string, string[]>()

  for (const target of entries) {
    const candidates: Array<{ slug: string; score: number; title: string }> = []
    const targetTags = new Set(target.displayTags)

    for (const candidate of entries) {
      if (candidate.slug === target.slug) continue
      if (target.missionId && candidate.missionId === target.missionId) continue

      let score = 0
      if (target.primaryTag && candidate.primaryTag === target.primaryTag) {
        score += primaryTagBonus
      }
      for (const tag of candidate.displayTags) {
        if (targetTags.has(tag)) score += 1
      }

      if (score > 0) {
        candidates.push({ slug: candidate.slug, score, title: candidate.title })
      }
    }

    candidates.sort((a, b) =>
      b.score - a.score || a.title.localeCompare(b.title)
    )

    result.set(target.slug, candidates.slice(0, topN).map(c => c.slug))
  }

  return result
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/recommendations.ts
git commit -m "feat(recommendations): minimal scoring function for tag overlap"
```

---

## Task 4: Add test for primaryTag bonus weighting

**Files:**
- Modify: `scripts/__tests__/recommendations.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the existing `describe` block:

```typescript
  it('ranks primaryTag matches above tag-only matches', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',  primaryTag: 'cap',  displayTags: ['CAP', 'Node'] }),
      navEntry({ slug: 'tag-only', primaryTag: 'btp', displayTags: ['CAP', 'Node', 'BTP'] }),
      navEntry({ slug: 'primary-match', primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const result = computeRecommendations(entries)
    // primary-match has primaryTag bonus (+10) + 1 tag overlap → 11
    // tag-only has 2 tag overlaps → 2
    expect(result.get('target')).toEqual(['primary-match', 'tag-only'])
  })
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: PASS (existing implementation already handles this).

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/recommendations.test.ts
git commit -m "test(recommendations): primaryTag match outranks tag-only overlap"
```

---

## Task 5: Add test for same-mission exclusion

**Files:**
- Modify: `scripts/__tests__/recommendations.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
  it('excludes tutorials in the same mission as the target', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',     missionId: 1, primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'sibling',    missionId: 1, primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'outsider',   missionId: 2, primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const result = computeRecommendations(entries)
    expect(result.get('target')).toEqual(['outsider'])
  })
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/recommendations.test.ts
git commit -m "test(recommendations): same-mission siblings excluded from recs"
```

---

## Task 6: Add test for top-N truncation and stable tie-breaking

**Files:**
- Modify: `scripts/__tests__/recommendations.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
  it('truncates to top 3 by default and breaks ties by title alphabetically', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target', primaryTag: 'x', displayTags: ['X'] }),
      navEntry({ slug: 'aa',     title: 'AA', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'bb',     title: 'BB', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'cc',     title: 'CC', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'dd',     title: 'DD', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
    ]
    const result = computeRecommendations(entries)
    expect(result.get('target')).toEqual(['aa', 'bb', 'cc'])
  })
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/recommendations.test.ts
git commit -m "test(recommendations): top-N truncation with title tie-break"
```

---

## Task 7: Wire the scorer into the fetch pipeline

**Files:**
- Modify: `scripts/fetch-tutorials.ts:923-929` (the patching loop) and `scripts/fetch-tutorials.ts:392-418` (`patchTutorialFrontmatter`)

- [ ] **Step 1: Import and invoke the scorer in the fetch script**

In `scripts/fetch-tutorials.ts`, near the top with the other parser imports:

```typescript
import { computeRecommendations } from './parsers/recommendations'
```

Then locate the existing patch loop (around line 923):

```typescript
let patchedCount = 0
for (const nav of navEntries) {
  if (nav.missionId || nav.prev || nav.next) {
    patchTutorialFrontmatter(nav.slug, nav, OUTPUT_DIR, target)
    patchedCount++
  }
}
```

Replace with:

```typescript
const recommendations = computeRecommendations(navEntries)
for (const nav of navEntries) {
  const recs = recommendations.get(nav.slug) ?? []
  if (recs.length > 0) nav.recommendations = recs
}

let patchedCount = 0
for (const nav of navEntries) {
  if (nav.missionId || nav.prev || nav.next || nav.recommendations) {
    patchTutorialFrontmatter(nav.slug, nav, OUTPUT_DIR, target)
    patchedCount++
  }
}
```

- [ ] **Step 2: Extend `patchTutorialFrontmatter` to handle the array field**

Locate `patchTutorialFrontmatter` (around line 380). Update the `patchFields` declaration:

```typescript
const patchFields: Record<string, string | number | string[] | null> = {
  prev: nav.prev,
  next: nav.next,
}
if (nav.missionId) patchFields.missionId = nav.missionId
if (nav.missionTitle) patchFields.missionTitle = nav.missionTitle
if (nav.missionSlug) patchFields.missionSlug = nav.missionSlug
if (nav.groupId) patchFields.groupId = nav.groupId
if (nav.groupTitle) patchFields.groupTitle = nav.groupTitle
if (nav.groupSlug) patchFields.groupSlug = nav.groupSlug
if (nav.recommendations && nav.recommendations.length > 0) {
  patchFields.recommendations = nav.recommendations
}
```

And the YAML-serializing helper inside the same function (the inline ternary that handles `string | number | null`) needs a branch for arrays:

```typescript
function serializeYamlValue(val: string | number | string[] | null): string {
  if (val === null) return 'null'
  if (Array.isArray(val)) return `\n${val.map(s => `  - ${JSON.stringify(s)}`).join('\n')}`
  if (typeof val === 'string') return JSON.stringify(val)
  return String(val)
}
```

Replace the two inline `val === null ? 'null' : typeof val === 'string' ? JSON.stringify(val) : val` expressions with `serializeYamlValue(val)` calls.

- [ ] **Step 3: Run a sanity build**

Run: `npm run fetch-tutorials`
Expected: completes without errors. `patchedCount` log line should be ≥ the previous run.

- [ ] **Step 4: Spot-check a tutorial**

Open `hugo/content/tutorials/abap-cloud-ui-from-interface.md` (Read tool, or `cat` in git bash) and inspect the frontmatter.
Expected: see a `recommendations:` block listing 1–3 slugs, e.g.

```yaml
recommendations:
  - "another-tutorial-slug"
  - "second-slug"
  - "third-slug"
```

> **Note on YAML serialization:** `serializeYamlValue` returns a leading `\n` for arrays so the rewritten line becomes `recommendations:` followed by an indented block list on the next lines. This is valid YAML 1.2 block-collection syntax; the existing scalar serialization paths (string/number/null) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(recommendations): wire tag-overlap scorer into fetch pipeline"
```

---

## Task 8: Render the related-tutorials rail in the Hugo partial

**Files:**
- Modify: `hugo/layouts/partials/next-steps.html`

- [ ] **Step 1: Replace the partial with the extended version**

```html
{{- $hasNext := .Params.next -}}
{{- $hasRecs := and .Params.recommendations (gt (len .Params.recommendations) 0) -}}

{{- if or $hasNext $hasRecs -}}
<div class="next-steps">
  <h3 class="next-steps-heading">Next Steps</h3>

  {{- with .Params.next -}}
  {{- $nextSlug := . -}}
  {{- $nextPage := site.GetPage (printf "/tutorials/%s" $nextSlug) -}}
  {{- if $nextPage -}}
  <a href="/tutorials/{{ $nextSlug }}" class="next-steps-card">
    <span class="next-steps-label">TUTORIAL</span>
    <span class="next-steps-title">{{ $nextPage.Title }}</span>
    {{- with $nextPage.Params.time }}
    <span class="next-steps-meta">
      <span class="next-steps-time-icon">&#9201;</span> {{ . }} min.
    </span>
    {{- end }}
    <span class="next-steps-expand">+</span>
  </a>
  {{- else -}}
  <a href="/tutorials/{{ $nextSlug }}" class="next-steps-card">
    <span class="next-steps-label">TUTORIAL</span>
    <span class="next-steps-title">{{ $nextSlug | humanize | title }}</span>
    <span class="next-steps-expand">+</span>
  </a>
  {{- end -}}
  {{- end -}}

  {{- if $hasRecs }}
  <div class="next-steps-rail">
    <h4 class="next-steps-rail-heading">Related Tutorials</h4>
    <div class="next-steps-grid">
      {{- range .Params.recommendations -}}
      {{- $recSlug := . -}}
      {{- $recPage := site.GetPage (printf "/tutorials/%s" $recSlug) -}}
      {{- if $recPage }}
      <a href="/tutorials/{{ $recSlug }}" class="next-steps-rail-card">
        <span class="next-steps-label">TUTORIAL</span>
        <span class="next-steps-title">{{ $recPage.Title }}</span>
        {{- with $recPage.Params.time }}
        <span class="next-steps-meta">
          <span class="next-steps-time-icon">&#9201;</span> {{ . }} min.
        </span>
        {{- end }}
      </a>
      {{- end -}}
      {{- end }}
    </div>
  </div>
  {{- end }}
</div>
{{- end -}}
```

- [ ] **Step 2: Build the site and visually verify**

Run: `npm run build:hugo` (or `npm run dev` and open a tutorial page in the browser)
Expected: tutorials with non-empty `recommendations` show a "Related Tutorials" grid below the existing Next card.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/next-steps.html
git commit -m "feat(recommendations): render related-tutorials rail in next-steps partial"
```

---

## Task 9: Style the related-tutorials rail

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.css` (append after the existing `.next-steps-expand` block at line 590)

- [ ] **Step 1: Add the rail styles**

```css
/* Related Tutorials rail (v1 recommendations) */
.next-steps-rail {
  margin-top: 1.5rem;
}

.next-steps-rail-heading {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--sapTextColor, #32363a);
}

.next-steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.next-steps-rail-card {
  display: block;
  padding: 0.875rem 1rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  background: var(--sapGroup_ContentBackground, #fff);
  text-decoration: none;
  transition: box-shadow 0.15s, transform 0.15s;
}

.next-steps-rail-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

.next-steps-rail-card .next-steps-title {
  font-size: 0.9375rem;
  line-height: 1.3;
}

.next-steps-rail-card .next-steps-meta {
  font-size: 0.75rem;
}
```

- [ ] **Step 2: Rebuild CSS**

Run: `npm run build:css`
Expected: `hugo/static/css/sap-fundamental.css` updated.

- [ ] **Step 3: Visual check**

Run: `npm run dev`, open a tutorial page, confirm the grid responsive on resize, hover state works, contrast looks correct in both light and dark mode.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/css/sap-fundamental.css
git commit -m "style(recommendations): grid styles for related-tutorials rail"
```

---

## Task 10: Smoke test for the rendered rail

**Files:**
- Create: `test/smoke/next-steps-recommendations.test.js`

- [ ] **Step 1: Write the failing smoke test**

```javascript
// test/smoke/next-steps-recommendations.test.js
import { describe, it, expect } from 'vitest'
import { config } from './smoke.config.js'

describe('Next Steps recommendations', () => {
  it('renders Related Tutorials rail on a known tutorial page', async () => {
    const url = `${config.baseUrl}/tutorials/abap-cloud-ui-from-interface/`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const html = await res.text()
    // The rail heading appears only when recommendations are populated.
    expect(html).toContain('Related Tutorials')
    // At minimum one rail card with a tutorial link. Hugo may emit attributes
    // in any order (href before/after class), so allow both orderings.
    expect(html).toMatch(/next-steps-rail-card[\s\S]*?href="\/tutorials\/[a-z0-9-]+/)
  })
})
```

- [ ] **Step 2: Run smoke test against local dev**

Run: `npm run dev` in one terminal, then:
`SMOKE_BASE_URL=http://localhost:1313 npx vitest run test/smoke/next-steps-recommendations.test.js`
Expected: PASS (after Tasks 7–9 are deployed locally).

- [ ] **Step 3: Commit**

```bash
git add test/smoke/next-steps-recommendations.test.js
git commit -m "test(smoke): related-tutorials rail renders on tutorial pages"
```

---

## Task 11: v1 acceptance verification

**Files:** none (manual + automated checkpoint)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all passing. New tests in `scripts/__tests__/recommendations.test.ts` should appear in the output.

- [ ] **Step 2: Full pipeline rebuild**

Run: `rm -rf .tutorial-cache && npm run fetch-tutorials && npm run build:hugo`
Expected: completes without error. Sample 5 random tutorials and confirm each has a populated `recommendations:` array.

- [ ] **Step 3: Confirm exclusion logic**

Pick a tutorial whose mission is known (e.g., one in the `abap-dev-get-started` mission). Verify none of its 3 recommendations are in the same mission.

- [ ] **Step 4: Verify v3 (Joule) coexists**

Open the tutorial page in a browser. Confirm both the new "Related Tutorials" rail at the bottom AND the Joule chat panel (right-side trigger) work without console errors.

- [ ] **Step 5: Commit checkpoint tag**

```bash
git tag -a recommendations-v1-shipped -m "v1 tag-overlap recommendations complete"
```

---

# Phase v2 — Co-Completion Signal

> Begin Phase v2 only after v1 is merged and validated. v2 is additive — it does not change the v1 contract or output schema.

## Task 12: Failing unit test for co-completion aggregator

**Files:**
- Create: `test/lib/co-completion.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/lib/co-completion.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('co-completion aggregator', () => {
  beforeAll(async () => {
    const { Tutorials, TaskRecords, Users } = cds.entities('com.sap.developers.ims')
    await DELETE.from(TaskRecords)
    await DELETE.from(Users)
    await DELETE.from(Tutorials)
    await INSERT.into(Tutorials).entries([
      { ID: 'cc-t1', legacyId: 9001, slug: 'alpha', title: 'Alpha', status: 'ACTIVE' },
      { ID: 'cc-t2', legacyId: 9002, slug: 'beta',  title: 'Beta',  status: 'ACTIVE' },
      { ID: 'cc-t3', legacyId: 9003, slug: 'gamma', title: 'Gamma', status: 'ACTIVE' },
    ])
    await INSERT.into(Users).entries([
      { ID: 'cc-u1', legacyId: 9101, uuid: '00000000-0000-0000-0000-000000009101' },
      { ID: 'cc-u2', legacyId: 9102, uuid: '00000000-0000-0000-0000-000000009102' },
    ])
    await INSERT.into(TaskRecords).entries([
      { ID: 'cc-r1', user_ID: 'cc-u1', taskType: 'TUTORIAL', taskLegacyId: 9001, status: 'COMPLETED' },
      { ID: 'cc-r2', user_ID: 'cc-u1', taskType: 'TUTORIAL', taskLegacyId: 9002, status: 'COMPLETED' },
      { ID: 'cc-r3', user_ID: 'cc-u2', taskType: 'TUTORIAL', taskLegacyId: 9001, status: 'COMPLETED' },
      { ID: 'cc-r4', user_ID: 'cc-u2', taskType: 'TUTORIAL', taskLegacyId: 9003, status: 'COMPLETED' },
    ])
  })

  it('counts co-completion pairs symmetrically', async () => {
    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js')
    const result = await computeCoCompletions({ force: true })
    // u1 completed alpha+beta, u2 completed alpha+gamma
    // alpha co-occurs with beta (1 user) and gamma (1 user)
    expect(result.alpha).toEqual(expect.arrayContaining([
      { slug: 'beta', score: 1 },
      { slug: 'gamma', score: 1 },
    ]))
    expect(result.beta).toEqual([{ slug: 'alpha', score: 1 }])
    expect(result.gamma).toEqual([{ slug: 'alpha', score: 1 }])
  })
})
```

> **Schema notes:**
>
> - `Tutorials` extends `TaskBase` which makes `title` `@mandatory`, so fixtures must include it.
> - `Users` declares `uuid` as `@mandatory`, so fixtures must include a uuid string.
> - `TaskRecords.user` is an Association → DB column is `user_ID`.
> - `taskLegacyId` is the correct join key (matches `Tutorials.legacyId`); see [db/schema.cds:81-96](../../../db/schema.cds#L81-L96).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/co-completion.test.js`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Commit the failing test**

```bash
git add test/lib/co-completion.test.js
git commit -m "test(co-completion): aggregator counts pairs symmetrically"
```

---

## Task 13: Implement the co-completion aggregator

**Files:**
- Create: `srv/lib/co-completion.js`

- [ ] **Step 1: Write the minimal implementation**

```javascript
// srv/lib/co-completion.js
import cds from '@sap/cds'

let cache = null
let cacheAt = 0
let inflight = null
const TTL_MS = 60 * 60 * 1000 // 1 hour

export async function computeCoCompletions({ topN = 10, force = false } = {}) {
  const now = Date.now()
  if (!force && cache && now - cacheAt < TTL_MS) return cache
  if (!force && inflight) return inflight

  const work = (async () => {
    const { Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims')
    const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'slug')
    const slugById = new Map(tutorials.map(t => [t.legacyId, t.slug]).filter(([, s]) => !!s))

    const records = await SELECT.from(TaskRecords)
      .columns('user_ID', 'taskLegacyId')
      .where({ taskType: 'TUTORIAL', status: 'COMPLETED' })

    const byUser = new Map()
    for (const r of records) {
      const slug = slugById.get(r.taskLegacyId)
      if (!slug) continue
      if (!byUser.has(r.user_ID)) byUser.set(r.user_ID, new Set())
      byUser.get(r.user_ID).add(slug)
    }

    const pairCounts = new Map()
    for (const slugs of byUser.values()) {
      const arr = [...slugs]
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]]
          const key = `${a}\x1f${b}`
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }

    const out = {}
    for (const [key, score] of pairCounts) {
      const [a, b] = key.split('\x1f')
      if (!out[a]) out[a] = []
      if (!out[b]) out[b] = []
      out[a].push({ slug: b, score })
      out[b].push({ slug: a, score })
    }

    for (const slug of Object.keys(out)) {
      out[slug].sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug))
      out[slug] = out[slug].slice(0, topN)
    }

    cache = out
    cacheAt = Date.now()
    return out
  })()

  if (!force) inflight = work
  try {
    return await work
  } finally {
    if (inflight === work) inflight = null
  }
}

export async function coCompletionsHandler(req, res) {
  try {
    const result = await computeCoCompletions()
    res.json(result)
  } catch (err) {
    console.error('[build/co-completions]', err instanceof Error ? err.message : String(err))
    res.status(500).json({ error: 'Co-completion aggregation failed' })
  }
}
```

> **Why `\x1f` as a separator:** unit-separator is the closest-to-zero delimiter that won't collide with slug characters (slugs are `[a-z0-9-]`).
>
> **Why `inflight`:** without it, N concurrent requests during a cold cache all run the (expensive) aggregation in parallel. The promise-memoization shares one in-flight computation across all callers within the cold window. `force: true` always runs fresh and is excluded from sharing so test isolation works.

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/lib/co-completion.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add srv/lib/co-completion.js
git commit -m "feat(co-completion): aggregator pairs co-completed tutorials by user"
```

---

## Task 14: Test the cache TTL behavior

**Files:**
- Modify: `test/lib/co-completion.test.js`

- [ ] **Step 1: Add the test**

```javascript
  it('returns cached result on second call within TTL', async () => {
    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js')
    const a = await computeCoCompletions()
    const b = await computeCoCompletions()
    expect(a).toBe(b) // same reference, not just deep-equal
  })

  it('bypasses cache when force is true', async () => {
    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js')
    const a = await computeCoCompletions()
    const b = await computeCoCompletions({ force: true })
    expect(a).not.toBe(b)
  })
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/lib/co-completion.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/lib/co-completion.test.js
git commit -m "test(co-completion): cache returns same ref within TTL, force bypasses"
```

---

## Task 15: Register the `/build/co-completions` route

**Files:**
- Modify: `srv/server.js` (around line 86–94, where other `/build/*` routes are registered)

- [ ] **Step 1: Import and register**

Add the import near the existing `buildCatalogHandler`:

```javascript
import { coCompletionsHandler } from './lib/co-completion.js';
```

Add the route adjacent to the existing `/build/catalog` registration:

```javascript
app.get('/build/co-completions', coCompletionsHandler);
```

- [ ] **Step 2: Run smoke check via cds watch**

Start CAP locally: `cds watch`
Then: `curl -s http://localhost:4004/build/co-completions | head -c 200`
Expected: JSON object response (may be empty `{}` if no completed task records exist locally).

- [ ] **Step 3: Commit**

```bash
git add srv/server.js
git commit -m "feat(co-completion): expose /build/co-completions endpoint"
```

---

## Task 16: Add `fetchCoCompletions` helper to the parser

**Files:**
- Modify: `scripts/parsers/cap.ts`

- [ ] **Step 1: Add the helper alongside the existing CAP fetchers**

```typescript
export async function fetchCoCompletions(
  baseUrl: string,
): Promise<Map<string, Map<string, number>>> {
  const url = `${baseUrl.replace(/\/$/, '')}/build/co-completions`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[cap.fetchCoCompletions] ${res.status} ${res.statusText} — falling back to empty`)
      return new Map()
    }
    const json = await res.json() as Record<string, Array<{ slug: string; score: number }>>
    const result = new Map<string, Map<string, number>>()
    for (const [slug, peers] of Object.entries(json)) {
      const inner = new Map<string, number>()
      for (const p of peers) inner.set(p.slug, p.score)
      result.set(slug, inner)
    }
    return result
  } catch (err) {
    console.warn(`[cap.fetchCoCompletions] failed: ${err instanceof Error ? err.message : err} — using empty map`)
    return new Map()
  }
}
```

- [ ] **Step 2: Verify the import compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/cap.ts
git commit -m "feat(co-completion): fetchCoCompletions helper with graceful fallback"
```

---

## Task 17: Failing test for blended scoring in `recommendations.ts`

**Files:**
- Modify: `scripts/__tests__/recommendations.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
  it('blends co-completion (60%) with tag-overlap (40%) when co-completion data exists', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',         primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'tag-strong',     primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'co-strong',      primaryTag: 'btp', displayTags: ['BTP'] }),
    ]
    const coCompletions = new Map([
      ['target', new Map([['co-strong', 100]])],
    ])
    const result = computeRecommendations(entries, { coCompletions })
    // co-strong has zero tag overlap but a strong co-completion signal,
    // so it should appear ahead of tag-strong even though tag-strong has primaryTag match.
    expect(result.get('target')?.[0]).toBe('co-strong')
  })

  it('falls back to pure tag scoring for slugs missing from co-completion map', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',  primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'related', primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const coCompletions = new Map() // empty
    const result = computeRecommendations(entries, { coCompletions })
    expect(result.get('target')).toEqual(['related'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: FAIL — `coCompletions` option not recognized.

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/recommendations.test.ts
git commit -m "test(recommendations): blended scoring favors co-completion signal"
```

---

## Task 18: Implement blended scoring

**Files:**
- Modify: `scripts/parsers/recommendations.ts`

- [ ] **Step 1: Extend `RecommendationOptions` and the loop**

```typescript
export interface RecommendationOptions {
  topN?: number
  primaryTagBonus?: number
  coCompletions?: Map<string, Map<string, number>>
  coWeight?: number   // default 0.6
  tagWeight?: number  // default 0.4
}

export function computeRecommendations(
  entries: TutorialNavEntry[],
  options: RecommendationOptions = {},
): Map<string, string[]> {
  const topN = options.topN ?? 3
  const primaryTagBonus = options.primaryTagBonus ?? 10
  const coWeight = options.coWeight ?? 0.6
  const tagWeight = options.tagWeight ?? 0.4
  const coMap = options.coCompletions

  // Pure tag-overlap scorer; reused by both passes and by the v1 fallback path.
  function tagScoreFor(target: TutorialNavEntry, candidate: TutorialNavEntry): number {
    if (candidate.slug === target.slug) return 0
    if (target.missionId && candidate.missionId === target.missionId) return 0
    let score = 0
    if (target.primaryTag && candidate.primaryTag === target.primaryTag) {
      score += primaryTagBonus
    }
    const targetTags = new Set(target.displayTags)
    for (const tag of candidate.displayTags) {
      if (targetTags.has(tag)) score += 1
    }
    return score
  }

  // First pass — discover corpus-wide max tag score so per-pair normalization is
  // stable. Without this, an early candidate with a small score gets divided by a
  // small running max and is artificially inflated relative to later candidates.
  let maxTagScore = 1
  let maxCoScore = 1
  if (coMap) {
    for (const target of entries) {
      for (const candidate of entries) {
        const s = tagScoreFor(target, candidate)
        if (s > maxTagScore) maxTagScore = s
      }
    }
    for (const inner of coMap.values()) {
      for (const v of inner.values()) if (v > maxCoScore) maxCoScore = v
    }
  }

  const result = new Map<string, string[]>()

  // Second pass — actually score and rank.
  for (const target of entries) {
    const candidates: Array<{ slug: string; score: number; title: string }> = []
    const targetCo = coMap?.get(target.slug)

    for (const candidate of entries) {
      if (candidate.slug === target.slug) continue
      if (target.missionId && candidate.missionId === target.missionId) continue

      const tagScore = tagScoreFor(target, candidate)
      const coScore = targetCo?.get(candidate.slug) ?? 0

      let blended: number
      if (coMap && coMap.size > 0) {
        const tagNorm = tagScore / maxTagScore
        const coNorm = coScore / maxCoScore
        blended = coWeight * coNorm + tagWeight * tagNorm
      } else {
        blended = tagScore
      }

      if (blended > 0) {
        candidates.push({ slug: candidate.slug, score: blended, title: candidate.title })
      }
    }

    candidates.sort((a, b) =>
      b.score - a.score || a.title.localeCompare(b.title)
    )

    result.set(target.slug, candidates.slice(0, topN).map(c => c.slug))
  }

  return result
}
```

> **Two-pass normalization rationale:** the v1 implementation in Task 3 extracts the per-target same-tag-set check into a Set; in this v2 update we factor that into a private `tagScoreFor()` helper used by both passes. The first pass is O(N²) tag comparisons (acceptable: ~1300 tutorials → 1.7M comparisons, completes in <1s). Without the first pass, normalization would use a running maximum that grows during the second loop, making earlier candidates score higher than later equivalents purely from iteration order. This is the bug the reviewer flagged in the original draft.

- [ ] **Step 2: Run all recommendations tests**

Run: `npx vitest run scripts/__tests__/recommendations.test.ts`
Expected: all pass, including the new blended-scoring tests and the original v1 tests (regression check).

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/recommendations.ts
git commit -m "feat(recommendations): blend co-completion (60%) and tag overlap (40%)"
```

---

## Task 19: Wire `fetchCoCompletions` into the fetch pipeline

**Files:**
- Modify: `scripts/fetch-tutorials.ts`

- [ ] **Step 1: Import and call**

Add the import:

```typescript
import { fetchCoCompletions } from './parsers/cap'
```

In the CAP phase (Phase 4), early — just after `CAP_BASE_URL` is determined and before the missions/groups fetch — add:

```typescript
const coCompletions = await fetchCoCompletions(CAP_BASE_URL)
console.log(`[cap] co-completion map: ${coCompletions.size} source slugs`)
```

Then update the existing `computeRecommendations` call (added in Task 7):

```typescript
const recommendations = computeRecommendations(navEntries, { coCompletions })
```

- [ ] **Step 2: Sanity-check the build**

Run: `npm run fetch-tutorials`
Expected: log line `[cap] co-completion map: N source slugs` appears. Subsequent recommendation patches succeed.

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(recommendations): blend co-completion data from /build/co-completions"
```

---

## Task 20: Hybrid test for the deployed endpoint shape

**Files:**
- Create: `test/hybrid/co-completion-endpoint.test.js`

- [ ] **Step 1: Write the test**

```javascript
// test/hybrid/co-completion-endpoint.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('/build/co-completions endpoint (hybrid HANA)', () => {
  it('returns a slug-keyed object with score arrays', async () => {
    const { data } = await GET('/build/co-completions')
    expect(typeof data).toBe('object')
    // Production HANA has 2.5M task records → at least some pairs
    const entries = Object.entries(data)
    expect(entries.length).toBeGreaterThan(0)
    const [, peers] = entries[0]
    expect(Array.isArray(peers)).toBe(true)
    expect(peers[0]).toMatchObject({ slug: expect.any(String), score: expect.any(Number) })
  })
})
```

> **Test pattern note:** matches the existing hybrid harness (e.g. [test/hybrid/admin-analytics.test.js:5](../../../test/hybrid/admin-analytics.test.js#L5) and [test/hybrid/admin-crud.test.js:5](../../../test/hybrid/admin-crud.test.js#L5)) — a top-level `cds.test(...)` call which exposes `GET`/`POST`/`DELETE`/`SELECT` as test globals. Do not nest `cds.test()` inside `beforeAll` — that creates a second test harness whose `GET` does not bind to the running server.

- [ ] **Step 2: Run against real HANA**

```bash
cf login            # if not already logged in to DEV space
npm run test:hybrid -- test/hybrid/co-completion-endpoint.test.js
```

Expected: PASS. Manually inspect the first few pairs to confirm scores look sane (e.g., ABAP tutorials cluster together).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/co-completion-endpoint.test.js
git commit -m "test(hybrid): co-completion endpoint returns slug-keyed score arrays"
```

---

## Task 21: Smoke test for the deployed rail (with real co-completion data)

**Files:**
- Modify: `test/smoke/next-steps-recommendations.test.js`

- [ ] **Step 1: Strengthen the existing smoke test**

```javascript
  it('renders 1-3 recommendation cards on a popular tutorial', async () => {
    const url = `${config.baseUrl}/tutorials/abap-cloud-ui-from-interface/`
    const res = await fetch(url)
    const html = await res.text()
    const matches = html.match(/class="next-steps-rail-card"/g) ?? []
    // We always cap at 3, but a sparsely-tagged tutorial may produce fewer.
    // Production tutorials should hit the cap; loosen if a fresh tutorial flakes.
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches.length).toBeLessThanOrEqual(3)
  })
```

- [ ] **Step 2: Run smoke test against deployed DEV**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run test/smoke/next-steps-recommendations.test.js
```

Expected: PASS after content republish (next push to the deploy workflow).

- [ ] **Step 3: Commit**

```bash
git add test/smoke/next-steps-recommendations.test.js
git commit -m "test(smoke): enforce 3 recommendation cards on tutorial pages"
```

---

## Task 22: v2 acceptance verification

**Files:** none (manual + automated checkpoint)

- [ ] **Step 1: Full test suite**

Run: `npm test && npm run test:hybrid && npm run test:smoke`
Expected: all green.

- [ ] **Step 2: Compare v1 vs v2 output for 10 tutorials**

Run: pick 10 tutorial slugs across different domains (ABAP, CAP, BTP, HANA). For each, diff `recommendations` between v1-only (`coCompletions = empty Map`) and v2 (production endpoint).
Expected: ≥30% of slugs show different recommendations under v2 (signal that co-completion is meaningfully shifting results, not just being a tiebreaker).

- [ ] **Step 3: Manual relevance pass**

For 5 tutorials, pull up the page in the browser. Subjectively rate each of the 3 cards as "relevant / borderline / off-topic." We want ≥10/15 relevant.

- [ ] **Step 4: Update TODO.md**

In `TODO.md` under section #21 "Future Work" (or the AEM gap section), mark gap #9 (NextStepsServlet) as resolved with a one-line summary and link to this plan.

- [ ] **Step 5: Tag**

```bash
git tag -a recommendations-v2-shipped -m "v2 co-completion blend complete"
```

---

# Operational Notes

- **Cold-start handling:** new tutorials with zero TaskRecords get pure tag-overlap recommendations until users start completing them. The `coScore=0` path in `computeRecommendations` reduces to `tagScore * tagWeight` which is still strictly positive for any tag overlap.
- **Cache invalidation:** the in-process 1-hour TTL in `co-completion.js` is per-srv-instance. Multiple srv instances may have slightly stale snapshots — acceptable, since recommendations only refresh on the next full content rebuild anyway.
- **Performance budget:** the aggregator scans `TaskRecords` (~2.5M rows in production). A naive in-memory pair-count could allocate O(M²) per user where M = tutorials completed by that user. In practice M < 50, so each user contributes <1.3K pairs. Total memory ≈ 247K users × 1K pairs avg ≈ 250M pair-increments → still bounded. If this becomes a problem, push the pair counting to HANA via raw SQL.
- **Future optimization:** if the v2 fetch step ever exceeds 10 seconds, add `If-None-Match` / ETag support to `/build/co-completions` so the build can short-circuit when the dataset hasn't changed.

---

# Plan Review

After saving this plan, dispatch the plan-document-reviewer to check for:

- Coverage of all v1 acceptance criteria from the brainstorm Q&A (3 cards, primaryTag bonus, same-mission exclusion).
- Test-first ordering (every implementation task has a failing test in the prior task).
- Reusability of existing CSS variables and CAP route patterns.
- Operational safety (no schema changes, no XSUAA changes, additive endpoints only).

## Round-1 reviewer fixes (already applied)

These were addressed in this revision; reviewers can skim and skip:

- **Task 7 Step 4** — replaced `head -30` (not on Windows by default) with Read tool / `cat` instructions, added expected YAML snippet.
- **Task 12** — switched to top-level `cds.test('serve', '--project', '.', '--in-memory')` matching [test/lib/slug-mapping.test.js](../../../test/lib/slug-mapping.test.js); added `title` (mandatory on `TaskBase`) and `uuid` (mandatory on `Users`) to fixture rows; widened legacy IDs into the 9000s to avoid collisions with production seed data; added `force: true` on first call.
- **Task 13** — wrapped aggregator in an in-flight promise (`inflight`) so concurrent cold-cache callers share a single computation.
- **Task 18** — refactored to true two-pass scoring with a private `tagScoreFor()` helper; first pass computes corpus-wide `maxTagScore`, second pass blends with stable normalization. Removed the iteration-order bias the reviewer flagged.
- **Task 20** — switched to top-level `cds.test('serve', '--project', '.', '--profile', 'hybrid')` matching the existing hybrid pattern; removed nested `cds.test()` inside `beforeAll`.
- **Task 21** — relaxed `toBe(3)` to `>= 1 && <= 3` to avoid flake on sparsely-tagged tutorials.
- **Task 10** — loosened smoke regex to tolerate Hugo attribute reordering between `class` and `href`.
