# Concept Page Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade all 12 related-content sections on the ~6k concept landing pages from `<ul>`/`<li>` link lists to a responsive card grid, enriching the 4 internal cross-link sections with LOB-safe extra fields.

**Architecture:** Three layers in dependency order — (1) `srv/lib/published-concepts-query.js` adds extra plain columns to the existing `teaches`/`requires`/`requiredBy`/`relatedTo` selects; (2) `scripts/fetch-concepts.ts` emits those fields into Hugo frontmatter; (3) `hugo/layouts/concepts/single.html` renders each section as a card grid, styled by a new `.concept-card*` family appended to the postcss source `hugo/assets/css/sap-fundamental.css`. All existing behavior (telemetry hooks, hide-when-empty guards, link hardening, section attributes/titles/ordering) is preserved — only the wrapping markup changes.

**Tech Stack:** CAP Node.js (`cds.ql`), TypeScript (tsx fetcher), Hugo templates (Go templates), PostCSS, Vitest.

## Global Constraints

- **No NCLOB reads.** Never SELECT a `LargeString`/BLOB column alongside metadata (LOB-locator hazard). Tutorial `description` is NCLOB — do NOT read it. Only plain columns: `Tutorials.experienceTag` (`String(255)` enum), `Tutorials.stepCount` (`Integer`), `Concepts.description` (`String(500)`).
- **No raw SQL** — use `cds.ql` / CQL only (`.columns()`, `.where()`, `SELECT.from()`).
- **CSS: edit the source, not the output.** Edit `hugo/assets/css/sap-fundamental.css`; run `npm run build:css` to compile → `hugo/static/css/sap-fundamental.css` (the file `head.html` links). Never hand-edit the `static/` copy.
- **Preserve all invariants:** `data-kg-section` attributes, verbatim H2 titles, section ordering, `data-*-slug` telemetry hooks, `{{ with }}` hide-when-empty guards, `$isSafe` URL-scheme guard + `target="_blank" rel="noopener"`, `<span>` fallback for non-http(s) URLs, and the page-bottom delegated click JS (must keep matching `a[data-*-slug]`).
- **All colors via `--sap*` CSS vars with light fallbacks** so dark mode (`sap-horizon-dark.css` + `html.dark`) adapts automatically.
- **Empty-array YAML guard:** `refs()` must keep emitting ` []` (leading space) for empty arrays — `relatedTo:[]` (no space) is invalid YAML and fails the Hugo parser.
- **Fetcher frontmatter convention:** omit a key entirely when its array is empty/undefined; per-field `if` guards skip optional fields when absent.
- **Deployment (out of band):** applying to prod needs `npm run build:all` → `mbt build` → `cf deploy` for the approuter/CSS, PLUS `gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main -f mode=full` to re-render all ~6k pages. NEVER publish concept content from a workstation.

**Spec:** `docs/superpowers/specs/2026-07-12-concept-page-card-redesign-design.md`

---

## File Structure

- `srv/lib/published-concepts-query.js` — MODIFY: enrich 3 existing selects (teaches, outgoing edges, incoming edges) + their mappers with extra columns.
- `scripts/fetch-concepts.ts` — MODIFY: extend `ConceptPayload` interface + `refs()` helper to emit enriched cross-link fields.
- `test/unit/scripts/fetch-concepts-crosslinks.test.ts` — CREATE: unit tests for the enriched `refs()` emission.
- `test/hybrid/build-concepts.test.js` — MODIFY: assert the enriched contract shape.
- `hugo/assets/css/sap-fundamental.css` — MODIFY: append the `.concept-card*` family.
- `hugo/layouts/concepts/single.html` — MODIFY: convert all 12 sections `<ul>`/`<li>` → card grid.

---

## Task 1: Enrich backend query with cross-link fields

**Files:**
- Modify: `srv/lib/published-concepts-query.js` (teaches select ~L94-112, outgoing edges ~L114-145, incoming edges ~L125-150)
- Test: `test/hybrid/build-concepts.test.js`

**Interfaces:**
- Consumes: `groupBy(rows, keyCol, projectFn)` helper (already in file, L454).
- Produces: `/build/concepts` payload where each concept's `teaches[]` items are `{slug, title, experienceTag?, stepCount?}` and `requires[]`/`requiredBy[]`/`relatedTo[]` items are `{slug, name, description?}`.

