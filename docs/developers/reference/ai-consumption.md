# AI-Friendly Consumption — developers.sap.com

This document describes how developers.sap.com is structured to be consumed by AI assistants, search engines, and machine clients alongside humans. Every feature here was added in the AI-friendly site initiative (PR [#9](https://github.com/sap-tutorials/tutorials-ims/pull/9), May 2026) and is now part of the standard build.

The intent: **let AI tools cite our tutorials accurately, surface them in answer engines, and respect the site's consumption policy — without permitting model training on our content.**

---

## TL;DR — what an AI agent sees

When an AI agent visits developers.sap.com, it can rely on:

| Surface | URL | Purpose |
| --- | --- | --- |
| Robots policy | `/robots.txt` | Crawl rules + AI bot allowlist |
| Sitemap | `/sitemap.xml` | Every URL with `<lastmod>` |
| AI index | `/llms.txt` | Curated table-of-contents per llmstxt.org |
| Full catalog | `/llms-full.txt` | Every tutorial + mission with metadata |
| Agent guidance | `/AGENTS.md` | Citation policy + machine-readable conventions |
| Per-page JSON-LD | (in HTML `<head>`) | schema.org structured data |
| Per-response headers | (every route) | `Content-Signal` + `X-Robots-Tag` |

There is no separate AI "API." Everything ships in the same HTML and HTTP responses humans receive — that's the design.

---

## The 15 features

### 1. Brand string and title pattern

**File:** [hugo/hugo.toml](../../../hugo/hugo.toml), [hugo/layouts/partials/head-meta.html](../../../hugo/layouts/partials/head-meta.html)

Canonical brand: `SAP Developers Tutorials`. Twitter handle: `@sapdevs`. Canonical origin: `https://developers.sap.com`.

Titles use the pattern:

- Home → `<title>SAP Developers Tutorials</title>`
- Any other page → `<title>{Page Title} | SAP Developers Tutorials</title>`

The home page deliberately omits the suffix to avoid the awkward `SAP Developers Tutorials | SAP Developers Tutorials` duplication that crawlers penalize. The Hugo expression: `cond .IsHome $brand (printf "%s | %s" .Title $brand)`.

### 2. Canonical link, description, robots, keywords, authors

**File:** [hugo/layouts/partials/head-meta.html](../../../hugo/layouts/partials/head-meta.html)

Every page emits:

```html
<link rel="canonical" href="https://developers.sap.com/{path}/">
<meta name="description" content="{page description or site default}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="keywords" content="{tags}">
<meta name="author" content="{author}">
```

`max-image-preview:large` lets answer engines display tutorial cover images at full size in result snippets. Description falls back to the site default when frontmatter is missing.

### 3. Open Graph + Twitter Card

**File:** [hugo/layouts/partials/head-og.html](../../../hugo/layouts/partials/head-og.html)

Sitewide:

```html
<meta property="og:site_name" content="SAP Developers Tutorials">
<meta property="og:url" content="{absolute URL}">
<meta property="og:title" content="{page title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://developers.sap.com/img/og-default.png">
<meta property="og:type" content="website|article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@sapdevs">
<meta name="twitter:creator" content="@{author handle}">
```

Tutorials emit `og:type=article` plus `article:published_time`, `article:modified_time`, `article:author`, and `article:tag` for each tag.

The default OG image lives at [hugo/static/img/og-default.png](../../../hugo/static/img/og-default.png) — 1200×630 PNG, SAP logo on `#0070f2` background. Generated once with `sharp`; checked into the repo.

### 4. Sitewide JSON-LD (Organization + WebSite)

**File:** [hugo/layouts/partials/site-jsonld.html](../../../hugo/layouts/partials/site-jsonld.html)

Every page renders an `@graph` with two objects, addressable by `@id`:

```jsonc
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://developers.sap.com/#organization",
      "name": "SAP",
      "url": "https://developers.sap.com",
      "logo": "https://developers.sap.com/img/sap-logo.png",
      "sameAs": ["https://www.sap.com", "https://twitter.com/sapdevs", ...]
    },
    {
      "@type": "WebSite",
      "@id": "https://developers.sap.com/#website",
      "name": "SAP Developers Tutorials",
      "url": "https://developers.sap.com",
      "publisher": { "@id": "https://developers.sap.com/#organization" },
      "potentialAction": {
        "@type": "SearchAction",
        "target": "https://developers.sap.com/tutorials/?q={search_term_string}",
        "query-input": "required name=search_term_string"
      }
    }
  ]
}
```

The `@id` URLs are the linking primitive — per-page schemas reference them as `{ "@id": "https://developers.sap.com/#organization" }` instead of duplicating the Organization block. Schema.org parsers stitch the graph across all `<script type="application/ld+json">` blocks on the page.

### 5. Per-page JSON-LD: HowTo / Course / BreadcrumbList / FAQPage

**File:** [hugo/layouts/partials/head-jsonld.html](../../../hugo/layouts/partials/head-jsonld.html)

Type selection by content:

| Page type | Schema.org type | Why |
| --- | --- | --- |
| Tutorial | [`HowTo`](https://schema.org/HowTo) | Tutorials are imperative, step-by-step instructions producing an outcome |
| Mission | [`Course`](https://schema.org/Course) with `hasCourseInstance` | Missions are multi-tutorial learning paths with completion criteria |
| Group | [`Course`](https://schema.org/Course) with `hasCourseInstance` | Groups are categorical learning paths |
| Any non-home | [`BreadcrumbList`](https://schema.org/BreadcrumbList) | Search engines render breadcrumbs in result snippets |
| Tutorial with `youWillLearn` + `prerequisites` | [`FAQPage`](https://schema.org/FAQPage) | Auto-generated from frontmatter, surfaces in answer engines |

`HowTo` includes `name`, `description`, `totalTime` (ISO 8601 duration `PT{n}M` from the `time` frontmatter), `datePublished`, `dateModified`, `educationalLevel`, `author`, `publisher` (referencing the Organization `@id`), and a `step[]` array — one `HowToStep` per tutorial step.

`FAQPage` is auto-generated when both `youWillLearn` and `prerequisites` arrays are present in frontmatter. Questions emitted: "What will I learn?", "What do I need before I start?", "How long does this take?", "What level is this?". Answers come from frontmatter — no manual FAQ authoring needed.

### 6. robots.txt with AI bot allowlist

**File:** [hugo/layouts/robots.txt](../../../hugo/layouts/robots.txt)

Generated as a Hugo output format (`robots`) so it always reflects the current `baseURL`. Policy:

- **All bots**: allowed on public content; disallowed on `/api/`, `/admin/`, `/admin-ui/`, `/scanner-ui/`, `/event-display/`, `/display/`
- **Search engines** (Googlebot, Bingbot, DuckDuckBot): explicit allow
- **AI crawlers** with explicit allow rules: `GPTBot`, `ChatGPT-User`, `ClaudeBot`, `anthropic-ai`, `PerplexityBot`, `OAI-SearchBot`, `Google-Extended`, `Applebot-Extended`
- **Sitemap pointer**: `Sitemap: https://developers.sap.com/sitemap.xml`

The header comment states the policy in human language: *"Content licensed for human and AI-assistant citation; not for model training."* That's belt and suspenders — `Content-Signal` (see #14) carries the same policy machine-readably.

### 7. sitemap.xml with `<lastmod>`

**File:** [hugo/layouts/_default/sitemap.xml](../../../hugo/layouts/_default/sitemap.xml)

Custom sitemap template overrides Hugo's default. Each URL gets:

- `<loc>` — absolute URL via `.Permalink`
- `<lastmod>` — derived per [`[frontmatter]`](../../../hugo/hugo.toml) precedence: `lastmod` → `lastUpdated` → `:git` (commit time) → `:fileModTime`
- `<changefreq>` and `<priority>` — conditional by Type (tutorials = `weekly`/`0.7`, missions = `monthly`/`0.8`, home = `daily`/`1.0`)

The `:git` fallback is what makes this trustworthy: even if a tutorial author forgets to bump `lastUpdated` in frontmatter, the commit timestamp ensures crawlers get an accurate freshness signal.

### 8. llms.txt

**File:** [hugo/layouts/_default/llms.txt](../../../hugo/layouts/_default/llms.txt)

Per the [llmstxt.org spec](https://llmstxt.org). Curated index:

```
# SAP Developers Tutorials

> Official tutorial platform for SAP technologies. Step-by-step tutorials, missions...

Content policy: Citation in AI search and answer use cases is welcome.
Use for model training is not.
See https://developers.sap.com/AGENTS.md.

## Featured Missions
- [{title}]({url}): {description}
...

## By Topic
- [BTP](https://developers.sap.com/tags/btp/)
- [CAP](https://developers.sap.com/tags/cap/)
...
```

Hugo emits this at `/llms.txt` via the `llms` output format (configured in [hugo.toml](../../../hugo/hugo.toml) with `mediaType = 'text/markdown'`, `baseName = 'llms'`, `isPlainText = true`). Limited to the first 20 missions to stay under the spec's "concise index" guidance.

### 9. llms-full.txt

**File:** [hugo/layouts/_default/llmsfull.txt](../../../hugo/layouts/_default/llmsfull.txt)

Machine-readable catalog of every tutorial and mission. One entry per resource:

```
URL: https://developers.sap.com/tutorials/abap-cloud-ui-from-interface/
Title: Build a SAP Fiori UI from a Service Interface in ABAP Cloud
Type: Tutorial
Level: Intermediate
Time: 25 minutes
Tags: abap-development, btp-abap-environment, fiori
Description: Learn to expose a service interface and consume it...
Author: Andre Fischer
Last updated: 2026-04-12
```

In production with all ~1,200 tutorials, the file is several MB. Smoke test asserts > 10KB.

> **Hugo gotcha**: the layout filename **must** match the output format identifier (`llmsfull`), not the `baseName` (`llms-full`). The plan originally specified `llms-full.txt` and Hugo silently fell back to the default list template — discovered during implementation. Fixed by renaming to `llmsfull.txt`. See commit `02b4aa8`.

### 10. AGENTS.md (public)

**File:** [hugo/static/AGENTS.md](../../../hugo/static/AGENTS.md), served at `/AGENTS.md`

The public-facing agent guidance document. Covers:

- Site purpose and authoritative URL
- Content licensing — *citation OK, training NO*
- Where to find content programmatically (sitemap, llms.txt, llms-full.txt)
- How to cite a tutorial (URL pattern, attribution requirements)
- Request rate guidance (no documented limit, but be reasonable)
- Contact for issues

This is distinct from the **repo-root** `AGENTS.md` (see #15), which targets *coding agents working in the codebase*.

### 11. Server-Side Rendered (SSR) homepage

**File:** [hugo/layouts/index.html](../../../hugo/layouts/index.html), [hugo/assets/css/home.css](../../../hugo/assets/css/home.css)

Previously the homepage was a 4-line stub with `<div id="tutorial-navigator"></div>` — a JS-rendered SPA shell. Crawlers and AI agents that don't execute JavaScript saw an empty page.

Now the homepage is fully rendered server-side as semantic HTML:

```html
<article class="home">
  <section class="home-hero"> ...</section>
  <section class="featured-missions"> ...</section>
  <section class="recent-tutorials"> ...</section>      <!-- last 12 by lastmod -->
  <section class="browse-by-topic"> ...</section>
  <section class="search-tutorials">
    <div id="tutorial-navigator"></div>                 <!-- progressive enhancement -->
    <noscript><a href="/tutorials/">Browse all tutorials</a></noscript>
  </section>
</article>
```

The JavaScript navigator still works — the SSR content lives *outside* `#tutorial-navigator`, so the JS app augments it rather than replacing it. This is progressive enhancement, not duplicated effort.

### 12. Web fonts with `font-display: swap`

**File:** [hugo/assets/css/](../../../hugo/assets/css/) (theme files)

Every `@font-face` declaration includes `font-display: swap`. Without this, browsers block text rendering until fonts load — measured by Lighthouse as *Cumulative Layout Shift* and *First Contentful Paint* penalties that hurt search ranking.

Smoke check: `grep -E 'font-display: swap' hugo/public/tutorials/*/index.html` returns matches.

### 13. Open Graph default image

**File:** [hugo/static/img/og-default.png](../../../hugo/static/img/og-default.png) (43,673 bytes)

1200×630 PNG with the SAP logo on the SAP Joy blue (`#0070f2`) background. Force-added past the `*.png` gitignore rule so it travels with the repo.

Per-page OG images: tutorials and missions use a custom image if provided in frontmatter, otherwise fall back to this default.

### 14. Content-Signal + X-Robots-Tag headers

**File:** [approuter/xs-app.json](../../../approuter/xs-app.json) (`responseHeaders` array)

The AppRouter injects two response headers on every route:

```http
Content-Signal: index=yes, ai-train=no, ai-search=yes
X-Robots-Tag: index, follow, max-image-preview:large
```

`Content-Signal` is the [Cloudflare draft proposal](https://blog.cloudflare.com/content-signals-policy/) for declaring AI consumption policy machine-readably. The values mean:

- `index=yes` — search engines may index
- `ai-train=no` — content may **not** be used for model training
- `ai-search=yes` — AI search/answer engines may use the content for citation

`X-Robots-Tag` echoes the meta-tag policy at the HTTP layer so it applies even to non-HTML responses (PDFs, images, raw markdown).

Critically, these headers cover **all** routes — including `/tutorials/*` which is served from HANA BLOBs by the CAP backend, not from Hugo statics. This was the reason the policy goes on the AppRouter, not in Hugo: the AppRouter is the *only* layer every response passes through.

### 15. Repo-root AGENTS.md

**File:** [AGENTS.md](../../../AGENTS.md)

Distinct from the **public** AGENTS.md (#10). This one targets coding agents (Claude Code, Cursor, Copilot, Aider) working *inside the repo*. It points them to [CLAUDE.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/CLAUDE.md) as the canonical project guide and lists the quick conventions:

- Hugo content under `hugo/content/tutorials/` is generated — never hand-edit
- Tutorial HTML is served from HANA BLOBs, not static files
- Run `npm test` (in-memory SQLite) before committing
- Use `cds-mcp` to look up CDS definitions before editing CDS or CAP code

---

## Verification

### Smoke tests

Four Vitest files under `test/smoke/` validate the live deployment:

| File | What it asserts |
| --- | --- |
| [test/smoke/seo-files.test.js](../../../test/smoke/seo-files.test.js) | robots.txt content, sitemap absolute URLs + `<lastmod>`, llms.txt brand header, llms-full.txt size > 10KB, /AGENTS.md served, og-default.png returns `image/png` |
| [test/smoke/meta-tags.test.js](../../../test/smoke/meta-tags.test.js) | Home title has no duplication; canonical, description, robots, content-signal meta tags present; OG + Twitter Card complete; tutorial title has ` \| SAP Developers Tutorials` suffix; `og:type=article` and `author` on tutorials |
| [test/smoke/jsonld.test.js](../../../test/smoke/jsonld.test.js) | Home page contains `Organization` + `WebSite` JSON-LD; tutorial pages contain `HowTo` with `step[]` and `BreadcrumbList` |
| [test/smoke/content-signal.test.js](../../../test/smoke/content-signal.test.js) | Both AppRouter-served (`/`) and HANA-served (`/tutorials/`) responses carry `Content-Signal` and `X-Robots-Tag` headers |

Run them against any deployment:

```bash
SMOKE_BASE_URL=https://developers.sap.com npm run test:smoke
```

### Manual validators

- **Sitemap**: [Google Search Console → Sitemaps](https://search.google.com/search-console)
- **JSON-LD**: [Schema.org Validator](https://validator.schema.org), [Google Rich Results Test](https://search.google.com/test/rich-results)
- **OG card**: [opengraph.xyz](https://www.opengraph.xyz/), [Twitter Card Validator](https://cards-dev.twitter.com/validator) (deprecated but still useful)
- **Robots**: [Google robots.txt Tester](https://www.google.com/webmasters/tools/robots-testing-tool)
- **Lighthouse**: Chrome DevTools → Lighthouse → SEO + Best Practices categories should both score 100

---

## How to extend

### Adding a new schema.org type

Edit [hugo/layouts/partials/head-jsonld.html](../../../hugo/layouts/partials/head-jsonld.html). Use the existing patterns:

- Wrap in `{{- if eq .Type "your-type" -}}` ... `{{- end -}}` so it only emits on the right pages
- Reference the Organization with `"publisher": { "@id": "{{ $base }}/#organization" }` instead of duplicating
- Use `| jsonify` on every value that comes from frontmatter — it handles escaping

### Adding a new AI bot to the allowlist

Edit [hugo/layouts/robots.txt](../../../hugo/layouts/robots.txt). Add a stanza like:

```
User-agent: NewBotName
Allow: /
```

That's it — the next `npm run build:hugo` regenerates `/robots.txt`.

### Adding a new metadata field

For a field that should reach all pages: edit [head-meta.html](../../../hugo/layouts/partials/head-meta.html) or [head-og.html](../../../hugo/layouts/partials/head-og.html) directly.

For a field that's tutorial-specific: add it to the tutorial frontmatter via a parser change in [scripts/parsers/](../../../scripts/parsers/), then read it in the relevant partial as `.Params.your_field`.

### Updating the consumption policy

Three places must stay in sync:

1. The `Content-Signal` header in [approuter/xs-app.json](../../../approuter/xs-app.json)
2. The header comment in [hugo/layouts/robots.txt](../../../hugo/layouts/robots.txt)
3. The "Content policy" section in [hugo/layouts/_default/llms.txt](../../../hugo/layouts/_default/llms.txt) and [hugo/static/AGENTS.md](../../../hugo/static/AGENTS.md)

If any of those three drift apart, the policy a bot picks up depends on which surface it reads first — an outcome we want to avoid.

---

## Operational notes

### Tutorial HTML lives in HANA, not in Hugo statics

The AppRouter strips `hugo/public/tutorials/` during build (`rm -rf approuter/static/tutorials` in [.deploy/mta.yaml](../../../.deploy/mta.yaml)). All `/tutorials/*` requests go to the CAP backend, which decompresses HTML from HANA BLOBs and serves them.

**Implication**: any `<head>` change in this initiative requires a content republish to reach production tutorials. After `npm run build:all`:

```bash
export CONTENT_API_KEY="<DEV-content-api-key — fetch from BTP credstore, do NOT commit>"
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npm run publish-content -- --force
```

Always use `--force`. The default delta-detection mode breaks production for full snapshot rewrites — a known issue tracked in memory.

CI's [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) does this automatically when triggered.

### Content-Signal coverage requires the AppRouter

The CAP backend doesn't set `Content-Signal` on its responses — the AppRouter does, on the way through. If you ever bypass the AppRouter (direct `cap.cfapps.eu10-005.hana.ondemand.com/tutorials/*` access), the policy header is missing. This is fine for production because the AppRouter is the public origin; just be aware when debugging.

### Frontmatter `lastUpdated` is the long pole

The sitemap's `<lastmod>` precedence is `lastmod` → `lastUpdated` → `:git`. The `:git` fallback works, but there's a catch: when `npm run fetch-tutorials` regenerates `hugo/content/tutorials/`, the file mtime resets and the `:git` value reflects *the regeneration commit, not the upstream tutorial edit*. To get accurate freshness signals into the sitemap, the upstream tutorial author needs to bump `lastUpdated` in their frontmatter. The fetcher could be enhanced to read upstream commit history and inject `lastUpdated` automatically — that's a future improvement.

### Cache-busting after policy changes

Search engines and AI crawlers cache `robots.txt`, `sitemap.xml`, `llms.txt`, and per-page meta. After a policy change, expect a 24–72 hour propagation window before all crawlers reflect it. Forcing the issue requires manual resubmission via Search Console.

---

## File map

```
docs/
  ai-consumption.md                            ← this document
  superpowers/specs/2026-05-19-ai-friendly-site-design.md
  superpowers/plans/2026-05-19-ai-friendly-site.md

hugo/
  hugo.toml                                    ← brand, output formats, frontmatter precedence
  layouts/
    index.html                                 ← SSR homepage
    robots.txt                                 ← robots policy + AI allowlist
    _default/
      sitemap.xml                              ← custom sitemap
      llms.txt                                 ← llmstxt.org index
      llmsfull.txt                             ← full machine catalog
    partials/
      head.html                                ← assembles head from sub-partials
      head-meta.html                           ← canonical, description, robots, keywords, author
      head-og.html                             ← Open Graph + Twitter Card
      head-jsonld.html                         ← per-page HowTo/Course/BreadcrumbList/FAQPage
      site-jsonld.html                         ← sitewide Organization + WebSite
  static/
    AGENTS.md                                  ← public agent guidance
    img/og-default.png                         ← 1200×630 default OG image
  assets/css/
    home.css                                   ← homepage styles

approuter/
  xs-app.json                                  ← Content-Signal + X-Robots-Tag response headers

test/smoke/
  seo-files.test.js                            ← robots, sitemap, llms files, AGENTS, og image
  meta-tags.test.js                            ← title, canonical, description, OG, Twitter
  jsonld.test.js                               ← Organization, WebSite, HowTo, BreadcrumbList
  content-signal.test.js                      ← AI bot signal headers

AGENTS.md                                      ← repo-root agent guidance (for coding agents)
```
