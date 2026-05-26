# VitePress Documentation Site — Design

**Date:** 2026-05-25
**Branch target:** `docs/vitepress-site`
**Hosting target:** GitHub Pages, default URL `https://sap-tutorials.github.io/tutorials-poc/`
**Backend:** none — pure static site, separate from CAP / Hugo / approuter.

## Goal

Stand up a public VitePress documentation site for the existing reorganized `docs/` tree, deployed to GitHub Pages via a GitHub Actions workflow, with custom Horizon theming (light + dark, OS-default detection) and self-hosted SAP "72" typography. The site renders the four persona folders (`end-users/`, `authors/`, `developers/`, `historic/`) plus a feature-driven homepage from `docs/README.md`.

## Non-goals

- No replacement of the Hugo tutorial site (`hugo/`) — that continues to serve `developers.sap.com` content.
- No publishing of `docs/improvements.md`, `docs/TODO.md`, `docs/pilot-status.md`, `docs/superpowers/`, project root `README.md`, or `CLAUDE.md` to the public site.
- No PR-preview deploys in v1 (single production deploy on push to `main`).
- No custom domain in v1 — `base: '/tutorials-poc/'` keeps the option open for later.
- No Vue component overrides of the VitePress default theme — CSS variable bridge only.
- No automated visual-regression testing.
- No i18n / multi-language.
- No VitePress 2.x adoption — pin 1.6.x stable until 2.0 reaches GA.
- No new CAP service, entity, or endpoint. No HANA work. No MTA / approuter changes.

## Architecture

### Files

| File | Action | Purpose |
|---|---|---|
| `docs/.vitepress/config.ts` | **create** | `defineConfig` — title, description, `base: '/tutorials-poc/'`, `cleanUrls: true`, `srcExclude`, top nav, manual sidebar, `search: { provider: 'local' }`, `appearance: 'auto'`, `editLink`, `lastUpdated: true`, `socialLinks`, `head` (preload "72" font variants). |
| `docs/.vitepress/theme/index.ts` | **create** | Extends `DefaultTheme`; imports `fonts.css` + `horizon-bridge.css`. No `enhanceApp`, no Layout override, no Vue components. |
| `docs/.vitepress/theme/styles/fonts.css` | **create** | `@font-face` rules for SAP "72" variants resolved from `@sap-theming/theming-base-content`; `font-display: swap`. |
| `docs/.vitepress/theme/styles/horizon-bridge.css` | **create** | Reassigns `--vp-c-*` (brand, surface, text, border, code) and `--vp-font-family-base` to Horizon equivalents under `:root` (light) and `.dark` (dark). Pins Shiki themes via VitePress's `markdown.theme`. |
| `docs/.vitepress/public/favicon.svg` | **create** | SAP-style favicon. |
| `docs/.vitepress/public/logo-light.svg` | **create** | Wordmark for light mode hero. |
| `docs/.vitepress/public/logo-dark.svg` | **create** | Wordmark for dark mode hero. |
| `docs/README.md` | **modify** | Replace persona-index body with VitePress home-layout frontmatter (`layout: home`, `hero`, `features`). |
| `docs/historic/vitepress-2x-upgrade-assessment.md` | **untouched** | Becomes part of public site under `/historic/` — useful artifact for the 1.x version pin rationale. |
| `package.json` | **modify** | Add `vitepress` and `vue` to `devDependencies`; add `@sap-theming/theming-base-content` to `devDependencies`; add scripts: `docs:dev`, `docs:build`, `docs:preview`, `predocs:build` (sidebar check). |
| `package-lock.json` | **modify** | Refreshed by `npm install`. |
| `scripts/check-docs-sidebar.cjs` | **create** | Walks `docs/<persona>/**/*.md` (minus excluded patterns), parses sidebar config from `docs/.vitepress/config.ts`, exits non-zero with a diff if any page is unregistered or any registered link is dead. Hooked as `predocs:build`. |
| `.github/workflows/docs-deploy.yml` | **create** | Build → upload-pages-artifact → deploy-pages, on push to `main` paths `docs/**` and `package*.json`, plus `workflow_dispatch`. `concurrency: pages, cancel-in-progress: false`. |
| `.gitignore` | **modify** | Add `docs/.vitepress/dist/` and `docs/.vitepress/cache/`. |
| `docs/authors/README.md` | **modify** | Append a short "Updating the docs site sidebar" note pointing at `docs/.vitepress/config.ts`. |
| `CLAUDE.md` | **modify** | Update the "Documentation" section to mention the public docs site URL and the build commands. |