- [ ] **Step 1: Add the failing hybrid assertion**

In `test/hybrid/build-concepts.test.js`, add a new `it` inside the existing `describe('/build/concepts (HTTP)', ...)` block (after the "contract shape" test):

```javascript
  it('teaches items carry experienceTag + stepCount when present; concept edges carry description', async () => {
    const res = await project.get('/build/concepts')
    // Find a concept with at least one teaches entry and at least one requires/relatedTo edge.
    const withTeaches = res.data.concepts.find(c => c.teaches.length > 0)
    if (withTeaches) {
      const t = withTeaches.teaches[0]
      expect(t).toHaveProperty('slug')
      expect(t).toHaveProperty('title')
      // experienceTag/stepCount are optional per-row; assert the keys are
      // allowed shapes when present (string / number), never objects.
      if ('experienceTag' in t) expect(typeof t.experienceTag).toBe('string')
      if ('stepCount' in t) expect(typeof t.stepCount).toBe('number')
    }
    const withEdge = res.data.concepts.find(
      c => c.requires.length > 0 || c.relatedTo.length > 0 || c.requiredBy.length > 0,
    )
    if (withEdge) {
      const edge = [...withEdge.requires, ...withEdge.relatedTo, ...withEdge.requiredBy][0]
      expect(edge).toHaveProperty('slug')
      expect(edge).toHaveProperty('name')
      if ('description' in edge) expect(typeof edge.description).toBe('string')
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:hybrid -- test/hybrid/build-concepts.test.js`
Expected: The new test FAILS (or the `if ('experienceTag' in t)` branches never execute because the field is absent — verify by temporarily asserting `expect('experienceTag' in t).toBe(true)` against a known-populated concept, then revert to the tolerant form). Requires `cf login` to a HANA-bound space first.

> Note: if no `cf login` is available in the execution environment, this hybrid test cannot run. In that case, mark Step 2/4 as "deferred to CI" and rely on the Task 2 unit tests (which fully cover the fetcher emission) plus a local `cds watch` + fetcher smoke in Task 5. Do not block the plan on hybrid availability.

- [ ] **Step 3: Enrich the `teaches` select + mapper**

In `srv/lib/published-concepts-query.js`, change the teaches query (around L95-112) from:

```javascript
  const teachesRows = (await db.run(
    SELECT.from(TutorialConceptLinks)
      .columns(
        'concept_ID',
        'tutorial.slug as tutorial_slug',
        'tutorial.title as tutorial_title'
      )
      .where({ predicate: 'teaches' })
  )).filter(r => idsSet.has(r.concept_ID));
  const teachesByConcept = groupBy(
    teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null),
    'concept_ID',
    r => ({ slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title })
  );
```

to:

```javascript
  const teachesRows = (await db.run(
    SELECT.from(TutorialConceptLinks)
      .columns(
        'concept_ID',
        'tutorial.slug as tutorial_slug',
        'tutorial.title as tutorial_title',
        'tutorial.experienceTag as tutorial_experienceTag',
        'tutorial.stepCount as tutorial_stepCount'
      )
      .where({ predicate: 'teaches' })
  )).filter(r => idsSet.has(r.concept_ID));
  const teachesByConcept = groupBy(
    teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null),
    'concept_ID',
    r => ({
      slug: r.tutorial_slug.toLowerCase(),
      title: r.tutorial_title,
      ...(r.tutorial_experienceTag != null ? { experienceTag: r.tutorial_experienceTag } : {}),
      ...(r.tutorial_stepCount != null ? { stepCount: r.tutorial_stepCount } : {}),
    })
  );
```

- [ ] **Step 4: Enrich the outgoing + incoming edge selects + mappers**

Change the outgoing edges query (around L115-123) `.columns(...)` to add `target.description`:

```javascript
  const outgoingRows = (await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'source_ID', 'predicate',
        'target.slug as target_slug',
        'target.name as target_name',
        'target.description as target_description'
      )
      .where({ status: 'ACTIVE' })
  )).filter(r => idsSet.has(r.source_ID));
```

Change the incoming edges query (around L126-134) `.columns(...)` to add `source.description`:

```javascript
  const incomingRows = (await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'target_ID', 'predicate',
        'source.slug as source_slug',
        'source.name as source_name',
        'source.description as source_description'
      )
      .where({ status: 'ACTIVE', predicate: 'requires' })
  )).filter(r => idsSet.has(r.target_ID));
```

