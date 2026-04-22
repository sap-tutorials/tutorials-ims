# Tutorial Platform POC — Replace AEM with VitePress on BTP

**Date:** 2026-04-22
**Status:** Approved

## Summary

Replace Adobe Experience Manager (AEM) as the tutorial hosting platform on developers.sap.com with a VitePress static site deployed behind an AppRouter on SAP BTP. Tutorial markdown source remains in the `sap-tutorials` GitHub organization. A build pipeline fetches, parses, and transforms the markdown into VitePress pages styled with SAP Fundamental Styles. The AppRouter provides SAP IDP authentication via XSUAA and proxies API calls to the existing CAP/HANA backend for progress tracking, validation, and gamification. No new backend service is created.

## Key Decisions

- **No new CAP backend.** The existing CAP/HANA service already exposes progress, validation, and gamification APIs. The VitePress frontend consumes these directly through an AppRouter destination.
- **AEM is fully removed.** The AEM-specific endpoints (`/bin/sapdx/*`) are replaced by direct calls to the CAP backend. AEM content paths are not used.
- **VitePress + SAP Fundamental Styles.** VitePress generates static HTML from tutorial markdown. SAP Fundamental Styles provides the SAP design system. Custom Vue components handle interactive features (step completion, validation, progress).
- **Content from GitHub at build time.** Tutorials are fetched from `sap-tutorials` GitHub repos during the build, not at runtime. The v1/v2 markdown parsing logic documented in the sap-devs-cli tutorials spec is reimplemented in TypeScript (the sap-devs-cli version is Go).
- **Single MTA deployment.** AppRouter + static site in one deployment unit. The CAP backend is a separate, already-deployed service reached via BTP Destination.
- **POC scope:** 5 tutorials from the `hana-cloud-cap` mission, demonstrating the full mission > group > tutorial hierarchy, step navigation, progress tracking, validation, and points/badges.

## Architecture

```
Build time:
  sap-tutorials GitHub repos ──→ fetch + parse script ──→ VitePress .md files
                                  (v1/v2 parsers,          (SAP Fundamental
                                   image URL resolution)    Styles theme)
                                        │
                                        ▼
                                  vitepress build ──→ static HTML/JS/CSS

Runtime (BTP Cloud Foundry):
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  ┌──────────────┐    ┌────────────────────────────┐  │
  │  │  AppRouter    │───▶│  VitePress static site     │  │
  │  │  (XSUAA +    │    │  (tutorials, navigation,   │  │
  │  │   SAP IDP)   │    │   gamification UI)         │  │
  │  │              │    └────────────────────────────┘  │
  │  │  /api/* ─────│──▶ Existing CAP/HANA backend      │
  │  └──────────────┘    (via BTP Destination)           │
  │                                                      │
  └──────────────────────────────────────────────────────┘
```

### Current AEM Flow (being replaced)

```
Tutorial markdown (sap-tutorials GitHub)
  → GitHub Actions build → HTML
  → Deployed to AEM on developers.sap.com
  → AEM serves HTML + proxies to backend via /bin/sapdx/* endpoints
  → AEM handles auth via SAP IDP cookie
```

### New Flow

```
Tutorial markdown (sap-tutorials GitHub)
  → Build script fetches + parses markdown
  → VitePress builds static HTML/JS/CSS
  → MTA deploys AppRouter + static site to BTP CF
  → AppRouter handles auth via XSUAA/SAP IDP
  → Frontend calls CAP backend via AppRouter destination proxy
```

## Project Structure

