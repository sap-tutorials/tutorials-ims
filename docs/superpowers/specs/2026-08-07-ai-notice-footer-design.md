# AI Notice footer link + page — Design

**Date:** 2026-08-07
**Status:** Approved (design)

## Goal

Add an "AI" item to the site footer (alongside Privacy, Terms of Use, Legal
Disclosure, etc.) that links to a page displaying the same AI Notice text
shown in the Joule popup.

## Background

The Joule panel (`hugo/layouts/partials/joule-panel.html`) already renders an
"AI Notice" section with three paragraphs. We want that same notice available
as a standalone, linkable page reachable from the footer.

The footer is `hugo/layouts/partials/footer.html` — a flat `<ul>` of `<li>`
links. Internal links (Privacy) use a root-relative `href` with no
`target="_blank"`; external legal links point to `sap.com` in a new tab.

## Decisions

- **Page URL:** `/ai-notice/`. `/ai/` is unavailable — it is the existing
  "Extend with AI" build-verb landing page (`content/ai/_index.md`). The
  footer label is still `AI` as requested; only the underlying page slug
  differs.
- **Content:** short intro line + the three AI Notice paragraphs (verbatim
  from the Joule panel).

## Changes

### 1. New page `hugo/content/ai-notice.md`

Top-level markdown page mirroring `hugo/content/privacy.md` (default single
layout). Frontmatter: `title: "AI Notice"`, a `description`, low sitemap
priority. Body: one intro sentence, then the three paragraphs copied verbatim
from `joule-panel.html` lines 58–60 (the "Joule is an AI assistant." lead-in
is dropped since this page is not Joule-scoped — adjusted to a neutral intro).

Renders at `/ai-notice/`.

### 2. Footer link `hugo/layouts/partials/footer.html`

Add one `<li>` to the nav list, next to Privacy:

```html
<li><a href="/ai-notice/">AI</a></li>
```

Internal, root-relative, no `target="_blank"` (matches the Privacy link).

## Out of scope (YAGNI)

- No CAP/HANA changes — this is a static Hugo page.
- No shared partial to dedupe the notice text between the Joule panel and the
  page. Three static sentences; a shared include costs more than it saves. If
  the text later needs to stay in sync programmatically, revisit then.

## Verification

- `npm run dev`, load `http://localhost:1313/ai-notice/`, confirm the three
  paragraphs render.
- Confirm the "AI" link appears in the footer on any page and navigates to the
  new page.