Then update the three edge mappers (around L136-150) to carry `description` (omit the key when null so the payload stays tidy):

```javascript
  const requiresByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'requires'),
    'source_ID',
    r => ({
      slug: r.target_slug.toLowerCase(),
      name: r.target_name,
      ...(r.target_description ? { description: r.target_description } : {}),
    })
  );
  const relatedToByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'relatedTo'),
    'source_ID',
    r => ({
      slug: r.target_slug.toLowerCase(),
      name: r.target_name,
      ...(r.target_description ? { description: r.target_description } : {}),
    })
  );
  const requiredByConcept = groupBy(
    incomingRows,
    'target_ID',
    r => ({
      slug: r.source_slug.toLowerCase(),
      name: r.source_name,
      ...(r.source_description ? { description: r.source_description } : {}),
    })
  );
```

- [ ] **Step 5: Run the hybrid test to verify it passes**

Run: `npm run test:hybrid -- test/hybrid/build-concepts.test.js`
Expected: PASS (all tests green, including the new one). If hybrid is unavailable, defer per Step 2 note.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/published-concepts-query.js test/hybrid/build-concepts.test.js
git commit -m "feat(concepts): enrich cross-link query with experienceTag/stepCount/description (#1127)"
```

---

## Task 2: Emit enriched cross-link fields into frontmatter

**Files:**
- Modify: `scripts/fetch-concepts.ts` (`ConceptPayload` interface L22-29, `refs()` helper L172-175, `frontmatter()` stitch L377-380)
- Test: `test/unit/scripts/fetch-concepts-crosslinks.test.ts` (create)

**Interfaces:**
- Consumes: the Task 1 payload shapes — `teaches[]` = `{slug, title, experienceTag?, stepCount?}`, `requires`/`requiredBy`/`relatedTo[]` = `{slug, name, description?}`.
- Produces: frontmatter where each cross-link entry emits `slug` + `title` and (conditionally) `experienceTag`/`stepCount` (tutorials) or `description` (concepts). Consumed by the Hugo template in Task 4 as `.experienceTag`, `.stepCount`, `.description`.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/scripts/fetch-concepts-crosslinks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// #1127 — cross-link enrichment: teaches carries experienceTag + stepCount;
// requires/requiredBy/relatedTo carry description. All optional/omit-when-absent.

const base: ConceptPayload = {
  slug: 'cap',
  name: 'CAP',
  description: 'SAP Cloud Application Programming Model',
  teaches: [],
  requires: [],
  requiredBy: [],
  relatedTo: [],
}

describe('frontmatter — teaches enrichment', () => {
  it('emits experienceTag + stepCount when present', () => {
    const out = frontmatter({
      ...base,
      teaches: [{ slug: 'my-tut', title: 'My Tutorial', experienceTag: 'beginner', stepCount: 7 }],
    })
    expect(out).toContain('teaches:')
    expect(out).toContain('- slug: "my-tut"')
    expect(out).toContain('    title: "My Tutorial"')
    expect(out).toContain('    experienceTag: "beginner"')
    expect(out).toContain('    stepCount: 7')
  })

  it('omits experienceTag / stepCount when absent', () => {
    const out = frontmatter({ ...base, teaches: [{ slug: 't', title: 'T' }] })
    expect(out).toContain('- slug: "t"')
    expect(out).not.toContain('experienceTag:')
    expect(out).not.toContain('stepCount:')
  })

  it('emits stepCount: 0 (guards on != null, not truthiness)', () => {
    const out = frontmatter({
      ...base,
      teaches: [{ slug: 't', title: 'T', stepCount: 0 }],
    })
    expect(out).toContain('    stepCount: 0')
  })
})

describe('frontmatter — concept edge description enrichment', () => {
  it('emits description on requires/requiredBy/relatedTo when present', () => {
    const out = frontmatter({
      ...base,
      requires: [{ slug: 'sql', name: 'SQL', description: 'Structured Query Language' }],
      relatedTo: [{ slug: 'odata', name: 'OData', description: 'Open Data Protocol' }],
      requiredBy: [{ slug: 'rap', name: 'RAP', description: 'RESTful ABAP Prog Model' }],
    })
    expect(out).toContain('    description: "Structured Query Language"')
    expect(out).toContain('    description: "Open Data Protocol"')
    expect(out).toContain('    description: "RESTful ABAP Prog Model"')
  })

  it('omits description when absent, keeping slug+title', () => {
    const out = frontmatter({ ...base, requires: [{ slug: 'sql', name: 'SQL' }] })
    expect(out).toContain('- slug: "sql"')
    expect(out).toContain('    title: "SQL"')
    expect(out).not.toContain('description: "SQL"') // no phantom description
  })

  it('still emits empty arrays as " []" (YAML validity guard)', () => {
    const out = frontmatter(base)
    expect(out).toContain('teaches: []')
    expect(out).toContain('requires: []')
    expect(out).toContain('relatedTo: []')
  })

  it('escapes description for YAML safety', () => {
    const out = frontmatter({
      ...base,
      requires: [{ slug: 'x', name: 'X', description: 'has "quotes"\nand newline' }],
    })
    expect(out).toContain('description: "has \\"quotes\\"\\nand newline"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/scripts/fetch-concepts-crosslinks.test.ts`
