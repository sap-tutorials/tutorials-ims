# Clickable Tutorial Tags — Design Spec

**Issue:** [sap-tutorials/tutorials-ims#161](https://github.com/sap-tutorials/tutorials-ims/issues/161)
**Date:** 2026-06-01
**Author:** Tom (jung-thomas), brainstormed with Claude
**Status:** Draft

## Summary

Make selected chips on the tutorial-page top-matter strip clickable. Clicking a chip navigates to the search/navigator page with the corresponding facet pre-applied, letting readers find similar tutorials.

## Background

The U1 Object Page (`hugo/layouts/tutorials/u1-object-page.html`, lines 205–220) renders four chips above the title:

| Chip | Source frontmatter field | Currently clickable |
|---|---|---|
| Experience level | `level` (or legacy `experienceLevel`) | No |
| Duration | `time` (minutes) | No |
| Topic / product tags | `displayTags[i]` (label) zipped with `displayTagSlugs[i]` (slug) | No |
| Progress ring | `stepCount` (with progress overlay) | N/A — not a tag |

The tutorial navigator at `/tutorials/` (`hugo-apps/src/navigator/TutorialNavigator.vue`) already has matching slug-keyed facets:

- `filters.products` — topic/product slugs (e.g. `topic>abap-development`)
- `filters.levels` — experience values (`beginner`, `intermediate`, `advanced`)

The navigator currently parses `?q=<text>` from the URL on mount but does **not** parse a tag/level facet from the URL today. Some legacy AEM links in tutorial source still reference `?tag=…` but they're inert. We will wire that param.

## Goals

1. Topic/product tag chips on the tutorial page link to `/tutorials/?tag=<slug>`.
2. Experience chip on the tutorial page links to `/tutorials/?level=<value>`.
3. Navigator parses both params on mount and applies them to its existing filter state.
4. Hover and focus styles on linked chips clearly read as interactive.
5. Static informational chips (duration, progress ring) keep their current look.

## Non-Goals

- Adding a duration facet to the navigator.
- Changing the QA-channel layout (`hugo.qa.toml` strips most interactive UI; we keep the chip-link behavior consistent across both channels — the navigator is gated separately).
- Reworking the navigator's filter→URL sync (the navigator doesn't push filter state into the URL today; out of scope).
- Surfacing a "clear other filters" CTA. Single-tag jumps replace existing facets via the parser, no extra UX needed.

## Design

### URL shape

| From | To |
|---|---|
| Topic/product chip click | `/tutorials/?tag=<urlencoded-slug>` |
| Experience chip click | `/tutorials/?level=<value>` |
| Hand-crafted multi-value | `/tutorials/?tag=a&tag=b&level=beginner` (parser uses `getAll`, so this works for free) |

We chose `?tag=` + `?level=` (separate keys per facet kind) because:
- It matches the legacy AEM URL convention already present in some tutorial source.
- It keeps URL semantics independent of slug naming. (A single-`?tag=` design that routes by slug prefix would couple URL shape to the `topic>` / `tutorial>` / `software-product>` slug grammar, which is a CMS detail.)

### Hugo template changes

In `hugo/layouts/tutorials/u1-object-page.html` lines 205–220:

- Replace the `<span class="op-chip">` for the experience chip with `<a class="op-chip op-chip--link" href="{{ "/tutorials/" | relURL }}?level={{ . | lower | urlquery }}" aria-label="Filter tutorials by {{ . }}">…</a>`.
- Replace each `<span class="op-chip op-chip--tag">` inside the `range .Params.displayTags` loop with an anchor. Use `index` to look up the parallel slug:

  ```go-html-template
  {{ if .Params.displayTags }}
    {{ $slugs := .Params.displayTagSlugs }}
    {{ range $i, $label := .Params.displayTags }}
      {{ if ne $label "License" }}
        {{ $slug := index $slugs $i }}
        {{ if $slug }}
          <a class="op-chip op-chip--tag op-chip--link"
             href="{{ "/tutorials/" | relURL }}?tag={{ $slug | urlquery }}"
             aria-label="Filter tutorials by {{ $label }}">{{ $label }}</a>
        {{ else }}
          <span class="op-chip op-chip--tag">{{ $label }}</span>
        {{ end }}
      {{ end }}
    {{ end }}
  {{ else if .Params.primaryTag }}
    <a class="op-chip op-chip--tag op-chip--link"
       href="{{ "/tutorials/" | relURL }}?tag={{ .Params.primaryTag | urlquery }}"
       aria-label="Filter tutorials by {{ .Params.primaryTag }}">{{ .Params.primaryTag }}</a>
  {{ end }}
  ```

Defensive behavior:
- If `displayTagSlugs[i]` is missing for a given `displayTags[i]`, render a static span (no broken link).
- The existing `License` skip stays.
- Duration chip and progress ring are untouched.