```
tutorials-poc/
  approuter/
    package.json              — @sap/approuter dependency
    xs-app.json               — routing rules
  site/
    .vitepress/
      config.ts               — VitePress config
      theme/
        index.ts              — custom theme extending default
        styles/
          sap-fundamental.css — SAP Fundamental Styles integration
        components/
          TutorialLayout.vue  — main tutorial page layout
          TutorialStep.vue    — accordion step with Done button
          ProgressBar.vue     — tutorial/mission progress indicator
          PointsBadge.vue     — gamification points + badges display
          MiniNavigator.vue   — mission > group > tutorial sidebar tree
          StepValidation.vue  — inline validation form per step
          TutorialList.vue    — search/browse tutorial listing
    tutorials/                — generated at build time from GitHub
      hana-cloud-deploying.md
      hana-cloud-cap-create-project.md
      hana-cloud-cap-create-database-cds.md
      hana-cloud-cap-create-ui.md
      hana-cloud-cap-add-authentication.md
    index.md                  — tutorial navigator / listing page
  scripts/
    fetch-tutorials.ts        — GitHub fetch + parse pipeline
    parsers/
      v1.ts                   — ACCORDION format parser
      v2.ts                   — H3-delimited format parser
      images.ts               — relative → raw GitHub CDN URL resolver
      frontmatter.ts          — YAML frontmatter extraction
  mta.yaml
  xs-security.json
  package.json
```

## 1. AppRouter Configuration

### xs-app.json

```json
{
  "authenticationMethod": "route",
  "routes": [
    {
      "source": "^/api/(.*)$",
      "target": "$1",
      "destination": "tutorials-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^(.*)$",
      "localDir": "static",
      "authenticationType": "xsuaa"
    }
  ]
}
```

- All requests require XSUAA authentication (SAP IDP login).
- `/api/*` routes proxy to the existing CAP/HANA backend via a BTP Destination named `tutorials-api`. The AppRouter forwards the user's JWT token via `forwardAuthToken: true` on the destination configuration, so the CAP backend receives the authenticated user identity.
- All other routes serve the static VitePress build from the `static/` directory within the AppRouter module. The VitePress build output is copied into `approuter/static/` during the MTA build phase (see Section 6). This avoids `../` path traversals which do not resolve in a deployed CF app.

### Content Security Policy

The AppRouter needs CSP headers to allow YouTube embeds, SAP CDN resources for Fundamental Styles fonts/icons, and `raw.githubusercontent.com` for tutorial images. Add to `xs-app.json`:

```json
{
  "responseHeaders": [
    {
      "name": "Content-Security-Policy",
      "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; frame-src https://www.youtube.com; img-src 'self' https://raw.githubusercontent.com https://*.sap.com data:; style-src 'self' 'unsafe-inline' https://*.sap.com; font-src 'self' https://*.sap.com"
    }
  ]
}
```

### xs-security.json

```json
{
  "xsappname": "tutorials-poc",
  "tenant-mode": "dedicated",
  "scopes": [],
  "role-templates": [],
  "oauth2-configuration": {
    "redirect-uris": ["https://*.cfapps.*.hana.ondemand.com/**"]
  }
}
```

Minimal XSUAA config for the POC. No custom scopes — authentication only, authorization handled by the CAP backend.

## 2. Frontend API Contract

The VitePress frontend needs these capabilities from the CAP backend. The table maps what AEM was providing to the expected CAP equivalents.

| Frontend Need | AEM Endpoint (removed) | CAP Backend Equivalent |
|---|---|---|
| Tutorial search/browse with facets | `GET /bin/sapdx/v3/solr/search?json={...}` | `GET /api/tutorials?search=&level=&tags=` |
| Mission/group/tutorial navigation tree with progress | `GET /bin/sapdx/v2/tutorial/miniNavigator.{tutorialImsId}.{missionImsId}.json` | `GET /api/missions/{id}/navigation` |
| Mark tutorial step as complete | `POST /bin/sapdx/tutorials/progress` (body: `pagePath=<AEM path>`) | `POST /api/tutorials/{slug}/steps/{n}/complete` |
| User profile + auth state | `GET /bin/sapdx/auth.json/...` | `GET /api/me` (derived from XSUAA JWT — no AEM auth layer) |
| Points and badges | Embedded in miniNavigator and search responses (`taskProgress`, `statusTask`, `icon`) | `GET /api/me/achievements` |
| Tutorial metadata (tags, contentId) | `GET /bin/sapdxc/v2/tutorials/pageProperties.json/...` | Part of tutorial entity in CAP model |
| Step validation submission | Client-side in AEM (`SAP.sapdx.github.Storage` + localStorage) | `POST /api/tutorials/{slug}/steps/{n}/validate` (body: answers) |