Expected: FAIL — `experienceTag:`/`stepCount:`/`description:` not emitted (the current `refs()` only writes slug+title). TypeScript may also error that `experienceTag`/`stepCount`/`description` are not on the payload types.

- [ ] **Step 3: Extend the `ConceptPayload` interface**

In `scripts/fetch-concepts.ts`, change the cross-link field types (L26-29) from:

```typescript
  teaches: { slug: string; title: string }[]
  requires: { slug: string; name: string }[]
  requiredBy: { slug: string; name: string }[]
  relatedTo: { slug: string; name: string }[]
```

to:

```typescript
  // #1127: teaches carries tutorial difficulty + step count (both plain
  // columns — no NCLOB). requires/requiredBy/relatedTo carry the concept's
  // String(500) description for the enriched card body.
  teaches: { slug: string; title: string; experienceTag?: string; stepCount?: number }[]
  requires: { slug: string; name: string; description?: string }[]
  requiredBy: { slug: string; name: string; description?: string }[]
  relatedTo: { slug: string; name: string; description?: string }[]
```

- [ ] **Step 4: Extend the `refs()` helper to emit the extra fields**

In `scripts/fetch-concepts.ts`, replace the `refs()` helper (L172-175) with a version that emits the optional fields with per-field guards:

```typescript
  // #1127: cross-link entries now carry optional enrichment fields —
  // experienceTag/stepCount for tutorials (teaches), description for
  // concepts (requires/requiredBy/relatedTo). Emitted only when present;
  // empty arrays still serialize as " []" to keep the YAML valid (a bare
  // `relatedTo:[]` with no space fails Hugo's frontmatter parser — see the
  // 2026-06-30 rebuild incident).
  type Ref = {
    slug: string
    title?: string
    name?: string
    experienceTag?: string
    stepCount?: number
    description?: string
  }
  const refs = (arr: Ref[]) => {
    if (arr.length === 0) return ' []'
    return '\n' + arr.map(r => {
      const lines = [
        `  - slug: ${yamlEscape(r.slug)}`,
        `    title: ${yamlEscape(r.title ?? r.name ?? '')}`,
      ]
      if (r.experienceTag) lines.push(`    experienceTag: ${yamlEscape(r.experienceTag)}`)
      if (r.stepCount != null) lines.push(`    stepCount: ${r.stepCount}`)
      if (r.description) lines.push(`    description: ${yamlEscape(r.description)}`)
      return lines.join('\n')
    }).join('\n')
  }
```

