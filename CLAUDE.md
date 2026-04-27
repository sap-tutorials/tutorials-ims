# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A VitePress-based static site POC that replaces Adobe Experience Manager (AEM) as the tutorial hosting platform for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub organization at build time, parses it into VitePress pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA authentication.

## Commands

```bash
# Quick start
npm install && npm run fetch-tutorials && npm run dev

npm install                                   # Install dependencies
npm run fetch-tutorials                       # Fetch tutorial markdown from GitHub (required before dev/build)
npm run dev                                   # VitePress dev server (http://localhost:5173)
npm run build                                 # Production build → site/.vitepress/dist/
npm run preview                               # Preview production build locally
npm run generate-dark-theme                   # Generate dark theme CSS variables
npm run test                                  # Run all tests (vitest)
npm run test:watch                            # Run tests in watch mode
npx vitest run scripts/__tests__/v1.test.ts   # Run a single test file
```

Tutorials must be fetched before `dev` or `build`. Fetched markdown is cached in `.tutorial-cache/` and generated pages go to `site/tutorials/` — both are gitignored. To force re-fetch from GitHub, delete `.tutorial-cache/`.

## Architecture

### Build Pipeline

```
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts (fetch + cache raw markdown)
    → scripts/parsers/ (parse frontmatter, steps, images, options)
      → site/tutorials/*.md (generated VitePress pages with YAML frontmatter)
        → site/tutorials/_nav.json (navigation index)
```

### Frontend (VitePress + Vue 3)

- **Entry**: `site/.vitepress/config.ts` (VitePress config) and `site/.vitepress/theme/index.ts` (custom theme)
- **Layout routing**: Pages with `layout: tutorial` in frontmatter render via `TutorialLayout.vue`; all others use VitePress default layout
- **Styling**: Hybrid approach — VitePress layout skeleton with SAP Fundamental Styles components (`fd-*` classes). CSS custom properties bridge VitePress tokens (`--vp-c-*`) to SAP Horizon tokens (`--sap*`). See `site/.vitepress/theme/styles/sap-fundamental.css`
- **Pages**: `site/index.md` renders `TutorialNavigator.vue` (search/filter card grid); `site/app-space.md` renders `AppSpace.vue` (event-themed tutorial space)
- **API layer**: `site/.vitepress/theme/composables/useApi.ts` — wraps fetch calls to `/api/*`, which proxy to a CAP/HANA backend

### Key Vue Components (site/.vitepress/theme/components/)

| Component | Purpose |
|---|---|
| TutorialNavigator.vue | Landing page: search, facet filters, mission/group/tutorial card grid. Loads nav data from `/tutorials/_nav.json` |
| TutorialLayout.vue | Tutorial page shell: breadcrumbs, steps, sidebar TOC, progress, prev/next nav. Uses Vue `provide`/`inject` to share step completion state with child components |
| TutorialStep.vue | Collapsible step accordion with Done button and optional validation. Injected state from TutorialLayout |
| AppSpace.vue | Event-themed tutorial space (Joule/Sapphire themes). Fetches live data from developers.sap.com AEM API |

### Deployment (BTP Cloud Foundry)

Single MTA deployment (`mta.yaml`): AppRouter module serves VitePress static build from `approuter/static/`. The MTA build phase runs fetch + build + copies dist into the approuter. XSUAA provides SAP IDP authentication. `/api/*` routes proxy to an existing CAP/HANA backend via BTP Destination.

### Parsers (scripts/parsers/)

The fetch script detects parser format via frontmatter field `parser: v2`. V2 uses H3 headings to delimit steps; V1 (legacy) uses `[ACCORDION-BEGIN]`/`[ACCORDION-END]` markers. `images.ts` resolves relative image paths to `raw.githubusercontent.com` CDN URLs. `options.ts` converts `[OPTION BEGIN]`/`[OPTION END]` blocks to `<OptionTabs>` Vue components. Shared types in `types.ts`.

## Gotchas

- **`site/tutorials/` is entirely generated** — never edit these files directly. They are overwritten by `npm run fetch-tutorials`. Edit the parsers in `scripts/parsers/` or the source tutorials in the `sap-tutorials` GitHub org instead.
- **POC tutorial list is hardcoded** — The 5 tutorials are defined in the `POC_TUTORIALS` array at the top of `scripts/fetch-tutorials.ts`. Adding tutorials means editing that array.
- **Validation quiz data is hardcoded** — The `VALIDATION_DATA` object in `scripts/fetch-tutorials.ts` contains step quiz questions, not the CAP backend. This is a POC shortcut.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses this to avoid GitHub API rate limits when fetching commit metadata. Without it, unauthenticated requests may hit rate limits on repeated builds.
- **Cache clearing** — `.tutorial-cache/` caches both raw markdown and GitHub metadata. Delete it to force a full re-fetch. There is no incremental invalidation.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).

## VitePress Dev Proxy

During local dev, `site/.vitepress/config.ts` configures Vite proxy:
- `/api/*` → `http://localhost:4004` (CAP backend)
- `/bin/sapdx/*` → `https://developers.sap.com` (legacy AEM endpoints for reference)
