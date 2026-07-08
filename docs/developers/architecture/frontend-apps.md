---
title: Frontend Apps
description: Standalone app/ trees and hugo-apps/ islands — how the public site, admin shell, analytics, display dashboard, and scanner are structured.
---

# Frontend Apps

> Source: extracted from project README, 2026-05-25.

The frontend lives in two trees with very different deploy mechanics.

- **`app/<name>/`** — five standalone applications, each with its own `package.json` and build, copied as a finished `dist/` (or `webapp/`) into `approuter/static/<route>/` at MTA-build time. Each is reachable at its own AppRouter path, with its own auth scope, and runs as a separate browser app.
- **`hugo-apps/src/<name>/`** — nine Vue 3 page-level islands compiled by a single Vite project into `hugo/static/js/*.js` and loaded by Hugo templates as `<script>` tags inside the static site. They share the Hugo page DOM rather than running as separate apps.

### Static site (Hugo)

`hugo/` produces the public tutorial site with SAP Fundamental Styles + UI5 Web Components (Horizon theme, light/dark via `data-theme`). Layouts in `hugo/layouts/`; tutorial pages use the Fiori Object Page layout via Hugo cascade. Tutorial HTML is **not** served from disk — see [Build Pipeline](./build.md#build-pipeline). The `hugo.qa.toml` sibling config drives the QA-channel build with author-preview UI stripped.

### app/ — standalone applications

| Path on AppRouter | Source | Stack | Auth |
| --- | --- | --- | --- |
| `/admin-ui/` | [app/admin-shell/](../../../app/admin-shell/) + [app/admin/](../../../app/admin/) | UI5 / `sap.tnt.ToolPage` shell + 13 Fiori Elements headless components | XSUAA + `Admin` |
| `/analytics-ui/` | [app/analytics-explorer/](../../../app/analytics-explorer/) | Vue 3 + Vite + Monaco | XSUAA + `Admin` |
| `/display-app/` | [app/display-app/](../../../app/display-app/) | Vue 3 + Vite, Socket.IO `/ws/display` | XSUAA |
| `/scanner-ui/` | [app/scanner/webapp/](../../../app/scanner/webapp/) | UI5 (`sap.ndc.BarcodeScanner`) | XSUAA + `MobileApp` |

#### Admin shell + Fiori Elements components

- **`admin-shell/`** — `sap.tnt.ToolPage` with collapsible side navigation, theme switcher (light/dark/auto), Router-managed content area, and three custom views (Board, Statistics, TutorialDashboard) plus a Privacy view.
- **`admin/`** — 13 Fiori Elements apps loaded as headless components via `componentUsages`: `accomplishments`, `accounts`, `analytics`, `changelog`, `events`, `feedback`, `groups`, `joule`, `missions`, `operations`, `prizes`, `tags`, `tutorials`.
- **Shell manifest is generated (#1087)** — the shell's `resourceRoots` / `componentUsages` / `routes` / `targets` blocks are emitted from a folder scan of `app/admin/` at build time by [app/admin-shell/scripts/generate-manifest.js](../../../app/admin-shell/scripts/generate-manifest.js). The hand-authored file is `app/admin-shell/webapp/manifest.template.json`; the generator merges the four discovered blocks in and writes `webapp/manifest.json`. Adding a new admin app under `app/admin/<name>/` no longer needs a matching shell-manifest edit — `npm start` and `npm run build` in `app/admin-shell/` run the generator first via `prestart` / `prebuild`. Per-app overrides (non-default componentUsage key, extra routes, hand-picked hash-prefix) live in [app/admin-shell/scripts/admin-shell-overrides.js](../../../app/admin-shell/scripts/admin-shell-overrides.js). Route-prefix collisions fail the build.
- All annotations live in [app/admin-annotations.cds](../../../app/admin-annotations.cds); change-tracking annotations in [app/change-tracking.cds](../../../app/change-tracking.cds).
- Theme persisted to `localStorage` key `sap-tutorials-admin-theme`, defaulting to OS preference.
- **UI personalization** (column order/width, filter-bar layout, saved views from Fiori Elements `variantManagement`) is persisted to `localStorage` via SAP UI5's `LocalStorageConnector`, configured on the bootstrap `<script>` in [app/admin-shell/webapp/index.html](../../../app/admin-shell/webapp/index.html) (`data-sap-ui-flexibilityServices='[{"connector":"LocalStorageConnector"}]'`). The admin-shell has no Work Zone / HTML5 App Repo Runtime behind it and no `/sap/bc/lrep/*` route on the AppRouter, so without the connector UI5 fires unanswered `GET /sap/bc/lrep/flex/data/<id>` requests at component init and personalizations evaporate on reload (#717, #770). Consequences: personalizations are **per browser / per device** (no cross-device sync); there is no PUBLIC layer (no admin-curated shared views). If shared key-user views are ever required, the upgrade is `KeyUserConnector` + `PersonalizationConnector` against a CAP-served flex backend (≈ a `FlexChanges` HANA entity plus `/flex/data/:reference` envelope handlers).

#### Analytics Explorer

Vue 3 SPA over `AnalyticsService` (`/admin/analytics`). Two tabs:

- **Entity browser** — driven by the `@analytics.exposed` allowlist in [db/schema-ext.cds](../../../db/schema-ext.cds); supports `$apply` (groupby + aggregate), filter, top, skip, orderby.
- **SQL** — Monaco editor (lazy-loaded) backed by the `runSelectQuery(sql)` action. Server-side validator (`srv/lib/analytics-sql-validator.cjs`): SELECT-only, allowlisted tables, no DDL/DML/multi-statement; every query is wrapped with `LIMIT 5001` to cap result size.

#### Display App

Standalone event-monitor dashboard for big screens. Five rotating views (Board, Statistics, Leaderboard, Burnup, Track Stats) auto-refresh; live updates arrive via Socket.IO on `/ws/display`. The `DisplayApp` scope is checked at namespace join, not at the AppRouter (which lets `^/socket\.io/` and `^/ws/` through unauthenticated).

#### Scanner

UI5 barcode scanner using `sap.ndc.BarcodeScanner` for device-camera scanning. Looks up a contestant by the account number encoded in their badge QR code via `getContestant(accountNumber)` (OData function on `ScannerService`), shows progress + prize info, and claims via `claimPrize(recordId)`. There's a Vue 3 sibling at `/scanner-vue/` — see below.

### hugo-apps/ — page-level Vue 3 islands

Compiled by `build:apps` (a single Vite project) into `hugo/static/js/<name>.js`. Each island mounts onto a Hugo-rendered DOM node when its host page loads.

| Island | Loaded on | Purpose |
| --- | --- | --- |
| `navigator` | `/` (homepage) | Tutorial navigator with filters and search |
| `app-space` | `/app-space` | Event-themed Vue SPA (Joule/Sapphire theme overlays); progress via `/api/getEventProgress`, QR via `/api/qrcode`, live updates via Socket.IO |
| `event-display` | `/event-display` | Launcher for the standalone display dashboard |
| `nav-dropdown` | All pages (header) | Mission/group dropdown in the shellbar |
| `scanner-vue` | `/scanner-vue/` | Vue 3 mobile-optimized scanner using native `BarcodeDetector`, falls back to manual JSON input |
| `tutorial-feedback` | Tutorial Object Pages | NPS rating + comment form, posts to `/feedback/submit` |
| `tutorial-rating` | Tutorial Object Pages | `ui5-rating-indicator` shipped with U6 |
| `cmd-palette` | All pages | ⌘K command palette (U4) |
| `me` | `/me/` | Profile + Recent Activity timeline (`ui5-timeline`, U17), reads `getMyCompletions` |

`hugo-apps/src/composables/` and `hugo-apps/src/shared/` hold cross-island utilities and are **not** themselves islands.

### UI features (U0–U18) on the static site

Beyond the islands above, the U0–U18 pilot shipped in-place enhancements rendered via Hugo partials + scoped JS modules in `hugo/assets/js/`:

- **Object Page layout** (U1), **Wizard step indicator** (U2), **Illustrated states** (U7), **Codetabs** (U8), **Glossary** (U9), **Toast + final-step CTA** (U10), **Reading-progress bar + scrollspy** (U11), **Reader mode** (U12), **Mermaid diagrams** (U13), **Skeleton loaders** (U14), **Lightbox** (U15), **Mission side-nav** (U16), **Mobile step sheet** (U18).

These are loaded via `hugo/assets/js/ui5-bootstrap.ts` (and tutorial-only modules via `hugo/assets/js/tutorial.ts`). Cross-page features that gate themselves on DOM presence belong in `ui5-bootstrap.ts` imports — `tutorial.ts` only loads on tutorial layouts.