(The `frontmatter()` stitch at L377-380 already calls `refs(c.teaches)` etc. — no change needed there.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/scripts/fetch-concepts-crosslinks.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Run the existing fetcher tests to confirm no regression**

Run: `npx vitest run test/unit/scripts/fetch-concepts.test.ts`
Expected: PASS — the existing learningJourneys + yamlEscape tests still green (the empty-array ` []` behavior is preserved).

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-concepts.ts test/unit/scripts/fetch-concepts-crosslinks.test.ts
git commit -m "feat(concepts): emit enriched cross-link fields into frontmatter (#1127)"
```

---

## Task 3: Add the `.concept-card*` CSS family

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.css` (append at end)

**Interfaces:**
- Produces: CSS classes `concept-card-grid`, `concept-card`, `concept-card__type` (+ per-section accent modifiers `--tutorial`/`--concept`/`--external`), `concept-card__title`, `concept-card__body`, `concept-card__meta`, `concept-card__thumb`, `concept-card__badges`. Consumed by the Task 4 template markup.

- [ ] **Step 1: Append the card CSS to the postcss source**

Add to the end of `hugo/assets/css/sap-fundamental.css`:

```css
/* ==========================================================================
   #1127 — concept-page related-content CARDS. Converts the 12 related-content
   sections from <ul>/<li> link lists to a responsive card grid. Namespaced
   `concept-card` (self-contained — no dependency on the Vue-owned
   hugo-apps/src/shared/cards/card.css) but visually aligned with .nav-card:
   same radius, subtle shadow, hover lift, --sap* theme vars throughout so
   dark mode adapts automatically.
   ========================================================================== */
.concept-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
}

.concept-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--sapBaseColor, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
  border-radius: 0.75rem;
  padding: 1rem;
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.concept-card:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}

a.concept-card:hover .concept-card__title {
  color: var(--sapBrandColor, #0070f2);
}

/* Type micro-label with a colored dot, matching .nav-card__type. */
.concept-card__type {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
  color: var(--sapContent_LabelColor, #556b82);
}

.concept-card__type::before {
  content: '';
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: currentColor;
}

.concept-card__type--tutorial { color: var(--sapAccentColor10, #5b738b); }
.concept-card__type--concept { color: var(--sapAccentColor6, #046c7a); }
.concept-card__type--external { color: var(--sapAccentColor8, #6c32a9); }

.concept-card__title {
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0 0 0.375rem;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.concept-card__body {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0 0 0.5rem;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Thumbnail (videos). Reuses the 120x68 aspect but scales to the column. */
.concept-card__thumb {
  width: 100%;
  height: auto;
  aspect-ratio: 120 / 68;
  border-radius: 0.375rem;
  margin-bottom: 0.5rem;
  object-fit: cover;
  background: var(--sapNeutralBackground, rgba(0, 0, 0, 0.05));
}

/* Footer meta row — pushed to the bottom, dot-separated, small + muted. */
.concept-card__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: auto;
  padding-top: 0.625rem;
  border-top: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #556b82);
}

/* Badge row (source badge + link-out) at the card top-right. Reuses the
   existing .kg-help-source--* / .kg-link-out / .kg-api-type / .kg-language
   inline classes verbatim inside the card. */
.concept-card__badges {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
}

@media (max-width: 640px) {
  .concept-card-grid { gap: 0.75rem; }
  .concept-card { padding: 0.875rem; }
}
```

- [ ] **Step 2: Compile the CSS**

Run: `npm run build:css`
Expected: exits 0; `hugo/static/css/sap-fundamental.css` regenerated (its line count grows; `grep -c "concept-card" hugo/static/css/sap-fundamental.css` returns a non-zero count).

- [ ] **Step 3: Verify the class landed in the compiled output**

Run: `grep -c "concept-card__title" hugo/static/css/sap-fundamental.css`
Expected: `1` (or more).

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/css/sap-fundamental.css hugo/static/css/sap-fundamental.css
git commit -m "feat(concepts): add .concept-card CSS family for card redesign (#1127)"
```

---

## Task 4: Convert the 12 sections to card grids in the template

**Files:**
- Modify: `hugo/layouts/concepts/single.html`

**Interfaces:**
- Consumes: the CSS classes from Task 3 and the enriched frontmatter fields from Task 2 (`.experienceTag`, `.stepCount`, `.description` on cross-link entries).
- Produces: card-grid markup. The page-bottom delegated telemetry JS is UNCHANGED and must keep matching `a[data-*-slug]`.

> **Rule for every section:** change `<ul>` → `<ul class="concept-card-grid">`, change each `<li>...</li>` to `<li><a class="concept-card" ...>...</a></li>` (or `<li><span ...>...</span></li>` for the `$isSafe`-false fallback), moving the section's meta into a `<div class="concept-card__meta">` footer. Keep every `data-*-slug` attribute on the `<a>`/`<span>` exactly as it is today. Keep the `{{ with }}` guards, `$url`/`$isSafe`/`$href` logic, `target="_blank" rel="noopener"`, and all `<section data-kg-section=...>` wrappers + `<h2>` text verbatim.

- [ ] **Step 1: Convert the `teaches` section (tutorial cards)**

Replace the `{{ with .Params.teaches }}` block (L22-29) with:

```html
  {{ with .Params.teaches }}
  <section class="concept-page__section">
    <h2>Tutorials that teach this</h2>
    <ul class="concept-card-grid">
      {{ range . }}
      <li>
        <a class="concept-card" href="/tutorials/{{ .slug }}/">
          <span class="concept-card__type concept-card__type--tutorial">Tutorial</span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .experienceTag .stepCount }}
          <span class="concept-card__meta">
            {{ with .experienceTag }}<span class="kg-difficulty">{{ title . }}</span>{{ end }}
            {{ if and .experienceTag .stepCount }} · {{ end }}
            {{ with .stepCount }}{{ . }} step{{ if ne . 1 }}s{{ end }}{{ end }}
          </span>
          {{ end }}
        </a>
      </li>
      {{ end }}
    </ul>
  </section>
  {{ end }}