### AEM API Surface (reference for mapping)

From live site analysis on 2026-04-22:

**Solr Search Response** (`/bin/sapdx/v3/solr/search`):
- `numFound`: 1664 total entries
- `countGroups`, `countMissions`, `countTutorials`: type counts
- `facets`: keyed by "Topic" and "Software Product" (UUID-based tag IDs)
- `result[]`: entries with `title`, `description`, `experience`, `imsId`, `primaryTag`, `taskType`, `time` (seconds), `icon` (SVG path), `itemsType`, `publicUrl`, `tasksCount`, `statusTask` (intact|progressive|completed), `taskProgress` (0-100), `isRequiredLicense`, `featured`, `featuredOrder`

**MiniNavigator Response** (`/bin/sapdx/v2/tutorial/miniNavigator.{ids}.json`):
- `context[]`: hierarchical tree — Mission contains Groups, Groups contain Tutorials
- Each node: `title`, `description`, `imsId`, `progress` (0-100), `taskType` (Mission|Group|Tutorial), `url`, `tutorialCount`, `tutorialCompleted`, `isSelected`, `includes[]`
- Tutorial nodes add: `timeToComplete` (seconds)

**Auth Response** (`/bin/sapdx/auth.json`):
- `isUserLoggedIn`, `firstName`, `lastName`, `email`, `userId` (e.g. "I809764"), `avatarLink`, `universalId`, `identityProvider` ("IDS"), `company`, `type` (employee|external)
- Profile links, logout URL, blocked status

**Progress Endpoint** (`/bin/sapdx/tutorials/progress`):
- POST with `Content-Type: application/x-www-form-urlencoded`, body: `pagePath=/content/developers/website/languages/en/tutorials/{slug}`
- Returns 201 (no body) on success
- AEM content path is the identifier — the CAP equivalent should use tutorial slug + step number instead

**PageProperties** (`/bin/sapdxc/v2/tutorials/pageProperties.json`):
- `contentId` (tutorial slug), `tags[]`, `damPath`, `bookmarkApiUrl` (people-api.services.sap.com), `tutorialNavigatorPath`

**Client-Side State:**
- `localStorage` key `tutorials.store` — per-page step completion state (sections, forms, validation status)
- Redux store with selectors: `progress.tutorial`, `progress.steps`, `page.steps`
- Step states: `completed`, `opened`; validation states: `validated`, `error`, `empty`
- `COMPLETION_DELAY`: 2000ms (UI delay after marking step done)

## 3. Build Pipeline

### fetch-tutorials.ts

Fetches tutorial markdown from the `sap-tutorials` GitHub organization. For the POC, scoped to the `hana-cloud-cap` mission tutorials.

```
fetch-tutorials.ts
  │
  ├─ 1. Fetch repo list
  │     GET raw.githubusercontent.com/sap-tutorials/Tutorials/master/config/repository-groups.json
  │     → cache locally
  │
  ├─ 2. For target tutorials, resolve repo + branch
  │     GET api.github.com/repos/sap-tutorials/{repo}
  │     → read default_branch (varies: "master" for Tutorials, "main" for others)
  │
  ├─ 3. Fetch full markdown
  │     GET raw.githubusercontent.com/sap-tutorials/{repo}/{branch}/tutorials/{slug}/{slug}.md
  │     → raw.githubusercontent.com is CDN, no API rate limit
  │
  ├─ 4. Parse markdown
  │     → Detect format: frontmatter `parser: v2` → v2 parser, else v1
  │     → Extract: title, description, time, level, tags, author
  │     → Split into steps (v2: H3 headings, v1: ACCORDION blocks)
  │     → Resolve relative image URLs to raw.githubusercontent.com
  │     → Handle OPTION blocks (render as labeled sections)
  │
  └─ 5. Write VitePress-compatible .md files
        → Custom frontmatter: slug, title, description, time, level, tags,
          missionId, groupId, stepCount, prev/next slugs
        → Step content with VitePress-compatible markup
        → Output to site/tutorials/{slug}.md
```

