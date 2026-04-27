# SAP Tutorial Platform

A VitePress-based static site replacing Adobe Experience Manager (AEM) and the Git-based authoring interface as the tutorial hosting platform for [developers.sap.com](https://developers.sap.com). Fetches tutorial markdown from the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization at build time, renders it with SAP Fiori Horizon styling, and deploys on SAP BTP Cloud Foundry behind an AppRouter with XSUAA authentication.

> **Note:** This project began as a proof-of-concept and has been promoted to a **production replacement** for the AEM tutorial hosting and Git interface portions of developers.sap.com (as of April 2026).

**Stack:** VitePress 1.6 &middot; Vue 3.5 &middot; SAP Fundamental Styles &middot; TypeScript &middot; SAP BTP

## Quick Start

**Prerequisites:** Node.js >= 20, npm

```bash
npm install
npm run fetch-tutorials
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

Tutorials must be fetched before running `dev` or `build`. The fetch step downloads markdown from GitHub, parses it, and generates VitePress pages in `site/tutorials/`.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run fetch-tutorials` | Fetch tutorial markdown from GitHub, parse, and generate VitePress pages |
| `npm run dev` | Start VitePress dev server with hot reload |
| `npm run build` | Production build to `site/.vitepress/dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run generate-dark-theme` | Regenerate dark theme CSS variables from Fundamental Styles |
| `npm run test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | No | GitHub personal access token. Avoids API rate limits when fetching commit metadata (authors, timestamps). Without it, unauthenticated requests may fail on repeated builds. |

## Project Structure

```
tutorials-poc/
├── site/                          # VitePress source
│   ├── .vitepress/
│   │   ├── config.ts              # VitePress + Vite proxy config
│   │   └── theme/
│   │       ├── index.ts           # Custom theme entry (layout routing)
│   │       ├── components/        # Vue components (layouts, steps, nav)
│   │       ├── composables/       # useApi, useAemEnrichment
│   │       └── styles/            # SAP Fundamental CSS, Horizon vars, dark theme
│   ├── tutorials/                 # Generated pages (gitignored)
│   ├── index.md                   # Tutorial Navigator landing page
│   └── app-space.md               # Event-themed tutorial space
├── scripts/
│   ├── fetch-tutorials.ts         # Main build script: fetch + parse + generate
│   ├── generate-dark-theme.ts     # Dark theme CSS generator
│   ├── parsers/
│   │   ├── v1.ts                  # Legacy parser (ACCORDION markers)
│   │   ├── v2.ts                  # Current parser (H3 headings)
│   │   ├── frontmatter.ts         # YAML frontmatter extraction
│   │   ├── images.ts              # Image URL resolution + comment stripping
│   │   ├── options.ts             # Option blocks → OptionTabs components
│   │   ├── github.ts              # GitHub API: commits, authors, timestamps
│   │   └── types.ts               # Shared TypeScript types
│   └── __tests__/                 # Vitest unit tests for all parsers
├── approuter/                     # SAP AppRouter (BTP deployment)
│   ├── xs-app.json                # Route config: /api/* → Destination, /* → static
│   └── package.json               # @sap/approuter dependency
├── .tutorial-cache/               # Build cache (gitignored)
├── mta.yaml                       # MTA deployment descriptor
├── xs-security.json               # XSUAA service config
└── package.json                   # Scripts, devDependencies, type: module
```

## Architecture

### Build Pipeline

```
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts         Fetch raw markdown (cached in .tutorial-cache/)
    → scripts/parsers/*                Parse frontmatter, steps, images, options
      → site/tutorials/*.md            Generated VitePress pages with YAML frontmatter
        → site/tutorials/_nav.json     Navigation index for Tutorial Navigator
```

### Frontend

The site uses VitePress with a fully custom Vue 3 theme. Layout routing is driven by the `layout` field in each page's YAML frontmatter:

- `layout: tutorial` renders via `TutorialLayout.vue` (step accordion, sidebar TOC, progress)
- `layout: mission` renders via `MissionLayout.vue` (collapsible groups, hero banner)
- `layout: group` renders via `GroupLayout.vue` (timeline of tutorials)
- Default layout renders `TutorialNavigator.vue` on the home page (search, facet filters, card grid)

### Styling

Hybrid approach combining VitePress layout with SAP Fundamental Styles (Horizon theme):

- SAP `fd-*` CSS classes for UI components (breadcrumbs, buttons, forms)
- CSS custom properties bridge VitePress tokens (`--vp-c-*`) to SAP Horizon tokens (`--sap*`)
- Full dark mode support via SAP Horizon dark theme variables
- Event theme overlays (Joule, Sapphire) via `data-theme` CSS attribute selectors

**Important:** Always use `--sap*` CSS variables for colors, never hardcode hex values. This ensures dark mode and theme variants work correctly.

### Dev Proxies

During local development, Vite proxies two paths:

| Path | Target | Purpose |
|------|--------|---------|
| `/api/*` | `http://localhost:4004` | CAP/HANA backend (progress, points) |
| `/bin/sapdx/*` | `https://developers.sap.com` | Legacy AEM endpoints (enrichment data) |

## Tutorial Parser Formats

The build script auto-detects parser format via the `parser` frontmatter field:

**V2 (current):** Uses `###` (H3) headings to delimit steps. Each H3 becomes a step title.

**V1 (legacy):** Uses `[ACCORDION-BEGIN]` / `[ACCORDION-END]` markers from the original AEM platform.

Both parsers share common processing:

- **Image resolution:** Relative paths (e.g., `trial4.png`) are converted to absolute GitHub raw URLs (`https://raw.githubusercontent.com/sap-tutorials/{repo}/{branch}/tutorials/{slug}/trial4.png`)
- **Comment stripping:** SAP tutorial conventions like `<!-- border -->` before images are removed so VitePress can parse the markdown correctly
- **Option blocks:** `[OPTION BEGIN]` / `[OPTION END]` markers are converted to `<OptionTabs>` Vue components for tabbed content

## Key Components

| Component | Purpose |
|-----------|---------|
| `TutorialNavigator.vue` | Home page: search bar, facet filters, mission/group/tutorial card grid |
| `TutorialLayout.vue` | Tutorial shell: breadcrumbs, step accordion, sidebar TOC, progress tracking |
| `MissionLayout.vue` | Mission detail: hero banner, collapsible group cards, progress |
| `GroupLayout.vue` | Group detail: tutorial timeline with completion status |
| `TutorialStep.vue` | Collapsible step with Done button and optional quiz validation |
| `FeedbackShareBar.vue` | Action bar with Feedback popup (community, GitHub, survey) and Share popup (social) |
| `AppSpace.vue` | Event-themed tutorial space with Joule/Sapphire branding |
| `TutorialNavigatorDropdown.vue` | Breadcrumb dropdown for quick mission/group navigation |

## Deployment (SAP BTP Cloud Foundry)

The project deploys as a single MTA (Multi-Target Application):

```
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar
```

### What the MTA Build Does

1. Runs `npm install` + `npm run fetch-tutorials` + `npm run build`
2. Copies `site/.vitepress/dist/*` into `approuter/static/`
3. Deploys the AppRouter module to Cloud Foundry

### Required BTP Services

| Service | Plan | Purpose |
|---------|------|---------|
| XSUAA | `application` | SAP IDP authentication (OAuth2/JWT) |
| Destination | `lite` | Proxy `/api/*` requests to a CAP/HANA backend |

### Route Architecture

```
Browser → AppRouter (XSUAA auth)
  → /api/*     → BTP Destination → CAP backend
  → /*         → static/ (VitePress build)
```

## Testing

```bash
npm run test                                    # Run all tests
npm run test:watch                              # Watch mode
npx vitest run scripts/__tests__/v1.test.ts     # Single test file
```

Test coverage includes unit tests for all parsers: V1 step extraction, V2 step extraction, frontmatter parsing, image URL resolution, and option block conversion.

## Development Notes

- **`site/tutorials/` is entirely generated.** Never edit these files directly. They are overwritten by `npm run fetch-tutorials`. To change tutorial content, edit the source in the `sap-tutorials` GitHub org. To change how content is parsed, edit `scripts/parsers/`.

- **The tutorial list is hardcoded.** The tutorials (one mission, two groups) are defined in the `POC_TUTORIALS` array at the top of `scripts/fetch-tutorials.ts`. Adding tutorials means editing that array. This will be replaced with dynamic discovery as part of the production buildout.

- **Validation quiz data is hardcoded.** The `VALIDATION_DATA` object in `scripts/fetch-tutorials.ts` contains step quiz questions. Production will source these from the CAP backend.

- **Cache clearing.** `.tutorial-cache/` caches raw markdown and GitHub metadata. Delete it to force a full re-fetch from GitHub. There is no incremental invalidation.

- **Dark mode.** Use `--sap*` CSS custom properties for all colors. The Horizon dark theme remaps these variables automatically. SVG icons should use `currentColor` to inherit theme colors.

## License

SAP Internal &mdash; Not for redistribution.