```

- [ ] **Step 2: Convert the `learningJourneys` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.learningJourneys }}` (L50-68) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-journey-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Learning Journey <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          <span class="concept-card__meta">{{ with .level }}{{ title . }}{{ end }}{{ if and .level .durationHours }} · {{ end }}{{ with .durationHours }}{{ . }}h{{ end }}</span>
        </a>
        {{ else }}
        <span class="concept-card" data-journey-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Learning Journey</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 3: Convert the `helpDocs` section (source badge + snippet body)**

Replace the `<ul class="kg-help-doc-list">...</ul>` inside `{{ with .Params.helpDocs }}` (L106-128) with:

```html
    <ul class="concept-card-grid kg-help-doc-list">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
        {{ $href := $url }}
        {{ with .anchor }}{{ $href = printf "%s#%s" $url . }}{{ end }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $href }}" target="_blank" rel="noopener" data-help-doc-slug="{{ .slug }}">
          <span class="concept-card__badges"><span class="kg-help-source kg-help-source--{{ .source }}">{{ .sourceLabel }}</span> <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ with .snippet }}<span class="concept-card__body">{{ . }}</span>{{ end }}
          {{ with .anchorLabel }}<span class="concept-card__meta kg-help-anchor">{{ . }}</span>{{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-help-doc-slug="{{ .slug }}">
          <span class="concept-card__badges"><span class="kg-help-source kg-help-source--{{ .source }}">{{ .sourceLabel }}</span></span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 4: Convert the `blogPosts` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.blogPosts }}` (L156-173) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-blog-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Blog <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          <span class="concept-card__meta">by {{ .authorName }} · {{ dateFormat "Jan 2, 2006" .postedAt }}</span>
        </a>
        {{ else }}
        <span class="concept-card" data-blog-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Blog</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 5: Convert the `discoveryMissions` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.discoveryMissions }}` (L202-221) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-mission-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Mission <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .effortLevel .categoryLabel }}
          <span class="concept-card__meta">{{ if .effortLevel }}effort {{ .effortLevel }}{{ end }}{{ if and .effortLevel .categoryLabel }} · {{ end }}{{ if .categoryLabel }}{{ .categoryLabel }}{{ end }}</span>
          {{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-mission-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Mission</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 6: Convert the `videos` section (with thumbnail)**

Replace the `<ul>...</ul>` inside `{{ with .Params.videos }}` (L247-278) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-video-slug="{{ .slug }}">
          {{ if .thumbnailUrl }}<img src="{{ .thumbnailUrl }}" alt="" class="concept-card__thumb" loading="lazy">{{ end }}
          <span class="concept-card__type concept-card__type--external">Video <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .channelTitle .publishedAt }}
          <span class="concept-card__meta">{{ with .channelTitle }}by {{ . }}{{ end }}{{ if and .channelTitle .publishedAt }} · {{ end }}{{ with .publishedAt }}{{ dateFormat "Jan 2, 2006" . }}{{ end }}</span>
          {{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-video-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Video</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 7: Convert the `apiDocs` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.apiDocs }}` (L307-326) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-api-doc-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">API Doc <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .category .apiType }}
          <span class="concept-card__meta">{{ if .category }}{{ .category }}{{ end }}{{ if and .category .apiType }} · {{ end }}{{ if .apiType }}<span class="kg-api-type">{{ .apiType }}</span>{{ end }}</span>
          {{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-api-doc-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">API Doc</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 8: Convert the `samples` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.samples }}` (L359-379) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-sample-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Sample <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .language .stars .lastCommitAt }}
          <span class="concept-card__meta">{{ if .language }}<span class="kg-language">{{ .language }}</span>{{ end }}{{ if .stars }} · {{ .stars }} stars{{ end }}{{ if .lastCommitAt }} · Updated {{ dateFormat "Jan 2006" .lastCommitAt }}{{ end }}</span>
          {{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-sample-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Sample</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 9: Convert the `communityEvents` section**

Replace the `<ul>...</ul>` inside `{{ with .Params.communityEvents }}` (L404-421) with:

```html
    <ul class="concept-card-grid">
      {{ range . }}
        {{ $url := .url }}
        {{ $isSafe := or (hasPrefix $url "https://") (hasPrefix $url "http://") }}
      <li>
        {{ if $isSafe }}
        <a class="concept-card" href="{{ $url }}" target="_blank" rel="noopener" data-community-event-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Event <span class="kg-link-out" aria-hidden="true">↗</span></span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ if or .location .startDate (eq .virtualOrInPerson "virtual") }}
          <span class="concept-card__meta">{{ if .location }}<span class="kg-event-location">{{ .location }}</span>{{ end }}{{ if .startDate }} · <span class="kg-event-date">{{ .startDate }}</span>{{ end }}{{ if eq .virtualOrInPerson "virtual" }} · <span class="kg-event-virtual" aria-label="Virtual event">🌐</span>{{ end }}</span>
          {{ end }}
        </a>
        {{ else }}
        <span class="concept-card" data-community-event-slug="{{ .slug }}">
          <span class="concept-card__type concept-card__type--external">Event</span>
          <span class="concept-card__title">{{ .title }}</span>
        </span>
        {{ end }}
      </li>
      {{ end }}
    </ul>
```

- [ ] **Step 10: Convert the 3 concept cross-link sections (requires / requiredBy / relatedTo)**

Replace the `requires` block (L425-432), `requiredBy` block (L434-441), and `relatedTo` block (L443-450). Each follows the same shape — here is `requires` (repeat identically for the other two, changing only the `<h2>` text: "Prerequisites" → "Concepts that build on this" for `requiredBy`, → "Related concepts" for `relatedTo`, and the `{{ with .Params.X }}` key):

```html
  {{ with .Params.requires }}
  <section class="concept-page__section">
    <h2>Prerequisites</h2>
    <ul class="concept-card-grid">
      {{ range . }}
      <li>
        <a class="concept-card" href="/concepts/{{ .slug }}/">
          <span class="concept-card__type concept-card__type--concept">Concept</span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ with .description }}<span class="concept-card__body">{{ . }}</span>{{ end }}
        </a>
      </li>
      {{ end }}
    </ul>
  </section>
  {{ end }}
```

For `requiredBy`:

```html
  {{ with .Params.requiredBy }}
  <section class="concept-page__section">
    <h2>Concepts that build on this</h2>
    <ul class="concept-card-grid">
      {{ range . }}
      <li>
        <a class="concept-card" href="/concepts/{{ .slug }}/">
          <span class="concept-card__type concept-card__type--concept">Concept</span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ with .description }}<span class="concept-card__body">{{ . }}</span>{{ end }}
        </a>
      </li>
      {{ end }}
    </ul>
  </section>
  {{ end }}
```

For `relatedTo`:

```html
  {{ with .Params.relatedTo }}
  <section class="concept-page__section">
    <h2>Related concepts</h2>
    <ul class="concept-card-grid">
      {{ range . }}
      <li>
        <a class="concept-card" href="/concepts/{{ .slug }}/">
          <span class="concept-card__type concept-card__type--concept">Concept</span>
          <span class="concept-card__title">{{ .title }}</span>
          {{ with .description }}<span class="concept-card__body">{{ . }}</span>{{ end }}
        </a>
      </li>
      {{ end }}
    </ul>
  </section>
  {{ end }}
```

> Note: the `refs()` helper maps concept edges to `{slug, title, description}` (title = name), so the template reads `.title` here — consistent with the fetcher's normalization and the template's opening comment (L2-5).

- [ ] **Step 11: Verify the template parses and the telemetry hooks still match**

Run: `grep -c 'data-video-slug\|data-blog-slug\|data-mission-slug\|data-journey-slug\|data-api-doc-slug\|data-sample-slug\|data-help-doc-slug\|data-community-event-slug' hugo/layouts/concepts/single.html`
Expected: a count of at least 16 (each of the 8 external sections has the attr on both the `<a>` and `<span>` fallback). Confirms the delegated telemetry JS (which queries these) still has targets.

- [ ] **Step 12: Commit**

```bash
git add hugo/layouts/concepts/single.html
git commit -m "feat(concepts): render all 12 related-content sections as cards (#1127)"
```

---

## Task 5: Build + verify end-to-end (light/dark, smoke tests)

**Files:** none (verification only)

- [ ] **Step 1: Start local CAP + fetch concepts + run Hugo dev**

In one shell: `cds watch` (waits for `server listening on ... 4004`).
In another: `npx tsx scripts/fetch-concepts.ts` (writes `hugo/content/concepts/*.md`; expect `[fetch-concepts] wrote N page(s)`).
Then: `npm run build:css && npm run dev` (Hugo serves at http://localhost:1313).

Expected: no build errors. If local CAP has no published concepts, seed via `npm run setup-dev-data` or point `CAP_BASE_URL` at a populated hybrid endpoint.

- [ ] **Step 2: Visually verify a populated concept page**

Open `http://localhost:1313/concepts/<slug>/` for a concept with several populated sections. Confirm:
- Each section renders as a card grid (multi-column on wide screens, single column on mobile — resize to check).
- Video cards show a scaled thumbnail; help-doc cards show the source badge + snippet; sample/api cards show the language/apiType pill + ↗; tutorial cards show difficulty + step count; concept cross-link cards show the description.
- Hover lifts the card and turns the title brand-blue.
- Toggle dark mode (the OS toggle in the header): borders/shadows/text remain legible, no white-on-white or black-on-black.

- [ ] **Step 3: Run the concept smoke tests**

Run: `npx vitest run test/smoke/concept-page-help-docs.test.js test/smoke/concept-page-community-events.test.js test/smoke/concepts-route.smoke.test.js`
Expected: PASS — `data-kg-section` attributes, H2 titles, section ordering, and `/concepts/<slug>/` hrefs are all preserved by the card markup.

> If these smoke tests require a deployed target (`SMOKE_BASE_URL`), run them against the local Hugo build or defer to CI per their setup; the key assertion (attributes/titles/ordering unchanged) is structurally guaranteed by keeping the `<section>`/`<h2>` wrappers verbatim.

- [ ] **Step 4: Run the full fetcher + relevant unit suites once more**

Run: `npx vitest run test/unit/scripts/fetch-concepts.test.ts test/unit/scripts/fetch-concepts-crosslinks.test.ts`
Expected: PASS.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin worktree-concept-card-redesign-1127
gh pr create --draft --title "Redesign concept landing pages: related-content link lists → cards (#1127)" \
  --body "Implements #1127. Converts all 12 related-content sections on concept pages to a responsive card grid; enriches the 4 cross-link sections with LOB-safe fields (tutorial difficulty+steps, concept descriptions). Spec: docs/superpowers/specs/2026-07-12-concept-page-card-redesign-design.md

Deploy note: requires build:all → mbt build → cf deploy for the CSS/approuter, PLUS a full content republish (gh workflow run rebuild-content.yml -f mode=full) to re-render all ~6k pages. Do NOT publish concept content from a workstation."
```

---

## Self-Review

**Spec coverage:**
- All 12 sections → cards: Task 4 (Steps 1-10) covers every section. ✓
- Cross-link enrichment (tutorial difficulty+steps, concept description): Task 1 (query) + Task 2 (fetcher) + Task 4 Steps 1/10 (render). ✓
- Responsive auto-fill grid aligned with `.nav-card`: Task 3 CSS. ✓
- Invariants preserved: Task 4 rule block + Step 11 grep + Task 5 Step 3 smoke tests. ✓
- LOB safety: Global Constraints + Task 1 uses only plain columns. ✓
- CSS source-not-output: Global Constraints + Task 3 Steps 1-2. ✓
- Deploy/rebuild note: Global Constraints + Task 5 Step 5 PR body. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete markup/code. The three concept cross-link sections are written out in full (not "similar to") in Task 4 Step 10. ✓

**Type consistency:** `experienceTag` (string), `stepCount` (number), `description` (string) are named identically across Task 1 (query mapper), Task 2 (interface + `refs()` + tests), and Task 4 (`.experienceTag`/`.stepCount`/`.description` in template). The `refs()` `Ref` type unifies title/name. ✓