### Parser Formats

**v2 (current standard):** Steps delimited by `### Heading` (H3). Preamble before first `###` contains Prerequisites and "You will learn" sections.

**v1 (legacy):** Steps delimited by `[ACCORDION-BEGIN [Step N: ](Title)]` / `[ACCORDION-END]`.

**OPTION blocks:** `[OPTION BEGIN [Tab Name]]` / `[OPTION END]` pairs converted to a custom Vue component `<OptionTabs>` in the generated markdown. The parser outputs:

```md
<OptionTabs :tabs="['SAP Business Application Studio', 'Visual Studio Code']">
<template #tab-0>
... content for BAS ...
</template>
<template #tab-1>
... content for VS Code ...
</template>
</OptionTabs>
```

This preserves the tabbed selection UX from the current AEM site. `OptionTabs.vue` is a Vue component registered globally in the theme.

### Image URL Resolution

Relative paths like `![alt](27.png)` resolved to:
`![alt](https://raw.githubusercontent.com/sap-tutorials/{repo}/{branch}/tutorials/{slug}/27.png)`

Paths with `../` traversals left unchanged. Absolute URLs left unchanged.

### GitHub Rate Limiting

- POC scope: ~5 tutorials = ~5 raw content fetches (CDN, no rate limit) + ~2 API calls (repo metadata). Well within unauthenticated limits.
- Full scale: ~1,290 tutorials across ~22 repos. See sap-devs-cli tutorials spec for incremental sync strategy using tree SHA comparison.

## 4. VitePress Theme

### Dependencies

Root `package.json`:

```json
{
  "name": "tutorials-poc",
  "private": true,
  "scripts": {
    "fetch-tutorials": "tsx scripts/fetch-tutorials.ts",
    "build": "vitepress build site",
    "dev": "vitepress dev site",
    "preview": "vitepress preview site"
  },
  "devDependencies": {
    "vitepress": "^1.6",
    "vue": "^3.5",
    "tsx": "^4.0",
    "fundamental-styles": "^0.39",
    "gray-matter": "^4.0",
    "yaml": "^2.0"
  }
}
```

Node.js >= 20 required (for VitePress and native fetch in the build script).

### SAP Fundamental Styles Integration

SAP Fundamental Styles and VitePress's default theme use different CSS conventions. The integration strategy is a **hybrid approach**: use VitePress's default layout skeleton (sidebar, content area, nav) but override its CSS custom properties (`--vp-c-*`) to map to SAP Horizon theme tokens, and use Fundamental Styles components (`fd-*` classes) for interactive elements (buttons, cards, accordions, badges, progress indicators). The `sap-fundamental.css` file bridges the two:

```css
/* site/.vitepress/theme/styles/sap-fundamental.css */
@import 'fundamental-styles/dist/theming/sap_horizon.css';
@import 'fundamental-styles/dist/button.css';
@import 'fundamental-styles/dist/card.css';
@import 'fundamental-styles/dist/panel.css';
@import 'fundamental-styles/dist/progress-indicator.css';
@import 'fundamental-styles/dist/badge.css';
@import 'fundamental-styles/dist/icon.css';

:root {
  --vp-c-brand-1: var(--sapBrandColor);
  --vp-c-brand-2: var(--sapHighlightColor);
  --vp-c-bg: var(--sapBackgroundColor);
  --vp-c-text-1: var(--sapTextColor);
  --vp-font-family-base: var(--sapFontFamily);
}
```

This selectively imports only the Fundamental Styles modules used by the Vue components, avoiding the full ~500KB bundle. VitePress's layout structure is preserved; only colors, typography, and interactive components get the SAP treatment.

**Risk mitigation:** The CSS integration should be prototyped early (first implementation task) to validate that the hybrid approach renders correctly before building all Vue components on top.

### VitePress Layout Mechanism

Tutorial pages use a custom VitePress layout. Each generated `.md` file includes `layout: tutorial` in its frontmatter:

