# Other Tutorials by This Author — Design

- **Issue:** [#1732](https://github.com/sap-tutorials/tutorials-ims/issues/1732)
- **Date:** 2026-08-13
- **Status:** Approved design, pending implementation plan
- **Author:** design collaboration (Tom + Claude)

## Problem

From a reader's perspective, when a tutorial is helpful they often want to
find *more from the same author*. Today the tutorial byline shows the author's
name/avatar and links only **outward to GitHub**
(`hugo/layouts/partials/tutorial-author.html:42-46`). There is no way, on
developers.sap.com, to discover the other tutorials a given author has written.

## Goal

Two complementary surfaces, both keyed on the tutorial's **primary author**:

1. **Inline rail** — a "More from this author" strip on the tutorial page,
   contextual to the reader who just found value.
2. **Author page** — a dedicated `/authors/{login}/` landing page listing all
   of that author's tutorials, linked from the byline.

Authors who are also Developer Advocates reuse their existing, richer Advocate
profile instead of getting a second page.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Presentation | **Both** — inline rail *and* dedicated author page |
| 2 | Serving model | **Static (Hugo build-time)** — no runtime endpoint; deterministic data |
| 3 | Author scope | **Primary author only** (`Tutorials.author` / GitHub login) — not contributors |
| 4 | Advocate overlap | **Redirect** `/authors/{login}` → `/developer-advocates/{slug}/` when the author is an active Advocate |

## Grounding (verified against the codebase)

- **Author identity.** `Tutorials.author` is a single-valued FK → `Users`
  (`db/schema.cds:47`), resolved at publish time from frontmatter
  `author_profile` → `Users.githubLogin`
  (`srv/lib/resolve-tutorial-author.js`). In Hugo frontmatter the author is
  `author` (display name) + `authorProfile` (a `github.com/{login}` URL); the
  byline derives the login via `path.Base authorProfile`
  (`tutorial-author.html:13-46`). This is the grouping key.
- **Author pages serve as static files.** The approuter catch-all
  (`approuter/xs-app.json:592`) serves `hugo/public/**` from `localDir: static`;
  `mbt build` copies `hugo/public/` into `approuter/static/`. CAP
  `/content/pages/*` intercepts are an **explicit per-route allowlist**
  (`xs-app.json:578-591`) whose CAP-side twin is `IN_SCOPE_PAGES`
  (`srv/lib/page-key-map.js:22-41`). `/authors/*` is on neither list, so a new
  `hugo/public/authors/{login}/index.html` tree falls through to static
  serving. **`/authors/*` must stay OFF `IN_SCOPE_PAGES` and the CAP route
  list** — adding it would route to `pageServeHandler`, which returns a 404 for
  un-published keys.
- **Tutorial pages are NOT static.** `/tutorials/*` → `/content/tutorials/*`
  on `srv-api` (`xs-app.json:552-556`), served from HANA `ContentFiles`. So the
  inline rail is baked into the tutorial HTML at Hugo build time and reaches
  production through the existing publish→HANA pipeline
  (`scripts/publish-content.ts`), **not** as a static file.
- **No Hugo taxonomy exists.** `hugo/hugo.toml` has no `[taxonomies]` table.
  Rather than introduce the first taxonomy (which disables default
  tags/categories and risks colliding with section routing), we mirror the
  **proven advocate-generation pattern**: `scripts/fetch-advocates.ts` emits one
  `hugo/content/developer-advocates/{slug}.md` per advocate.
- **Advocate pages are Hugo-built** at `/developer-advocates/{slug}/`
  (`hugo/layouts/developer-advocates/single.html`; generated md via
  `scripts/fetch-advocates.ts`), so a Hugo `aliases` redirect works.
  **Catch:** the advocate `slug` is name-derived (e.g. `thomas-jung`), *not* a
  GitHub login (`db/advocates.cds`). The advocate↔author join is through the
  shared `Users` record (`Advocates.user` → `Users`, and
  `Tutorials.author = user`). So we must build a `login → advocateSlug` map,
  which requires surfacing `Users.githubLogin` on the advocate build feed.
- **`hugo/data/` build injection** is done by scripts that `writeFileSync` JSON
  (e.g. `scripts/fetch-tutorials.ts` writes `browse.json`), with a
  **prod vs QA split** (`hugo/data/` vs `hugo/data-qa/`, driven by
  `hugo.qa.toml` `dataDir="data-qa"`). New build data must honor that split.

## Architecture

```text
scripts/fetch-tutorials.ts
  ├─ (existing) fetch + parse tutorials, emit browse.json, content/tutorials/*.md
  └─ (NEW) build author index from parsed frontmatter, grouped by normalized login
        → hugo/data/author_index.json         (prod)
        → hugo/data-qa/author_index.json       (QA parity)
        → hugo/content/authors/{login}.md       (one per resolvable, NON-advocate login)

scripts/fetch-advocates.ts
  └─ (NEW) for each advocate with a resolvable github login, add
        aliases = ["/authors/{login}/"]  to the generated advocate md
        → Hugo emits a redirect stub /authors/{login}/ → /developer-advocates/{slug}/

srv (advocate feed)
  └─ (NEW, small) surface Users.githubLogin on the public advocates projection
        so the build can compute login → advocateSlug

Hugo build
  ├─ hugo/layouts/authors/single.html          (NEW) → /authors/{login}/index.html
  ├─ hugo/layouts/partials/more-from-author.html (NEW) baked into every tutorial page
  └─ hugo/layouts/tutorials/u1-object-page.html + partials/tutorial-author.html
        (wire the rail + point the byline at the internal destination)

Deploy
  ├─ /authors/{login}/index.html  → approuter static (catch-all)
  └─ tutorial pages (with baked rail) → publish→HANA → /content/tutorials/*
```

### Data unit: `author_index.json`

A single build artifact is the source of truth for **both** surfaces:

```jsonc
{
  "thomas-jung": {
    "login": "thomas-jung",
    "displayName": "Thomas Jung",
    "avatar": "https://avatars.githubusercontent.com/…",
    "githubUrl": "https://github.com/thomas-jung",
    "advocateSlug": "thomas-jung",          // present ⇒ author is an Advocate
    "tutorials": [
      { "slug": "abap-…", "title": "…", "tags": ["…"], "level": "Beginner",
        "time": 20, "isNew": true }
      // …ordered most-recent-first
    ]
  }
  // …one entry per resolvable login
}
```

- **Grouping key:** normalized login = lowercased `path.Base(authorProfile)`
  restricted to a valid GitHub handle (reuse the existing normalization in
  `scripts/parsers/github-login-from-profile.ts`). Tutorials whose
  `authorProfile` does not yield a valid github login are **omitted** — they
  get no rail and no page.
- **Ordering:** tutorials most-recent-first (by the same date signal the rest
  of the build uses; fall back to title A→Z when no date).
- **`advocateSlug`:** set when the login maps to an active Advocate (via the
  advocate feed's github login). Drives (a) skipping the standalone author
  page, and (b) pointing byline/rail links at the advocate page.

### Author page — `hugo/layouts/authors/single.html`

- Generated md: one `hugo/content/authors/{login}.md` per resolvable login that
  is **not** an advocate, with frontmatter `type: authors`, `layout: single`,
  `login: {login}`. **Generated files are gitignored** (like
  `content/developer-advocates/{slug}.md`).
- Layout renders, from `site.Data.author_index[login]`:
  - Header: display name, avatar, "View GitHub profile" link, tutorial count.
  - Card grid of the author's tutorials, **reusing the existing tutorial-card
    partial** (`next-steps-card.html` or the browse card) for visual
    consistency.
- **Single-tutorial authors still get a page** (default) so the byline link
  always resolves.

### Inline rail — `hugo/layouts/partials/more-from-author.html`

- Invoked from `hugo/layouts/tutorials/u1-object-page.html`, **placed directly
  under the author byline in the Overview section** (default).
- Reads `site.Data.author_index[currentLogin]`, **excludes the current slug**,
  caps at **N = 4** most-recent, renders cards + a
  "See all {count} tutorials by {name} →" link.
- **Link target:** `/developer-advocates/{advocateSlug}/` when the author is an
  advocate, else `/authors/{login}/`.
- **Hidden entirely** when there are no other tutorials (0 siblings) or no
  resolvable login.
- Baked at build → published to HANA with the page.

### Byline integration — `partials/tutorial-author.html`

- Author **name** links to the internal destination (author page or advocate
  page); the **avatar/GitHub icon** remains the outward GitHub link.
- Falls back to today's behavior (plain name / GitHub link) when no login
  resolves.

## Error handling & edge cases

- **No resolvable github login** → no index entry, no rail, no page; byline
  unchanged. (Most common failure mode; must degrade silently.)
- **Author is an advocate** → no `/authors/{login}` page emitted; a Hugo alias
  redirect stub is emitted instead; links point to the advocate page.
- **Advocate slug/login collision or missing github link on an advocate** → if
  we cannot resolve the login for an advocate, we simply don't add the alias and
  (harmlessly) may emit a plain `/authors/{login}` page — no redirect, no crash.
- **Single-tutorial author** → page renders with one card; rail is hidden on
  that (only) tutorial.
- **QA channel** → `author_index.json` and `content/authors/*.md` must be
  emitted for the QA build too (respect `dataDir=data-qa`); missing this repeats
  the class of bug in `qa-datadir-override-hides-island-manifest`.

## Known limitation (v1)

**Static cross-link staleness.** Because the rail is baked into each tutorial's
published HTML, adding a *new* tutorial by an author refreshes only that new
tutorial's rail on an incremental (slug-targeted) publish; the author's *other*
tutorials show the updated sibling set only after the next **full** rebuild.
This matches the existing behavior of the already-baked next/prev and
frontmatter recommendation links. Dynamic client-side hydration (à la
`assets/js/recommend.ts`) is a deliberate later option, not v1.

## Testing strategy

- **Unit (vitest):**
  - login normalization + grouping into `author_index` (pure function) —
    valid/invalid `authorProfile`, mixed-case, reserved names, non-github hosts.
  - `login → advocateSlug` mapping (pure function) — advocate present/absent,
    advocate without github link.
  - rail selection logic — excludes current slug, caps at N, hides when empty.
- **Build guard:** assert `/authors/` never appears in `IN_SCOPE_PAGES`
  (`srv/lib/page-key-map.js`) and that `author_index.json` is emitted by the
  build.
- **e2e (post-deploy, advisory):** a Playwright spec (this touches
  `hugo/layouts/**`, which triggers the e2e-coverage nudge) hitting one known
  author page and asserting the rail renders on a tutorial with ≥2
  same-author tutorials. Self-skips without `SMOKE_BASE_URL`.

## Files touched

| File | Change |
|------|--------|
| `scripts/fetch-tutorials.ts` | Emit `author_index.json` (prod + QA) and `content/authors/{login}.md` |
| `scripts/parsers/github-login-from-profile.ts` | Reuse for normalization (no change expected; verify export) |
| `scripts/fetch-advocates.ts` | Add `aliases` for advocate logins; consume github login from feed |
| `srv/developer-service.cds` + `srv/routes/advocates-public.js` | Surface `Users.githubLogin` on the public advocates projection |
| `hugo/layouts/authors/single.html` | **New** author page layout |
| `hugo/layouts/partials/more-from-author.html` | **New** inline rail partial |
| `hugo/layouts/tutorials/u1-object-page.html` | Invoke the rail partial |
| `hugo/layouts/partials/tutorial-author.html` | Point byline name at internal destination |
| `.gitignore` | Ignore generated `hugo/content/authors/*.md` |
| `test/**` | Units + build guard; `test/e2e/**` advisory spec |

## Out of scope (v1)

- Contributor-based grouping (only primary author).
- A runtime "tutorials by author" API / dynamic hydration.
- Author bios/social for non-advocate authors (page shows name + avatar +
  GitHub link only).
- Adding author pages to the sitemap (nice-to-have; can follow).
