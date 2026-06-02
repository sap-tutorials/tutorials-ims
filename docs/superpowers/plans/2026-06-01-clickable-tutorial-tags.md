# Clickable Tutorial Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the experience and topic/product chips on the U1 Object Page clickable so each click navigates to `/tutorials/?level=<v>` or `/tutorials/?tag=<slug>` with the right facet pre-applied on the navigator.

**Architecture:** Two surfaces. (1) Hugo template + scoped CSS in `hugo/layouts/tutorials/u1-object-page.html` converts the chips into anchors with `aria-label` and a `.op-chip--link` modifier. (2) Vue navigator at `hugo-apps/src/navigator/TutorialNavigator.vue` extends its `onMounted` URL-param block to read `?tag` (multi-value via `getAll`) into `filters.products` and `?level` into `filters.levels`. The existing reactive watcher re-runs the OData query — no new wiring.

**Tech Stack:** Hugo (Go templates), Vue 3 + TypeScript (composition API), Vitest (`unit` project for navigator + `smoke` project for rendered HTML), `@vue/test-utils` with `happy-dom`.

**Spec:** [docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md](../specs/2026-06-01-clickable-tutorial-tags-design.md)
**Issue:** [sap-tutorials/tutorials-ims#161](https://github.com/sap-tutorials/poc/issues/161)
**Branch:** `feature/issue-161-clickable-tutorial-tags` (already created)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `hugo/layouts/tutorials/u1-object-page.html` | Modify (lines 36–52 CSS, 206–214 chip block) | Render experience + topic/product chips as anchors with `op-chip--link` modifier; preserve `License` skip and `displayTagSlugs` defensive fallback. |
| `hugo-apps/src/navigator/TutorialNavigator.vue` | Modify (lines 42–44 `onMounted`) | Parse `?tag` (repeatable) and `?level` (repeatable, validated) and seed `filters.products` / `filters.levels`. |
| `hugo-apps/src/navigator/url-params.ts` | Create | Pure helpers `parseTagParams(searchParams)` and `parseLevelParams(searchParams)` so the logic is unit-testable without mounting the heavy navigator component. |
| `hugo-apps/src/navigator/url-params.test.ts` | Create | Vitest unit tests covering: single value, multi-value, URL-encoded `>`, mixed-case level normalisation, unknown-level rejection, empty/missing params. |
| `test/smoke/clickable-chips.smoke.test.ts` | Create | Smoke against deployed: tutorial page emits `<a>` chip with correct `?tag=` and `?level=` hrefs and `op-chip--link` class. Quote-stripping tolerant. |
| `docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md` | (Already committed) | Reference only — no edits in this plan. |

---

## Task 1: Pure URL-param parser (TDD)

Build the parser as a pure function first so we can unit-test it cheaply without mounting the whole navigator (which fetches `/tutorials/_nav.json`, `/build/navigator`, `/build/my-progress` and pulls in UI5 web components).

**Files:**
- Create: `hugo-apps/src/navigator/url-params.ts`
- Test: `hugo-apps/src/navigator/url-params.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/navigator/url-params.test.ts`:

```ts
// hugo-apps/src/navigator/url-params.test.ts
//
// Issue #161 — pure parsers used by TutorialNavigator.vue's onMounted
// block to seed filters.products / filters.levels from URL query params.
// Kept as a pure module so the heavy Vue mount isn't required for unit
// coverage of URL handling. The component-level wiring is exercised by
// the smoke test in test/smoke/clickable-chips.smoke.test.ts.

import { describe, it, expect } from 'vitest'
import { parseTagParams, parseLevelParams } from './url-params'

describe('parseTagParams', () => {
  it('returns [] when no tag param is present', () => {
    const sp = new URLSearchParams('q=foo')
    expect(parseTagParams(sp)).toEqual([])
  })

  it('returns the single decoded slug for ?tag=topic%3Eabap-development', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual(['topic>abap-development'])
  })

  it('returns every value when ?tag is repeated', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development&tag=software-product%3Esap-hana')
    expect(parseTagParams(sp)).toEqual([
      'topic>abap-development',
      'software-product>sap-hana',
    ])
  })

  it('drops empty string values', () => {
    const sp = new URLSearchParams('tag=&tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual(['topic>abap-development'])
  })

  it('preserves duplicates as-is (caller dedupes)', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development&tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual([
      'topic>abap-development',
      'topic>abap-development',
    ])
  })
})

describe('parseLevelParams', () => {
  it('returns [] when no level param is present', () => {
    expect(parseLevelParams(new URLSearchParams(''))).toEqual([])
  })

  it.each(['beginner', 'intermediate', 'advanced'])(
    'accepts the canonical level %s',
    (lvl) => {
      const sp = new URLSearchParams(`level=${lvl}`)
      expect(parseLevelParams(sp)).toEqual([lvl])
    },
  )

  it('lowercases mixed-case input', () => {
    const sp = new URLSearchParams('level=Beginner')
    expect(parseLevelParams(sp)).toEqual(['beginner'])
  })

  it('drops unknown level values silently', () => {
    const sp = new URLSearchParams('level=expert&level=beginner')
    expect(parseLevelParams(sp)).toEqual(['beginner'])
  })

  it('drops empty string values', () => {
    const sp = new URLSearchParams('level=&level=advanced')
    expect(parseLevelParams(sp)).toEqual(['advanced'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/navigator/url-params.test.ts`
Expected: FAIL — `Cannot find module './url-params'` (or equivalent resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/navigator/url-params.ts`:

```ts
// hugo-apps/src/navigator/url-params.ts
//
// Issue #161 — URL → filter parsers consumed by TutorialNavigator.vue's
// onMounted block. Kept pure (no Vue refs, no DOM access) so they can
// be unit-tested without mounting the navigator component. See
// url-params.test.ts for the contract.

const VALID_LEVELS = new Set(['beginner', 'intermediate', 'advanced'])

/**
 * Pull every `?tag=…` value out of a URLSearchParams. Empty strings are
 * dropped; duplicates are preserved (the caller is responsible for any
 * dedupe — TutorialNavigator pushes only when not already present).
 *
 * URL decoding is handled by URLSearchParams itself, so a slug like
 * `topic>abap-development` round-trips through `?tag=topic%3Eabap-development`
 * without manual encoding.
 */
export function parseTagParams(searchParams: URLSearchParams): string[] {
  return searchParams.getAll('tag').filter((s) => s.length > 0)
}

/**
 * Pull every `?level=…` value, lowercase, and reject anything outside the
 * canonical experience set. Unknown values (legacy AEM strings, typos)
 * are dropped silently rather than producing a bogus filter chip.
 */
export function parseLevelParams(searchParams: URLSearchParams): string[] {
  return searchParams
    .getAll('level')
    .map((s) => s.toLowerCase())
    .filter((s) => VALID_LEVELS.has(s))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/navigator/url-params.test.ts`
Expected: PASS — all 11 cases green.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/url-params.ts hugo-apps/src/navigator/url-params.test.ts
git commit -m "feat(navigator): add pure URL-param parsers for tag/level (#161)"
```

---

## Task 2: Wire parser into navigator's `onMounted`

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (lines 42–44)

- [ ] **Step 1: Read the current `onMounted` block**

Run: `sed -n '40,50p' hugo-apps/src/navigator/TutorialNavigator.vue`

Expected today:
```
onMounted(async () => {
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  if (initialQuery) searchQuery.value = initialQuery

  const [navRes, catalogRes, progRes] = await Promise.all([
```

- [ ] **Step 2: Add the import at the top of the `<script setup>` block**

Locate the existing imports block at the top of `hugo-apps/src/navigator/TutorialNavigator.vue` (`<script setup lang="ts">`). Add a new import line alongside other relative imports such as `useSearch`:

```ts
import { parseTagParams, parseLevelParams } from './url-params'
```

- [ ] **Step 3: Extend the `onMounted` block**

Replace the existing two-line `?q=` parse with the four-block version. Old:

```ts
onMounted(async () => {
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  if (initialQuery) searchQuery.value = initialQuery
```

New:

```ts
onMounted(async () => {
  const params = new URL(window.location.href).searchParams

  const initialQuery = params.get('q')
  if (initialQuery) searchQuery.value = initialQuery

  // Issue #161: deep-link from clickable tutorial-page chips. We push into
  // the existing reactive filter state; the watcher in useSearch re-runs
  // the OData query for free.
  for (const slug of parseTagParams(params)) {
    if (!filters.products.includes(slug)) filters.products.push(slug)
  }
  for (const lvl of parseLevelParams(params)) {
    if (!filters.levels.includes(lvl)) filters.levels.push(lvl)
  }
```

- [ ] **Step 4: Verify the file still type-checks**

Run: `npx vue-tsc --noEmit -p hugo-apps/tsconfig.json 2>&1 | tail -20`

If `hugo-apps/tsconfig.json` does not exist, fall back to:

Run: `npx tsc --noEmit hugo-apps/src/navigator/url-params.ts hugo-apps/src/navigator/TutorialNavigator.vue 2>&1 | tail -20` (Vue file may show warnings — only treat errors that mention the new code as blocking).

Expected: no errors referencing `parseTagParams`, `parseLevelParams`, `filters.products`, or `filters.levels`.

- [ ] **Step 5: Run the existing navigator unit tests to confirm no regression**

Run: `npx vitest run --project unit hugo-apps/src/navigator`
Expected: every existing test still passes; new `url-params.test.ts` cases also pass.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "feat(navigator): seed filters from ?tag and ?level on mount (#161)"
```

---

## Task 3: Make experience chip clickable

Convert the `level` and legacy `experienceLevel` chips into anchors. Keep the existing icon and text; add `aria-label` and `op-chip--link` modifier. Both chips link to `/tutorials/?level=<lowercased value>`.

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (line 206–207)

- [ ] **Step 1: Read the current chip strip**

Run: `sed -n '205,220p' hugo/layouts/tutorials/u1-object-page.html`

- [ ] **Step 2: Replace the experience chip lines**

Find:

```html
{{ with .Params.level }}<span class="op-chip"><span class="op-chip__icon">🎓</span>{{ . }}</span>{{ end }}
{{ with .Params.experienceLevel }}<span class="op-chip"><span class="op-chip__icon">🎓</span>{{ . }}</span>{{ end }}
```

Replace with:

```html
{{ with .Params.level }}<a class="op-chip op-chip--link" href="{{ "/tutorials/" | relURL }}?level={{ . | lower | urlquery }}" aria-label="Filter tutorials by experience: {{ . }}"><span class="op-chip__icon">🎓</span>{{ . }}</a>{{ end }}
{{ with .Params.experienceLevel }}<a class="op-chip op-chip--link" href="{{ "/tutorials/" | relURL }}?level={{ . | lower | urlquery }}" aria-label="Filter tutorials by experience: {{ . }}"><span class="op-chip__icon">🎓</span>{{ . }}</a>{{ end }}
```

- [ ] **Step 3: Render the page locally and confirm the anchor**

Run: `npm run dev`
Open: `http://localhost:1313/tutorials/<any-slug>/`
Inspect the experience chip — it should be an `<a>` with the two attributes.

Then stop the dev server (`Ctrl-C`).

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(tutorial-page): make experience chip clickable (#161)"
```

---

## Task 4: Make topic/product tag chips clickable

Convert the `displayTags` loop and the `primaryTag` fallback into anchors. Use `index $.Params.displayTagSlugs $i` to look up the parallel slug — if it's missing for a label, render a static `<span>` instead of a broken link.

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (lines 209–214)

- [ ] **Step 1: Replace the chip-tag block**

Find:

```html
{{/* Prefer human-readable displayTags; fall back to raw primaryTag if none provided. */}}
{{ if .Params.displayTags }}
  {{ range .Params.displayTags }}{{ if ne . "License" }}<span class="op-chip op-chip--tag">{{ . }}</span>{{ end }}{{ end }}
{{ else if .Params.primaryTag }}
  <span class="op-chip op-chip--tag">{{ .Params.primaryTag }}</span>
{{ end }}
```

Replace with:

```html
{{/* Prefer human-readable displayTags zipped with displayTagSlugs; fall back to raw primaryTag.
     #161 — chips are <a> anchors that deep-link to /tutorials/?tag=<slug>. The "License" label
     is intentionally label-matched (not slug-matched) to preserve existing chip-strip behaviour;
     see docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md. */}}
{{ if .Params.displayTags }}
  {{ $slugs := .Params.displayTagSlugs }}
  {{ range $i, $label := .Params.displayTags }}
    {{ if ne $label "License" }}
      {{ $slug := "" }}
      {{ if and $slugs (lt $i (len $slugs)) }}{{ $slug = index $slugs $i }}{{ end }}
      {{ if $slug }}
        <a class="op-chip op-chip--tag op-chip--link" href="{{ "/tutorials/" | relURL }}?tag={{ $slug | urlquery }}" aria-label="Filter tutorials by {{ $label }}">{{ $label }}</a>
      {{ else }}
        <span class="op-chip op-chip--tag">{{ $label }}</span>
      {{ end }}
    {{ end }}
  {{ end }}
{{ else if .Params.primaryTag }}
  <a class="op-chip op-chip--tag op-chip--link" href="{{ "/tutorials/" | relURL }}?tag={{ .Params.primaryTag | urlquery }}" aria-label="Filter tutorials by {{ .Params.primaryTag }}">{{ .Params.primaryTag }}</a>
{{ end }}
```

- [ ] **Step 2: Render the page locally**

Run: `npm run dev`
Open: `http://localhost:1313/tutorials/abap-create-basic-app/`
Confirm:
- Each topic/product chip is an `<a>` with `class="op-chip op-chip--tag op-chip--link"`.
- `href` looks like `/tutorials/?tag=topic%3Eabap-development` (or the deployed equivalent).
- The `License` chip (if the tutorial has one) is still suppressed.
- Clicking a chip lands on `/tutorials/` with the matching topic/product checkbox checked. (If the navigator hasn't been rebuilt, run `npm run build:hugo-apps` first; otherwise the change from Task 2 isn't bundled yet.)

Then stop the dev server.

- [ ] **Step 3: Rebuild navigator bundle so the URL parser is in `/js/navigator.js`**

Run: `npx vite build --config hugo-apps/vite.config.ts` (or whichever script the project uses — check `jq '.scripts | with_entries(select(.key | test("hugo-apps|vite|build")))' package.json` for the canonical name).

Expected: build completes; updated `hugo/static/js/navigator.js` is emitted. (Hugo serves it because `hugo/static/` is published verbatim.)

- [ ] **Step 4: Manually verify deep-link end-to-end on the running dev server**

Run: `npm run dev`
Open a tutorial → click a topic chip → confirm `/tutorials/?tag=…` lands with that product checkbox ticked. Click the experience chip → `/tutorials/?level=…` lands with that experience checkbox ticked.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html hugo/static/js/navigator.js hugo-apps/dist 2>/dev/null || true
git commit -m "feat(tutorial-page): make topic/product chips clickable (#161)"
```

(If the build artefacts are gitignored, only the template change will be committed — that's fine.)

---

## Task 5: Add hover and focus styles for linked chips

Add a `.op-chip--link` modifier in the scoped `<style>` block of `u1-object-page.html`. Anchor elements inherit several browser defaults (underline, blue color); we override those and add the Horizon focus ring on `:focus-visible`. Confirm static `<span class="op-chip">` chips do **not** inherit anchor styling (they shouldn't because we never declared `a.op-chip` rules — the new selectors are `.op-chip--link` only).

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (insert after the existing `.op-chip--tag` block, line 52)

- [ ] **Step 1: Insert the new CSS rules**

Find:

```css
.op-chip--tag {
  background: var(--sapButton_Lite_Background, transparent);
  border-color: var(--sapButton_Lite_BorderColor, var(--sapList_BorderColor));
}
```

Insert immediately after that closing brace:

```css
.op-chip--link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}
.op-chip--link:hover {
  background-color: var(--sapList_Hover_Background, rgba(0, 0, 0, 0.04));
  border-color: var(--sapList_Hover_BorderColor, var(--sapList_BorderColor));
}
.op-chip--link:focus-visible {
  outline: 2px solid var(--sapContent_FocusColor, #0070f2);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Reload the page and verify**

Run: `npm run dev`
Open a tutorial. Hover the chips: background tint visible. Tab to a chip: focus ring visible. The duration chip and progress ring still look exactly the same as before (no underline, no hover tint).

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "style(tutorial-page): hover + focus-visible styles for clickable chips (#161)"
```

---

## Task 6: Smoke test — assert rendered HTML contains the chip anchors

This complements the unit tests in Task 1 by verifying the entire pipeline (Hugo template → Hugo build → minifier → CDN) actually emits the expected anchor structure. Pattern matches `test/smoke/license-icon.test.js`.

**Files:**
- Create: `test/smoke/clickable-chips.smoke.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/clickable-chips.smoke.test.ts`:

```ts
// test/smoke/clickable-chips.smoke.test.ts
//
// Issue #161 — verifies the U1 Object Page renders experience and
// topic/product chips as anchors deep-linking to /tutorials/?level=...
// and /tutorials/?tag=... respectively. Pattern follows
// test/smoke/license-icon.test.js. Quote-stripping tolerant — the Hugo
// minifier removes quotes from safe attribute values, so regexes accept
// both `class="op-chip..."` and `class=op-chip...` forms; see
// [[feedback-hugo-minifier-strips-quotes]].

import { describe, it, expect, beforeAll } from 'vitest'
import { BASE_URL, fetchWithRetry } from './smoke.config.js'

// Stable witness slug — `abap-create-basic-app` exposes a `level`,
// `time`, multiple `displayTags`/`displayTagSlugs`, and a `primaryTag`.
const SLUG = process.env.SMOKE_CLICKABLE_CHIPS_SLUG ?? 'abap-create-basic-app'

describe(`Clickable chips on /tutorials/${SLUG}/ (#161)`, () => {
  let html: string

  beforeAll(async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${SLUG}/`)
    expect(res.status).toBe(200)
    html = await res.text()
  })

  it('renders the experience chip as an anchor with ?level=', () => {
    // Match the anchor regardless of attribute order or quote stripping.
    const anchor = html.match(
      /<a[^>]*class=["']?op-chip op-chip--link["']?[^>]*>[^<]*<span[^>]*op-chip__icon[^>]*>[^<]*<\/span>[^<]*<\/a>/,
    )
    expect(anchor, 'expected an experience chip anchor').toBeTruthy()
    expect(html).toMatch(/href=["']?[^"' >]*\/tutorials\/\?level=[a-z]+["']?/)
  })

  it('renders at least one topic/product chip as an anchor with ?tag=', () => {
    expect(html).toMatch(
      /<a[^>]*class=["']?op-chip op-chip--tag op-chip--link["']?[^>]*href=["']?[^"' >]*\/tutorials\/\?tag=[^"' >]+["']?/,
    )
  })

  it('URL-encodes the > in topic/product slugs', () => {
    // displayTagSlugs values contain `>`; urlquery emits %3E.
    expect(html).toMatch(/\?tag=[a-z0-9-]+%3E[a-z0-9-]+/i)
  })

  it('still suppresses any chip whose label is "License"', () => {
    // Same scope as license-icon.test.js — only chip-strip spans, ignore
    // step-body prose. Now must include anchors too.
    const linkChipMatches = html.match(
      /<(a|span)[^>]*class=["']?op-chip op-chip--tag(?: op-chip--link)?["']?[^>]*>([^<]*)<\/(?:a|span)>/g,
    ) || []
    const labels = linkChipMatches.map((m) => m.replace(/<[^>]+>/g, '').trim())
    expect(labels).not.toContain('License')
  })

  it('exposes a Filter-tutorials-by aria-label on each chip anchor', () => {
    expect(html).toMatch(/aria-label=["']?Filter tutorials by [^"'<>]+["']?/)
  })
})
```

- [ ] **Step 2: Run the smoke test against a deployed environment that does not yet have the change**

Run (with the current DEV that lacks the change):
```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run --project smoke test/smoke/clickable-chips.smoke.test.ts
```

Expected: FAIL — assertions about the anchor and `?level=` href don't match the current static-span output.

(If you are running this plan after the change is already deployed, this step will pass — that's also fine; it means the build already happens to be ahead. Note in the commit message and continue.)

- [ ] **Step 3: Build the Hugo site locally and run the smoke test against the local approuter**

The smoke project hits whatever URL `SMOKE_BASE_URL` resolves to. Build locally:

Run: `npm run fetch-tutorials && npm run build:all`

Then start the local approuter (per `docs/developers/getting-started.md`):
```bash
npm run start:approuter &
SMOKE_BASE_URL=http://localhost:5000 \
  npx vitest run --project smoke test/smoke/clickable-chips.smoke.test.ts
```

Expected: PASS — all five cases.

Stop the approuter (`kill %1` or `Ctrl-C`).

- [ ] **Step 4: Commit**

```bash
git add test/smoke/clickable-chips.smoke.test.ts
git commit -m "test(smoke): assert tutorial chip anchors deep-link correctly (#161)"
```

---

## Task 7: Final sanity pass

Catch the things subagent steps can drift on: file encoding, whole-suite regression, srv-qa packaging impact.

- [ ] **Step 1: Confirm modified files are still LF, not CRLF**

Run: `file hugo/layouts/tutorials/u1-object-page.html hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/url-params.ts hugo-apps/src/navigator/url-params.test.ts test/smoke/clickable-chips.smoke.test.ts`

Expected: every file says `ASCII text` or `Unicode text, UTF-8 text` — none say `with CRLF line terminators`. (Bit us before — see [[feedback-crlf-regression-on-windows]].) If any have CRLF, normalize:

```bash
node -e "for (const f of process.argv.slice(1)) require('fs').writeFileSync(f, require('fs').readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))" hugo/layouts/tutorials/u1-object-page.html hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/url-params.ts hugo-apps/src/navigator/url-params.test.ts test/smoke/clickable-chips.smoke.test.ts
```

- [ ] **Step 2: srv-qa cp-list audit**

This change touches no `srv/lib/*` modules, so the `.deploy/mta.yaml` srv-qa cp-list is unaffected. Confirm:

Run: `git diff main..HEAD -- srv/`
Expected: no output (no changes under `srv/`).

If the diff is non-empty, re-walk the cp-list per [[feedback-srv-qa-cp-list-recurring]].

- [ ] **Step 3: Run the full unit test suite**

Run: `npm test`
Expected: same baseline as before this plan started — no new failures. (Per [[feedback-worktree-tests-hang]], if `npm test` hangs silently in a worktree, cap with a 5-minute timeout: `timeout 300 npm test`. If it still hangs, defer the regression check to deployed-DEV smoke after merge.)

- [ ] **Step 4: Push the branch**

```bash
git branch --show-current  # Confirm: feature/issue-161-clickable-tutorial-tags
git push -u origin feature/issue-161-clickable-tutorial-tags
```

(Per [[feedback-verify-branch-before-commit]], run `git branch --show-current` in the same Bash invocation as any commit/push to abort if state has flipped.)

- [ ] **Step 5: Open a PR**

Run:
```bash
gh pr create \
  --base main \
  --title "feat: clickable tutorial-page tags (#161)" \
  --body "$(cat <<'EOF'
Closes #161.

Topic/product chips and the experience chip on the U1 Object Page are now anchors that deep-link to /tutorials/?tag=<slug> or /tutorials/?level=<value>. The navigator parses both params on mount and seeds filters.products / filters.levels.

Spec: docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md
Plan: docs/superpowers/plans/2026-06-01-clickable-tutorial-tags.md

## What changed

- hugo/layouts/tutorials/u1-object-page.html — chips → <a class="op-chip--link"> with aria-label and hover/focus styles. License skip preserved; defensive fallback to <span> when displayTagSlugs is missing.
- hugo-apps/src/navigator/url-params.ts — pure parsers parseTagParams / parseLevelParams.
- hugo-apps/src/navigator/TutorialNavigator.vue — onMounted seeds filters from ?tag and ?level.
- test/smoke/clickable-chips.smoke.test.ts — full-pipeline assertion that the rendered HTML emits the expected anchor structure.

## Out of scope

- Adding a duration facet to the navigator.
- Pushing navigator filter state back into the URL (separate enhancement).
EOF
)"
```

Expected: PR URL printed. Per [[feedback-pr-over-direct-merge]], do **not** fast-merge — wait for review.

- [ ] **Step 6: Mark plan tasks complete**

Update the spec acceptance checkboxes (`docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md`) to `[x]` for the criteria this PR satisfies. Commit on the same branch:

```bash
git add docs/superpowers/specs/2026-06-01-clickable-tutorial-tags-design.md
git commit -m "docs(spec): tick acceptance criteria for #161"
git push
```

---

## After merge

- Watch the deployed DEV smoke run for the `clickable-chips.smoke.test.ts` cases (CI runs it post-deploy).
- Click each chip on a real DEV tutorial page; confirm Daniel's acceptance: navigates to Search pre-filtered by that tag.
- If everything's green, tag Daniel for confirmation and close #161.