No backend changes. No schema. No DB. No CAP service, no entity, no endpoint.

## Behavior

### Routing

- `base: '/tutorials-poc/'` — site lives at `https://sap-tutorials.github.io/tutorials-poc/`. Future custom-domain switch is a one-file change (drop a `CNAME` in `docs/.vitepress/public/`) plus DNS.
- `srcDir` defaults to `docs/`; `outDir` defaults to `docs/.vitepress/dist`.
- `cleanUrls: true` — URLs drop the trailing `.html`.
- `docs/README.md` → `/tutorials-poc/` (homepage).
- Each persona's `README.md` → `/tutorials-poc/<persona>/` (landing page).
- Persona pages map directly: `docs/end-users/getting-started.md` → `/tutorials-poc/end-users/getting-started`.

### Excluded from build

`themeConfig.srcExclude`:
```
['improvements.md', 'TODO.md', 'pilot-status.md', 'superpowers/**']
```

The project root `README.md` and `CLAUDE.md` are never in `docs/` so they're outside `srcDir` and require no exclusion.

### Top navigation

```ts
nav: [
  { text: 'End Users',   link: '/end-users/' },
  { text: 'Authors',     link: '/authors/' },
  { text: 'Developers',  link: '/developers/' },
  { text: 'Historic',    link: '/historic/' }
]
```

Plus the built-in search box, theme toggle (Auto / Light / Dark), and a `socialLinks` GitHub icon pointing at `https://github.com/sap-tutorials/tutorials-poc`.

### Sidebar

Manual configuration keyed by URL prefix. VitePress shows the matching block based on the current page path.

- `/end-users/` — flat list of 6 pages.
- `/authors/` — flat list of 5 pages.
- `/developers/` — sub-grouped: Overview / Getting Started, Architecture, Operations, Reference (Reference collapsed by default).
- `/historic/` — flat list of 10 pages, alphabetical.

Maintenance contract: when an author adds a new persona page, they edit `docs/.vitepress/config.ts → themeConfig.sidebar`. The `predocs:build` sidebar-completeness check (see Tests) catches forgotten registrations.

### Theming bridge

`horizon-bridge.css` overrides only the visual `--vp-` tokens; structural tokens (spacing, transitions, z-index) stay at default. Two value sets:

- `:root { ... }` — light mode (Horizon brand `#0070f2`, white surfaces, near-black text).
- `.dark { ... }` — dark mode (Horizon brand `#1b90ff`, neutral dark gray surfaces, off-white text).

