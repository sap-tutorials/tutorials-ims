# Tutorial Platform POC — Replace AEM with VitePress on BTP

**Date:** 2026-04-22
**Status:** Approved

## Summary

Replace Adobe Experience Manager (AEM) as the tutorial hosting platform on developers.sap.com with a VitePress static site deployed behind an AppRouter on SAP BTP. Tutorial markdown source remains in the `sap-tutorials` GitHub organization. A build pipeline fetches, parses, and transforms the markdown into VitePress pages styled with SAP Fundamental Styles. The AppRouter provides SAP IDP authentication via XSUAA and proxies API calls to the existing CAP/HANA backend for progress tracking, validation, and gamification. No new backend service is created.

## Key Decisions

- **No new CAP backend.** The existing CAP/HANA service already exposes progress, validation, and gamification APIs. The VitePress frontend consumes these directly through an AppRouter destination.
- **AEM is fully removed.** The AEM-specific endpoints (`/bin/sapdx/*`) are replaced by direct calls to the CAP backend. AEM content paths are not used.
- **VitePress + SAP Fundamental Styles.** VitePress generates static HTML from tutorial markdown. SAP Fundamental Styles provides the SAP design system. Custom Vue components handle interactive features (step completion, validation, progress).
- **Content from GitHub at build time.** Tutorials are fetched from `sap-tutorials` GitHub repos during the build, not at runtime. The same v1/v2 markdown parsers documented in the sap-devs-cli tutorials spec are reused.
- **Single MTA deployment.** AppRouter + static site in one deployment unit. The CAP backend is a separate, already-deployed service reached via BTP Destination.
- **POC scope:** 3-5 tutorials from the `hana-cloud-cap` mission, demonstrating the full mission > group > tutorial hierarchy, step navigation, progress tracking, validation, and points/badges.

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
      "authenticationType": "xsuaa"
    },
    {
      "source": "^(.*)$",
      "localDir": "../site/.vitepress/dist",
      "authenticationType": "xsuaa"
    }
  ]
}
```

- All requests require XSUAA authentication (SAP IDP login).
- `/api/*` routes proxy to the existing CAP/HANA backend via a BTP Destination named `tutorials-api`.
- All other routes serve the static VitePress build.

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

**OPTION blocks:** `[OPTION BEGIN [Tab Name]]` / `[OPTION END]` pairs rendered as labeled subsections.

### Image URL Resolution

Relative paths like `![alt](27.png)` resolved to:
`![alt](https://raw.githubusercontent.com/sap-tutorials/{repo}/{branch}/tutorials/{slug}/27.png)`

Paths with `../` traversals left unchanged. Absolute URLs left unchanged.

### GitHub Rate Limiting

- POC scope: ~5 tutorials = ~5 raw content fetches (CDN, no rate limit) + ~2 API calls (repo metadata). Well within unauthenticated limits.
- Full scale: ~1,290 tutorials across ~22 repos. See sap-devs-cli tutorials spec for incremental sync strategy using tree SHA comparison.

## 4. VitePress Theme

### SAP Fundamental Styles Integration

Install `fundamental-styles` npm package. Import core styles in the custom theme:

```ts
// site/.vitepress/theme/index.ts
import DefaultTheme from 'vitepress/theme'
import './styles/sap-fundamental.css'
import TutorialLayout from './components/TutorialLayout.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TutorialLayout', TutorialLayout)
  }
}
```

Override VitePress CSS variables to match SAP Horizon theme colors, typography, and spacing.

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
- Renders validation questions (multiple choice, text input) within a step
- Submits answers to `POST /api/tutorials/{slug}/steps/{n}/validate`
- Shows validated/error/empty state
- "Done" button disabled until validation passes

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

  - name: tutorials-site
    type: staticfile
    path: site/.vitepress/dist
    build-parameters:
      builder: custom
      commands:
        - npm run fetch-tutorials
        - npm run build

resources:
  - name: tutorials-xsuaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: xs-security.json

  - name: tutorials-api-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
```

The destination `tutorials-api` must be configured in the BTP cockpit to point at the existing CAP/HANA backend URL.

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

## 9. Open Questions / Gaps

- **CAP API surface mapping:** Need to confirm the exact endpoint paths on the existing CAP backend and whether they match the contract in Section 2. Any gaps need thin adapter endpoints or frontend adjustments.
- **Bookmarks:** The current site uses `people-api.services.sap.com/bs/bookmarks`. Need to determine if this is consumed from the CAP backend or called directly.
- **Full-scale build:** POC fetches 5 tutorials. Full migration (~1,290 tutorials) needs incremental sync, caching, and CI/CD pipeline integration. The sap-devs-cli spec has a detailed design for this.
- **SEO / public access:** Current tutorials are publicly accessible (auth only needed for progress tracking). The POC requires login for all pages. A production version might need a split: public content + authenticated progress.
- **Video embeds:** YouTube embeds in tutorial steps need to work within VitePress markdown rendering. VitePress supports custom Vue components in markdown, so this is achievable.