### CSS additions

Add a `.op-chip--link` modifier to the existing chip stylesheet (same file as `.op-chip` rules). Approximate:

```css
.op-chip--link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.op-chip--link:hover {
  text-decoration: underline;
  background-color: var(--sapList_Hover_Background, rgba(0, 0, 0, 0.04));
}
.op-chip--link:focus-visible {
  outline: 2px solid var(--sapContent_FocusColor, #0070f2);
  outline-offset: 2px;
}
```

Exact tokens / locations to be matched against the actual stylesheet during implementation; this is the shape, not the literal CSS.

### Navigator changes

In `hugo-apps/src/navigator/TutorialNavigator.vue`, extend the existing block at line 43 (`onMounted` query parsing). New code (sketch):

```ts
const params = new URL(window.location.href).searchParams

const initialQuery = params.get('q')
if (initialQuery) searchQuery.value = initialQuery

for (const slug of params.getAll('tag')) {
  if (slug && !filters.products.includes(slug)) filters.products.push(slug)
}
for (const lvl of params.getAll('level')) {
  const v = lvl.toLowerCase()
  if (['beginner', 'intermediate', 'advanced'].includes(v) && !filters.levels.includes(v)) {
    filters.levels.push(v)
  }
}
```

`searchParams.getAll(name)` automatically handles URL-decoded values, including `>` and other special characters in slugs. The existing reactive watcher on `filters` re-runs the OData query with the populated facets — no further glue.

Validation:
- Unknown level values (legacy AEM strings, typos) are dropped silently rather than producing a bogus filter chip.
- Unknown tag slugs are pushed into `filters.products` regardless; the OData query simply returns no matches if the slug isn't in any tutorial's `primaryTag`. This matches existing behavior (the navigator never validates filter values against a known set).

### Data flow

```
Tutorial page render (Hugo, server)
  └─ chip <a> with ?tag=<slug> or ?level=<value>
            ↓ click
Navigator mount (Vue, client)
  └─ parse URL params → push to filters.products / filters.levels
            ↓ existing reactive watcher
  OData query
  └─ result list filtered to matching tutorials
```

## Edge cases

| Case | Behavior |
|---|---|
| `displayTagSlugs` shorter than `displayTags` | Render the unmatched label as a static `<span>`. No broken link. |
| `displayTagSlugs` empty, `primaryTag` set | Link to `?tag=<primaryTag>`. (Existing fallback path, now linked.) |
| Both empty | Render nothing. (Same as today.) |
| Slug contains `>`, spaces, `:` | `urlquery` (Hugo) and `URLSearchParams` (browser) round-trip correctly. |
| Inbound stale AEM URL (e.g. `?tag=tutorial:type/mission`) | Pushed to `filters.products`; OData returns no matches; user sees an empty result. Acceptable. |
| `?level=Beginner` (mixed case) | Lowercased before validation; matches `beginner`. |
| Multi-value (`?tag=a&tag=b`) | Both slugs applied via `getAll` loop. |
| Navigator on a non-`/tutorials/` page | Code never runs there — params inert. |

## Testing

- **Smoke** (`test/smoke/`): GET `/tutorials/<known-slug>/` returns HTML containing both `<a … href=…?tag=topic%3Eabap-development…>` and `<a … href=…?level=beginner…>`. Regex tolerates Hugo minifier attribute-quote stripping ([feedback_hugo_minifier_strips_quotes](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_hugo_minifier_strips_quotes.md) — accept both quoted and unquoted attribute forms).
- **Unit** (Vitest, `hugo-apps/`): mount `TutorialNavigator.vue` with `window.location.search = "?tag=topic%3Eabap-development&level=beginner"`; assert `filters.products` contains `topic>abap-development` and `filters.levels` contains `beginner`. A second test asserts unknown level values (`?level=expert`) are silently dropped.
- **Manual**: open a real tutorial in DEV, click each topic/product chip → land on `/tutorials/` with the corresponding product checkbox ticked and result list filtered. Click the experience chip → same with the experience checkbox.

## Risks

- **Low.** This is a presentational change plus ~15 lines of URL parsing. No schema, no API, no auth surface.
- The CSS hover/focus tokens may not exactly match the rest of the chip set first time; visual review during PR.
- Hugo template iteration with `index $slugs $i` is a pattern already used elsewhere in the codebase; no new build-step risk.

## Acceptance (from issue #161)

- [x] Each tag links to `/search?tag=…` (or equivalent — we use `/tutorials/?tag=…` because the navigator lives at `/tutorials/`) with the right facet pre-applied.
- [x] Hover/focus styles indicate interactivity.
- [x] Excludes purely informational chips (`15 min`, progress ring) — only topic/product tags and experience are clickable; duration and progress are static.