Token groups overridden:
1. **Brand** — `--vp-c-brand-1`, `--vp-c-brand-2`, `--vp-c-brand-3`, `--vp-c-brand-soft`.
2. **Surface** — `--vp-c-bg`, `--vp-c-bg-alt`, `--vp-c-bg-elv`, `--vp-c-text-1`, `--vp-c-text-2`, `--vp-c-text-3`, `--vp-c-divider`, `--vp-c-border`.
3. **Typography** — `--vp-font-family-base` set to `"72", "72full", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.
4. **Code blocks** — `--vp-code-bg`, `--vp-code-block-bg` to match Horizon surface contrast. Shiki themes pinned to `github-light` / `github-dark` via `markdown: { theme: { light: 'github-light', dark: 'github-dark' } }` in config.

No selectors target VitePress's internal class names (`.VPNavBar`, etc.) — those are private API.

### Light/dark detection

- `themeConfig.appearance: 'auto'` (VitePress default).
- First visit: VitePress reads `prefers-color-scheme` and applies `.dark` class accordingly.
- Subsequent visits: explicit user toggle persists to `localStorage`; toggle button is rendered automatically by the default theme.
- No JS in our theme code.

### Typography

- `@font-face` rules in `fonts.css` reference `.woff2` files in `@sap-theming/theming-base-content/content/Base/baseLib/baseTheme/fonts/` (or equivalent path within the package — exact path verified during implementation).
- Variants loaded: `72-Regular`, `72-Bold` (preloaded via `head`), plus `72-Italic`, `72-Light`, `72-Bold-Italic` lazy.
- `font-display: swap` to avoid blocking first paint.
- Two preload `<link>` tags emitted via `head` config for `72-Regular` and `72-Bold`.

### Homepage

`docs/README.md` frontmatter:

```yaml
---
layout: home
hero:
  name: SAP Tutorials Platform
  tagline: The platform behind developers.sap.com — for readers, authors, and engineers.
  image:
    src: /logo-light.svg
    alt: SAP Tutorials
features:
  - title: For Readers
    details: How developers.sap.com works, signing in, progress, privacy, and accessibility.
    link: /end-users/
    linkText: Read the user guide
  - title: For Authors
    details: Writing tutorials, validating with the QA preview channel, and getting them into developers.sap.com.
    link: /authors/
    linkText: Author a tutorial
  - title: For Platform Engineers
    details: Local dev, architecture, operations, and reference for the team running the platform.
    link: /developers/
    linkText: Engineer's guide
  - title: Historic
    details: How AEM, IMS, and the legacy migrations worked — for context when reading older code.
    link: /historic/
    linkText: How it used to be
---
```

The current persona-index body is removed; the cross-cutting links section (improvements/TODO/pilot-status) is dropped from the public homepage. Those files remain on disk.

### Search

`themeConfig.search: { provider: 'local' }`. Index built at compile time, shipped as JSON. Modal triggered by `Ctrl+K` / `Cmd+K`. Works offline once a page has loaded.

### Edit links and timestamps

```ts
editLink: {
  pattern: 'https://github.com/sap-tutorials/tutorials-poc/edit/main/docs/:path',
  text: 'Suggest an edit on GitHub'
},
lastUpdated: true
```

### Build

`docs:build` runs `vitepress build docs`. Pre-step `predocs:build` runs `node scripts/check-docs-sidebar.cjs` — fails the build if the sidebar config and the on-disk page list disagree.

VitePress's `ignoreDeadLinks: false` (default) fails the build on dead in-page links and `[text](broken.md)` references. The link sweep before first build (see Migration) ensures the initial state is clean.

### Deploy

`.github/workflows/docs-deploy.yml`:

```yaml
name: Deploy Docs to GitHub Pages
on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - '.github/workflows/docs-deploy.yml'
      - 'package.json'
      - 'package-lock.json'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Pages source must be set to "GitHub Actions" via repo Settings → Pages — one-time manual step documented in the implementation plan.

## Migration of existing content

### Link sweep

Before first successful build, run a grep sweep for links pointing at excluded files:

```
grep -rEn '\]\((\.\./)*(?:improvements|TODO|pilot-status)\.md|\]\((\.\./)*superpowers/' docs/
```

Each hit is rewritten or removed manually (preserves editorial intent). VitePress's dead-link check then enforces correctness on every subsequent build.

### Frontmatter

No bulk changes. Pages without `title:` inherit their first H1 — the existing 44 persona pages all have an H1. Pages with `description:` get used in `<meta name="description">` automatically.

### Code-fence languages

Existing pages already tag fences correctly (`bash`, `ts`, `js`, `yaml`, `json`, `cds`, `sql`). Shiki renders them via the pinned `github-light` / `github-dark` themes.