```yaml
---
layout: tutorial
slug: hana-cloud-cap-create-project
title: "Create a CAP Project for SAP HANA Cloud"
# ... other metadata
---
```

The theme registers `TutorialLayout` as the layout for `layout: tutorial` pages:

```ts
// site/.vitepress/theme/index.ts
import DefaultTheme from 'vitepress/theme'
import './styles/sap-fundamental.css'
import TutorialLayout from './components/TutorialLayout.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TutorialLayout', TutorialLayout)
  },
  Layout() {
    // VitePress uses the 'layout' frontmatter to select the component
  }
}
```

The `index.md` listing page uses the default VitePress layout with the `TutorialList.vue` component embedded.

### Vue Components

**TutorialLayout.vue** — Main tutorial page layout:
- Shell bar (SAP branding, user avatar, logout)
- Breadcrumb: Mission > Group > Tutorial
- Previous / Next navigation
- Main content area with step accordion
- Sidebar with MiniNavigator

**TutorialStep.vue** — Individual step within the accordion:
- Collapsible section with step title and number
- Markdown content rendered inside
- "Done" button at bottom (calls `POST /api/tutorials/{slug}/steps/{n}/complete`)
- Visual state: pending (grey), completed (green checkmark)
- Optional validation form before Done button is enabled

**ProgressBar.vue** — Progress indicator:
- Shown at tutorial level (N of M steps) and mission level (N of M tutorials)
- Percentage bar with SAP Fundamental Styles theming

**PointsBadge.vue** — Gamification display:
- Points counter
- Badge icons (SVGs from tutorial metadata)
- Achievement notifications on step/tutorial completion

**MiniNavigator.vue** — Sidebar navigation tree:
- Collapsible tree: Mission → Groups → Tutorials
- Current tutorial highlighted (`isSelected`)
- Per-node progress indicator
- Click to navigate between tutorials

**StepValidation.vue** — Inline validation:
- Validation questions are defined in the CAP backend (not in the tutorial markdown). The frontend fetches them per step from `GET /api/tutorials/{slug}/steps/{n}/validation`.
- Renders validation questions (multiple choice, text input) within a step
- Submits answers to `POST /api/tutorials/{slug}/steps/{n}/validate`
- Shows validated/error/empty state
- "Done" button disabled until validation passes
- **POC note:** If the CAP backend does not yet serve validation questions for the POC tutorials, the StepValidation component renders as a simple self-assessed "Mark as done" confirmation instead. Validation is a progressive enhancement.

**TutorialList.vue** — Tutorial navigator/search page:
- Search bar with full-text search
- Facet filters (level, topic, product)
- Card grid showing tutorials/missions with progress indicators
- Calls `GET /api/tutorials?search=&level=&tags=`

## 5. POC Tutorial Set

From the `hana-cloud-cap` mission (imsId 14094):

| Tutorial | Group | imsId | Time |
|---|---|---|---|
| Deploy SAP HANA Cloud | Setup (14091) | 13701 | 15 min |
| Create a CAP Project for SAP HANA Cloud | Setup (14091) | 13910 | 15 min |
| Create Database Artifacts Using CDS | Setup (14091) | 13919 | 15 min |
| Create a User Interface with CAP | Full-Stack (14092) | 14044 | 20 min |
| Add User Authentication | Full-Stack (14092) | 14050 | 20 min |

This set exercises:
- Full mission > group > tutorial hierarchy (1 mission, 2 groups, 5 tutorials)
- Step navigation within tutorials
- Previous/Next between tutorials in a group
- Progress tracking at all three levels
- Video embeds (cap-create-project has a YouTube video)
- Various step counts and content structures

## 6. MTA Deployment

Single AppRouter module that bundles the VitePress static site. The MTA build copies the VitePress dist output into the AppRouter's `static/` directory so the `localDir: "static"` route works at runtime.

