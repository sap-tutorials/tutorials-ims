# Pilot Status & Scope Lock

**Status as of 2026-05-24:** Pilot complete. Scope locked for production deployment.

**Target go-live:** end of June 2026 (clean test pass) or end of July 2026 (if testing surfaces a second pass).

The original pilot — UI5 Web Components evaluation on `ui-pilot/u0-u3-u5` (see [Appendix A](#appendix-a--original-ui-pilot-u0--u3--u5)) — succeeded and was extended into a full UI redesign (U0–U18, all merged), an IMS rewrite on CAP Node.js, AEM decommissioning, and a QA author-preview channel. What started as "swap the shellbar for `ui5-shellbar`" became a complete replacement platform for developers.sap.com tutorial hosting and progress tracking.

---

## Timeline

| Milestone | Date | Notes |
| --- | --- | --- |
| First commit (POC scaffold) | 2026-04-22 | VitePress + Fundamental Styles + MTA deploy |
| Hugo migration | late April | VitePress retired; see [hugo-migration.md](hugo-migration.md) |
| AEM decommissioned | early May | Frontend now serves directly behind AppRouter; tutorials served from HANA BLOBs |
| IMS-on-CAP rewrite shipped | mid May | Java IMS replaced by CAP Node.js ([../srv/](../srv/)); migration scripts in [../scripts/](../scripts/) |
| UI pilot (U0–U18) shipped | 2026-05-22 | All 18 UI features merged to main |
| Joule + embeddings + RAG | 2026-05-22 → 23 | Chat, step-help FAB, personalized recommendations |
| Admin Analytics Explorer | 2026-05-23 | PR #37 merged |
| QA channel | 2026-05-23 | PRs #36/#38/#40/#41/#42/#46 merged; awaiting deploy + role-collection assignment |
| Search word-boundary matching | 2026-05-24 | `main` HEAD (`d7c33e0`) |
| **Scope lock (this document)** | **2026-05-24** | No new features land before testing closes |
| Production go-live (target A) | end of June 2026 | If unit + hybrid + smoke tests pass and stakeholder UAT signs off |
| Production go-live (target B) | end of July 2026 | If a second pass is needed |

**Calendar duration:** 33 days.  **Active development days:** 22.  **Total commits:** 1,002.

---

## In scope for production

This is the locked scope. Anything not listed is post-launch.

### Backend — CAP Node.js ([../srv/](../srv/))

- 8 services: `DeveloperService`, `AdminService`, `AnalyticsService`, `DisplayService`, `ConsolidationService`, `ScannerService`, `SearchService`, `EventStreamService`
- Custom endpoints: `/api/qrcode`, `/build/catalog`, `/build/navigator`, `/build/slug-mapping`, `/build/repo-catalog`, `/content/publish`, `/content/tutorials/:slug`, `/content/hashes`, `/content/nav`, `/content/rollback`, `/feedback/submit`
- Tutorial HTML persistence: gzip-compressed BLOBs in HANA via `ContentFiles` + `ContentManifest` ([../srv/lib/content-store.js](../srv/lib/content-store.js))
- WebSocket: Socket.IO transport via `@cap-js-community/websocket`, namespaces `/ws/display` (XSUAA `DisplayApp`) and `/ws/event-stream` (anonymous) for real-time event dashboards
- Scheduled jobs: account-merge, analytics, cleanup, content GC, ngds-retry ([../srv/jobs/](../srv/jobs/))
- Audit logging (`@cap-js/audit-logging`) + change tracking (`@cap-js/change-tracking`)
- Embeddings + RAG (`TutorialEmbedding`, `getRelevantSteps` tool, `ChatSettings.ragEnabled`)
- Personalized recommendations (embedding centroid + co-completion blend)
- ORD registration ([../srv/ord-annotations.cds](../srv/ord-annotations.cds))

### Frontends

- **Hugo public site** ([../hugo/](../hugo/)) — SAP Horizon theme, Object Page tutorial layout, all 18 UI pilot features (Wizard, Cmd+K, Rating, Illustrated states, Codetabs, Glossary, Toast, Reader mode, Mermaid, Skeleton loaders, Lightbox, Side-nav, Profile timeline, Mobile sheet)
- **Admin shell** ([../app/admin-shell/](../app/admin-shell/)) — `sap.tnt.ToolPage` with 10 Fiori Elements feature components loaded as headless components
- **Analytics Explorer** ([../app/analytics-explorer/](../app/analytics-explorer/)) — Vue 3 SPA with Monaco SQL editor over `AnalyticsService`
- **Public Vue apps** ([../hugo-apps/](../hugo-apps/)) — `AppSpace.vue` event-themed component, QR code rendering
- **Display dashboard** ([../app/display-app/](../app/display-app/)) — Vue+Vite event monitor with rotating views
- **Scanner** ([../app/scanner/](../app/scanner/)) — UI5 barcode scanner using `sap.ndc.BarcodeScanner`

### Content pipeline

- GitHub discovery via `discoverAllTutorials()` ([../scripts/parsers/github.ts](../scripts/parsers/github.ts))
- 4-tier discovery resilience (live GitHub → cache → `RepoCatalog` baseline → degrade) — closed in PR #21
- Hugo build → SHA-256 delta publish to HANA via [../scripts/publish-content.ts](../scripts/publish-content.ts)
- QA channel: separate `tutorials-srv-qa` + `tutorials-hana-qa` + `/tutorials-qa/*` route, gated by XSUAA scope `Tutorial.Author`

### Deployment

- Single MTA deployment via [../.deploy/mta.yaml](../.deploy/mta.yaml) → SAP BTP Cloud Foundry (eu10-005, DevRel and Community Tools subaccount); see [mta-deployment.md](mta-deployment.md)
- AppRouter + XSUAA + 2 HDI containers (prod + QA)
- 3-tier testing: unit (in-memory SQLite), hybrid (real HANA via `cds bind --exec`), smoke (HTTP against deployed)
- CI: [../.github/workflows/deploy.yml](../.github/workflows/deploy.yml), [../.github/workflows/rebuild-content.yml](../.github/workflows/rebuild-content.yml)

---

## Out of scope (post-launch backlog)

- AEM redirect tree migration — blocked on admin team export of `/etc/redirect` rules
- Author self-service tooling beyond GitHub workflow_dispatch
- i18n beyond `en_us` (developers.sap.com is English-only)
- Notifications bell wiring (currently visual-only on shellbar)

---

## Time invested vs. hand-developed equivalent

### Actual time spent (Tom, AI-assisted)

| Metric | Value |
| --- | --- |
| Calendar duration | 33 days (2026-04-22 → 2026-05-24) |
| Active development days | 22 days with commits |
| Estimated working hours | ~175–220 hours (8–10 hr days × 22 active days) |

### Codebase size (measured via `scc`)

| Metric | Value |
| --- | --- |
| Files | 690 |
| Total lines | 137,880 |
| **Code lines** | **115,251** |
| Comments | 2,206 |
| Top languages | JavaScript (20.6 KLOC), TypeScript (9.3 KLOC), Vue (7.4 KLOC), CSS (7.5 KLOC), HTML (3.3 KLOC) |
| Documentation | Markdown (49.6 KLOC), JSON config (15.5 KLOC) |
| Cyclomatic complexity | 4,139 |

### Hand-developed estimate (single senior full-stack developer, no AI)

Three independent estimation methods, all pointing to the same order of magnitude:

| Method | Estimate | Basis |
| --- | --- | --- |
| **scc COCOMO Organic (raw effort)** | **~351 person-months ≈ 29 person-years** | `2.4 × (KLOC)^1.05`; schedule normally 23 months across 15 devs, but solo eliminates parallelism |
| **Industry LOC-per-day (50 LOC/day, conservative)** | **~10.5 person-years ≈ 21,000 hours** | Senior full-stack rate including tests, debugging, design, deployment |
| **Industry LOC-per-day (30 LOC/day, production-grade)** | **~17.5 person-years ≈ 35,000 hours** | Adjusted for the 8-service, multi-frontend, deployment-automation, AI-integration scope |

**Midpoint hand-developed estimate: ~15 person-years (~30,000 working hours).**

### Leverage ratio

```text
~30,000 hours hand-developed  ÷  ~200 hours actual  ≈  150× leverage
```

Conservative bound (~10.5 person-years hand-built): **~100×**.
Upper bound (~29 person-years COCOMO raw effort): **~290×**.

### Why the ratio is this high (and what it doesn't mean)

The leverage compounds from three project-specific factors:

1. **AI-assisted parallel worktrees.** UI pilots U0–U18 ran as parallel branches with subagents executing independent feature work simultaneously. A single hand-coding developer cannot run 4 frontends in parallel.
2. **Code generation density.** Fiori Elements admin apps (10 of them) and CDS annotations are highly templated; hand-writing them adds linear cost that AI handles in seconds.
3. **No legacy carry-over.** AEM was decommissioned cleanly rather than refactored; IMS was rewritten rather than ported. A solo dev would more likely have kept legacy systems running and refactored incrementally — lower wall-clock leverage but lower risk.

What the ratio **does not** mean: that 200 hours of any developer's time can produce this output. It reflects a specific combination of domain knowledge (CAP, BTP, IMS internals, AEM context), tooling investment (worktrees, MCP servers, sap-devs CLI, hooks), and a well-bounded scope defined by an existing replacement target. A greenfield project without a reference system would not see the same multiplier.

---

## Pre-deploy checklist (testing window)

- [ ] Hybrid test suite green (`npm run test:hybrid`) on DEV HANA
- [ ] Smoke test suite green against deployed DEV (`npm run test:smoke`)
- [ ] QA channel deployed and `Tutorial.Author` role collection assigned to first authors
- [ ] Author UAT on QA channel (≥1 author publishes ≥1 tutorial end-to-end)
- [ ] Performance budget verified: ~160 KB gzipped UI5 bundle still acceptable
- [ ] Production HANA Cloud HDI sized for content BLOBs + embeddings + audit log retention
- [ ] AEM redirect rules exported and translated to AppRouter routes
- [ ] Migration dry-run on prod IMS data (resumable export → import → diff via [../scripts/compare-systems.js](../scripts/compare-systems.js))
- [ ] Cutover runbook reviewed with stakeholders
- [ ] Rollback plan documented (per-manifest content rollback exists; full revert plan TBD)

---

## Appendix A — Original UI Pilot (U0 + U3 + U5)

Preserved for traceability. The original pilot validated UI5 Web Components as the foundation; that decision is now baked into the production scope.

**Original branch:** `ui-pilot/u0-u3-u5` (long-since merged).

**Pilot scope:** adopt UI5 Web Components foundation, replace the header with `ui5-shellbar`, add declarative `ui5-message-strip` banners on tutorial pages.

**Dependencies added:** `@ui5/webcomponents`, `@ui5/webcomponents-fiori`, `@ui5/webcomponents-icons` (all `^2.22`).

**Key files touched:**

| File | Change |
| --- | --- |
| [../hugo/assets/js/ui5-bootstrap.ts](../hugo/assets/js/ui5-bootstrap.ts) | New entrypoint. Selectively imports ShellBar / MessageStrip / Avatar / Popover / Button / Input / List + 12 icons. Sets `sap_horizon` / `sap_horizon_dark` based on `<html data-theme>` and observes mutations to keep them in sync. |
| [../hugo/layouts/_default/baseof.html](../hugo/layouts/_default/baseof.html) | Adds `<script type="module" src="ui5-bootstrap.js">` (built via Hugo `js.Build`). |
| [../hugo/layouts/partials/header.html](../hugo/layouts/partials/header.html) | Hand-rolled `fd-shellbar` markup replaced by `ui5-shellbar` + four `ui5-popover` panels (Navigate, Share, Trust, User). All previous behavior preserved. |
| [../hugo/assets/css/ui5-overrides.css](../hugo/assets/css/ui5-overrides.css) | New stylesheet (~0.8 KB gzipped). |
| [../hugo/layouts/partials/tutorial-banners.html](../hugo/layouts/partials/tutorial-banners.html) | New partial. Renders `ui5-message-strip` for `deprecated`, `updated` (within 30 days), `notice`, `warning` frontmatter fields. |

**Performance budget at pilot close:**

| Asset | Raw | Gzipped |
| --- | ---: | ---: |
| `public/js/ui5-bootstrap.js` (new) | 730 KB | **159 KB** |
| `public/css/ui5-overrides.css` (new) | 1.7 KB | **0.8 KB** |
| `public/css/sap-fundamental.css` (existing) | 768 KB | 86 KB |

**Net add per page-load: ~160 KB gzipped** (one-time, cached). Has not regressed through U0–U18.

**Open questions raised at pilot close — all resolved during U0–U18:**

| Question | Resolution |
| --- | --- |
| Notifications bell — wire it or hide it? | Visible, unwired (out-of-scope, post-launch). |
| Joule trigger selector update? | Resolved during Joule step-help FAB shipping (PR #33, 2026-05-22). |
| Global search via shellbar slot? | Wired to `SearchService` with word-boundary matching (commit `d7c33e0`, 2026-05-24). |
| Mobile breakpoint match? | Validated during U18 mobile step sheet shipping (PR #31, 2026-05-22). |

---

## Appendix B — References

- Per-feature delivery details and validation notes: project memory entries U0 through U18, plus shipped-feature project memories
- Architecture deep-dives: this folder ([docs/](.))
- Improvement backlog source: `improvements.md` (excluded from public site)
- Project conventions and gotchas: [CLAUDE.md](https://github.com/sap-tutorials/tutorials-poc/blob/main/CLAUDE.md)