### Shortcodes

Hugo shortcodes (`{{< mermaid >}}`, etc.) do not appear in `docs/` — those live in `hugo/content/tutorials/`. Verified during the persona reorg. No migration work needed.

## Tests

### Unit-level

- `scripts/check-docs-sidebar.cjs` — run as `predocs:build` and as a step in CI. Walks `docs/<persona>/**/*.md` (minus `srcExclude` patterns), extracts the sidebar config, and exits non-zero if any page is unregistered or any registered link is missing on disk. Replaces the human checklist for "did I add the new page to the sidebar?"

### Build-level

- `npm run docs:build` runs `predocs:build` then `vitepress build docs`. Exit zero requires:
  - sidebar check pass
  - all markdown compiles
  - zero dead links (in-page anchors and inter-page references)
  - all referenced assets present (favicon, logos, fonts)

### Integration / smoke

- No automated smoke against the deployed Pages URL in v1. Pages deploys are deterministic; failures are caught at build.
- After the first deploy, a one-time manual verification checklist (in the implementation plan) walks each persona, toggles theme, confirms "72" loads, and runs an axe-core scan on two pages.

### What is intentionally NOT tested

- Visual regression (no Percy/Chromatic in v1).
- Lighthouse perf budgets (manual one-off after first deploy if curiosity strikes).
- Cross-browser parity beyond the latest Chrome/Firefox/Safari (default-theme problem, not ours).

## Rollout

Three phases, each gated:

1. **Build, no publish.** Land a PR with all VitePress + theme + content changes, but with the workflow's `on.push` block commented out and Pages source still "None" in repo settings. Author iterates locally with `npm run docs:dev` and `npm run docs:build`. Tom reviews the PR.
2. **Manual first deploy.** Repo owner flips Pages source to "GitHub Actions"; uncomments the `on.push` block in the workflow; triggers `workflow_dispatch`. Site goes live. Manual verification checklist runs.
3. **Steady state.** Push-to-main triggers automatic rebuild. No further manual steps.

### Backout

Set Pages source back to "None" — site goes 404 immediately, no redeploy needed. The MTA / Hugo / CAP deploys are entirely independent.

## Success criteria

- `https://sap-tutorials.github.io/tutorials-poc/` returns 200 and renders the homepage with Horizon styling.
- All four persona landing pages reachable from top nav.
- Search returns results for "publish-content" and "QA channel".
- Theme toggle cycles Auto / Light / Dark and persists across reloads.
- OS dark mode is honored on first visit (clear `localStorage`, set OS to dark, hard reload).
- "72" font is loading from `@sap-theming/theming-base-content` (verified in DevTools → Network).
- `docs:build` runs in under 60 seconds on Actions.
- Zero dead links in the build.
- `predocs:build` sidebar check passes.
- No regression to `npm run dev`, `npm run build:all`, `npm test`, `npm run test:hybrid`, `npm run test:smoke`, or any existing CI workflow.

## Open questions / explicit deferrals

| Topic | Resolution |
|---|---|
| Custom domain | Deferred. Design accommodates via CNAME drop-in. |
| PR-preview deploys | Deferred. Add as follow-on once steady-state is proven. |
| SAP "72" font licensing for public hosting | Self-hosted via the public `@sap-theming/theming-base-content` npm package, same exposure model as UI5 apps on public BTP routes. If Legal pushes back specifically on docs sites, single-file rollback to system-font fallback. |
| VitePress 2.x | Defer until GA. `docs/historic/vitepress-2x-upgrade-assessment.md` already documents the eventual upgrade path. |
| Frontmatter linting | Out of scope. Add as a follow-on if drift becomes a problem. |
| Multi-language | Out of scope. |
| Visual regression testing | Out of scope. |
| What's New / changelog feed | Out of scope. |
| Cross-linking from `developers.sap.com` to specific docs pages | Out of scope. |
