# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A tutorial hosting platform that replaces Adobe Experience Manager (AEM) as the frontend for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub organization at build time, parses it into static pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA authentication. Backed by a CAP Node.js service with SAP HANA Cloud for progress tracking (IMS rewrite).

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

# CAP backend
cds watch                                     # Start CAP server (http://localhost:4004)

# Migration & Comparison
npm run migrate:reference                     # Export reference data from Java IMS (or import to CAP)
npm run migrate:users                         # Export user progress from Java IMS (with resume support)
npm run compare                               # Compare Java IMS and CAP responses side-by-side
node scripts/migrate-reference-data.js populate-slugs  # Patch slug fields from AEM cache
```

Tutorials must be fetched before `dev` or `build`. Fetched markdown is cached in `.tutorial-cache/` and generated pages go to `site/tutorials/` — both are gitignored. To force re-fetch from GitHub, delete `.tutorial-cache/`.

## Architecture

### Build Pipeline

```
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts (fetch + cache raw markdown)
    → scripts/parsers/ (parse frontmatter, steps, images, options)
      → site/tutorials/*.md (generated pages with YAML frontmatter)
        → site/tutorials/_nav.json (navigation index)

CAP backend (http://localhost:4004 or CAP_BASE_URL)
  → GET /build/catalog (unauthenticated)
    → missions + completion paths + tutorial ordering
      → mission-*.md and group-*.md pages
```

### CAP Backend (srv/)

- **Services**: `DeveloperService` (@path: /api), `AdminService` (@path: /admin), `DisplayService` (@path: /display), `ConsolidationService` (@path: /api/v1)
- **Custom endpoints**: `/api/qrcode` (QR code PNG generation), `/build/catalog` (unauthenticated mission/group data for build pipeline)
- **WebSocket**: STOMP broker at `/display/websocket` for real-time event dashboard updates
- **Jobs**: Scheduled tasks in `srv/jobs/` (tutorial sync, NGDS export)
- **Bootstrap**: `srv/server.js` registers custom express routes on `cds.on('bootstrap')`, attaches STOMP broker and jobs on `cds.on('served')`

### Frontend (apps/)

- **AppSpace** (`apps/src/app-space/AppSpace.vue`): Event-themed tutorial space (Joule/Sapphire themes). Fetches progress from `/api/getEventProgress`, displays QR codes via `/api/qrcode`

### Deployment (BTP Cloud Foundry)

Single MTA deployment (`mta.yaml`): AppRouter module serves static build from `approuter/static/`. XSUAA provides SAP IDP authentication. Routes in `approuter/xs-app.json` proxy to CAP backend via BTP Destination.

### Data Migration

Migration scripts in `scripts/` support parallel operation during cutover:
- `migrate-reference-data.js` — export/import tutorials, missions, events, tags; `populate-slugs` mode patches slug fields from AEM cache
- `migrate-user-progress.js` — export/import users and task records (paged, resumable)
- `compare-systems.js` — endpoint-by-endpoint diff between Java IMS and CAP

Set `IMS_BASE_URL`, `CAP_BASE_URL`, and `IMS_AUTH_TOKEN` env vars. Export files go to `.migration-data/` (gitignored).

### Parsers (scripts/parsers/)

The fetch script detects parser format via frontmatter field `parser: v2`. V2 uses H3 headings to delimit steps; V1 (legacy) uses `[ACCORDION-BEGIN]`/`[ACCORDION-END]` markers. `images.ts` resolves relative image paths to `raw.githubusercontent.com` CDN URLs. `options.ts` converts `[OPTION BEGIN]`/`[OPTION END]` blocks to `<OptionTabs>` Vue components. `cap.ts` fetches mission/group catalog from the CAP backend at build time. Shared types in `types.ts`.

## Gotchas

- **`site/tutorials/` is entirely generated** — never edit these files directly. They are overwritten by `npm run fetch-tutorials`. Edit the parsers in `scripts/parsers/` or the source tutorials in the `sap-tutorials` GitHub org instead.
- **POC tutorial list is hardcoded** — The 5 tutorials are defined in the `POC_TUTORIALS` array at the top of `scripts/fetch-tutorials.ts`. Adding tutorials means editing that array.
- **Validation quiz data is hardcoded** — The `VALIDATION_DATA` object in `scripts/fetch-tutorials.ts` contains step quiz questions, not the CAP backend. This is a POC shortcut.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses this to avoid GitHub API rate limits when fetching commit metadata. Without it, unauthenticated requests may hit rate limits on repeated builds.
- **`CAP_BASE_URL` env var** — Used by `scripts/parsers/cap.ts` and migration scripts. Defaults to `http://localhost:4004`. Set to the deployed CAP srv URL for production builds.
- **Cache clearing** — `.tutorial-cache/` caches raw markdown, GitHub metadata, and CAP catalog data. Delete it to force a full re-fetch. There is no incremental invalidation.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).
- **Slug fields** — `Missions.slug` and `CompletionPaths.slug` must be populated for the build pipeline to generate mission/group pages. Run `node scripts/migrate-reference-data.js populate-slugs` after data import.