```yaml
_schema-version: 3.3.0
ID: tutorials-poc
version: 1.0.0

modules:
  - name: tutorials-approuter
    type: approuter.nodejs
    path: approuter
    requires:
      - name: tutorials-xsuaa
      - name: tutorials-api-destination
    parameters:
      disk-quota: 256M
      memory: 256M
    build-parameters:
      builder: custom
      commands:
        - npm install --prefix ..
        - npm run fetch-tutorials --prefix ..
        - npm run build --prefix ..
        - mkdir -p static
        - cp -r ../site/.vitepress/dist/* static/

resources:
  - name: tutorials-xsuaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ../xs-security.json

  - name: tutorials-api-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
```

### Destination Configuration

The `tutorials-api` destination must be configured in the BTP cockpit (or via MTA extension):

| Property | Value |
| --- | --- |
| Name | `tutorials-api` |
| URL | `https://<cap-backend-app>.cfapps.<region>.hana.ondemand.com` |
| Authentication | `OAuth2UserTokenExchange` |
| Token Service URL | `https://<xsuaa-tenant>.authentication.<region>.hana.ondemand.com/oauth/token` |
| Client ID | *(from CAP backend XSUAA binding)* |
| Client Secret | *(from CAP backend XSUAA binding)* |

The `OAuth2UserTokenExchange` authentication type ensures the AppRouter exchanges the user's XSUAA token for one accepted by the CAP backend, preserving user identity across the proxy. The route in `xs-app.json` uses `"authenticationType": "xsuaa"` to trigger this flow.

## 7. Local Development

```bash
# Fetch tutorial content
npm run fetch-tutorials

# Start VitePress dev server with hot reload
npm run dev
# → VitePress dev server on http://localhost:5173

# API calls proxied to deployed CAP backend
# Configured in site/.vitepress/config.ts vite.server.proxy
```

VitePress config includes a Vite proxy for local dev:

```ts
// site/.vitepress/config.ts
export default {
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'https://<cap-backend-url>',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    }
  }
}
```

## 8. What This POC Proves

1. **AEM is unnecessary.** Tutorial content renders correctly as a VitePress static site with SAP styling.
2. **BTP-native auth works.** AppRouter + XSUAA provides SAP IDP authentication without any AEM auth layer.
3. **Existing backend is reusable.** The CAP/HANA service serves progress, validation, and gamification data directly.
4. **Build pipeline is viable.** GitHub markdown → VitePress build produces a deployable artifact.
5. **Interactive features survive.** Step completion, validation, progress tracking, and gamification all work in the new architecture.
6. **Navigation hierarchy is preserved.** Mission > Group > Tutorial structure renders correctly with the MiniNavigator sidebar.

## 9. Prerequisites (before implementation)

- **CAP API surface mapping (BLOCKER):** Before building Vue components, confirm the exact endpoint paths on the existing CAP/HANA backend and whether they match the contract in Section 2. Document the real request/response shapes. If endpoints are missing (e.g., no `GET /api/missions/{id}/navigation` equivalent), decide whether to: (a) add thin adapter endpoints to the CAP service, or (b) adjust the frontend to work with available APIs. The fallback for the POC is to mock missing endpoints with static JSON served from the AppRouter.

## 10. Open Questions / Gaps

- **Bookmarks:** The current site uses `people-api.services.sap.com/bs/bookmarks`. Need to determine if this is consumed from the CAP backend or called directly.
- **Full-scale build:** POC fetches 5 tutorials. Full migration (~1,290 tutorials) needs incremental sync, caching, and CI/CD pipeline integration. The sap-devs-cli spec has a detailed design for this. At scale, tutorial images should move to a proper CDN (e.g., BTP Object Store) rather than relying on `raw.githubusercontent.com`.
- **SEO / public access:** Current tutorials are publicly accessible (auth only needed for progress tracking). The POC requires login for all pages. A production version might need a split: public content + authenticated progress.
- **Video embeds:** YouTube embeds in tutorial steps need to work within VitePress markdown rendering. VitePress supports custom Vue components in markdown, so this is achievable.
- **VitePress search:** The POC uses server-side search via the CAP backend (`TutorialList.vue`). VitePress's built-in MiniSearch is disabled to avoid two competing search mechanisms. A production version might use client-side search for offline/fast filtering with server-side for faceted queries.
