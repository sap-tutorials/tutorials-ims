# SAP Developer Destination Inventory — `developers.sap.com/` Homepage Redesign

**Date:** 2026-06-27
**Issue:** [#639](https://github.com/sap-tutorials/tutorials-ims/issues/639)
**Phase:** Brainstorming — discovery research, not a recommendation

Inventory of ~50 distinct developer-facing SAP destinations the new homepage might link to. Discovered via sap-devs MCP (`search_resources`, `get_context` across packs `base`/`cap`/`btp-core`/`abap`) plus direct URL probing of `*.docs.sap`, `*.cloud.sap`, `sap.github.io/*`, `help.sap.com/docs/*`, `community.sap.com/*` patterns.

WebSearch was unavailable in the discovery agent's tool surface — gap-filling relied entirely on URL probing plus links surfaced from probed pages. Gaps noted in §3.

---

## 1. Discovery summary

Found **~50 distinct developer-facing SAP destinations** across **at least 9 hostname families**:

`developers.sap.com`, `community.sap.com`, `learning.sap.com`, `help.sap.com`, `api.sap.com`, `cap.cloud.sap`, `discovery-center.cloud.sap`, `skills.cloud.sap`, `sap.github.io/*`

…plus a long tail of microsites: `btp-ai-bp.docs.sap`, `ai4u-website.cfapps...`, `open-resource-discovery.org`, `kyma-project.io`, `project-piper.io`.

**Three observations:**

1. **The `*.docs.sap` apex is sparsely populated.** Of 20 plausible subdomains probed (`api.docs.sap`, `cap.docs.sap`, `hana.docs.sap`, etc.), only `btp-ai-bp.docs.sap` resolves. The pattern is not a general SAP convention — most product docs live on `help.sap.com/docs/*` instead. Worth confirming with whoever runs DNS whether more are planned.
2. **Several historic destinations have collapsed or redirected** since 2024: `openSAP` retired into Learning, `blogs.sap.com` and `groups.community.sap.com` collapsed into Community, `experience.sap.com` collapsed into `www.sap.com/design-system/`, `appgyver.com` redirected into Build Apps, `sapui5.hana.ondemand.com` redirected to `ui5.sap.com`, and `youtube.com/c/SAPDevelopers` was superseded by `@sapdevs`. The new homepage should NOT link to the legacy URLs.
3. **The "find everything" problem is real and visible in the data.** Even an SAP-internal developer would not be able to enumerate the 50+ destinations from memory.

## 2. Catalog by audience bucket

### 2.1 `learner` — tutorials, learning journeys, certifications

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://developers.sap.com | SAP Developers | Tutorials, missions, blog posts, events — the AEM portal this project is replacing | tutorials, learning-journeys, mission-control | active | Akamai bot-blocks WebFetch |
| https://learning.sap.com | SAP Learning | Free + paid learning journeys, self-paced + certification prep | learning-journeys | active | |
| https://learning.sap.com/learning-journeys | SAP Learning Journeys | Curated multi-course paths toward certifications | learning-journeys | active | |
| https://open.sap.com | openSAP (retired) | Legacy MOOC platform; content migrated to SAP Learning | learning-journeys | legacy-looking | Redirect to a migration page that itself 404s — do NOT link |
| https://www.sap.com/training-certification.html | SAP Training & Certification | Corporate certification + paid instructor-led training | learning-journeys | active | |
| https://www.sap-press.com/ | SAP PRESS | Third-party e-books, certification guides, programming books | docs | active | Publisher Rheinwerk — third-party, partner |

### 2.2 `builder` — SDKs, IDEs, frameworks, low-code

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://cap.cloud.sap | SAP CAP Docs | Official documentation for CAP (Node.js + Java) | docs, code-samples | active | Canonical for CAP developers |
| https://ui5.sap.com | SAPUI5 SDK – Demo Kit | Canonical UI5 framework docs, API reference, samples, demos | docs, playground, code-samples | active | `sapui5.hana.ondemand.com` redirects here |
| https://openui5.org | OpenUI5 | Marketing/landing for the Apache-2.0 open-source sibling of SAPUI5 | docs | active | |
| https://sap.github.io/ui5-webcomponents/nightly/ | UI5 Web Components | Framework-agnostic enterprise web components | docs, playground | active | Root `/ui5-webcomponents/` 404s — only versioned paths work |
| https://sap.github.io/ui5-webcomponents-react/ | UI5 Web Components for React | React wrappers for UI5 web components | docs, code-samples | active | |
| https://sap.github.io/cloud-sdk/ | SAP Cloud SDK | Java + JavaScript SDKs for consuming SAP APIs | docs, code-samples | active | |
| https://tools.hana.ondemand.com | SAP Development Tools | Download portal for Eclipse plugins, CLIs, HANA client, SDKs | tools | active | |
| https://www.sap.com/products/technology-platform/business-application-studio.html | SAP Business Application Studio | Cloud IDE for CAP, Fiori, mobile, full-stack BTP development | tools | active | Marketing page; docs at help.sap.com/docs/SAP_BUSINESS_APPLICATION_STUDIO |
| https://www.sap.com/products/technology-platform/build.html | SAP Build | Low-code app/automation/website suite on BTP | tools | active | |
| https://www.sap.com/products/technology-platform/build-code.html | SAP Build Code | AI-assisted pro-code development tooling on BTP | tools | active | |
| https://www.sap.com/products/technology-platform/low-code-app-builder.html | SAP Build Apps (ex-AppGyver) | Visual low-code app builder | tools | active | `appgyver.com` redirects here |
| https://help.sap.com/docs/build | SAP Build (docs) | Official Build product documentation | docs | active | |
| https://help.sap.com/docs/build-code | SAP Build Code (docs) | Official Build Code product documentation | docs | active | |
| https://help.sap.com/docs/SAP_BUSINESS_APPLICATION_STUDIO | Business Application Studio (docs) | Official BAS documentation | docs | active | |
| https://www.sap.com/design-system/ | SAP Design System | Consolidated successor to `experience.sap.com` — Fiori web/mobile + Build design guidelines | docs | active | All `experience.sap.com/*` URLs redirect here |
| https://sap.github.io/styleguides/ | SAP Style Guides | Engineering style guides (JavaScript, TypeScript, UI5, ABAP) | docs | unknown | 404 at probe time — needs verification |

### 2.3 `integrator` — APIs, integration, eventing, connectivity

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://api.sap.com | SAP Business Accelerator Hub | Browse + test SAP APIs across S/4, SuccessFactors, Ariba, etc. | api-catalog, code-samples | active | |
| https://hub.sap.com | SAP Business Accelerator Hub (alt host) | Same content catalog as api.sap.com | api-catalog | active | Header-only render — likely same product as api.sap.com |
| https://help.sap.com/docs/integration-suite | SAP Integration Suite | Docs for Cloud Integration, API Management, Event Mesh | docs | active | |
| https://help.sap.com/docs/event-mesh | SAP Event Mesh | Managed message broker on BTP | docs | active | |
| https://help.sap.com/docs/destination-service | SAP Destination Service | BTP service that brokers credentials to external endpoints | docs | active | |
| https://help.sap.com/docs/private-link | SAP Private Link | Private connectivity between BTP and hyperscaler VPCs | docs | active | |
| https://open-resource-discovery.org | Open Resource Discovery (ORD) | Open protocol for publishing/discovering application + service metadata | docs, discovery | active | |
| https://sap.github.io/odata-vocabularies/ | SAP OData Vocabularies | OData annotation term definitions across business domains | docs | active | |
| https://www.project-piper.io/ | Project "Piper" | Pre-built CI/CD pipelines + shared library for SAP applications | docs, tools | active | `sap.github.io/jenkins-library` redirects here |

### 2.4 `architect` / `operator` — BTP platform, deployment, ops

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://help.sap.com/docs/btp | SAP BTP Documentation | Canonical reference docs for SAP Business Technology Platform | docs | active | |
| https://help.sap.com/docs/btp/sap-business-technology-platform/getting-started | BTP Getting Started | Onboarding entry point for BTP | docs, tutorials | active | |
| https://help.sap.com/docs/btp-cli | BTP CLI | CLI reference for `btp` command | docs, tools | active | |
| https://discovery-center.cloud.sap | SAP BTP Discovery Center | BTP service catalog, guided missions, pricing | discovery, mission-control | active | SPA — content client-rendered |
| https://cockpit.btp.cloud.sap | SAP BTP Cockpit | Browser console for managing BTP accounts | tools | active | Redirects to regional shard; auth-required |
| https://kyma-project.io | Kyma | Open-source Kubernetes platform for cloud-native extensions on BTP | docs, tools | active | |
| https://help.sap.com/docs/SAP_HANA_CLOUD | SAP HANA Cloud (docs) | Canonical docs for HANA Cloud in-memory database | docs | active | |
| https://help.sap.com/docs/identity-authentication | SAP IAS | Identity Authentication Service — OIDC IdP for BTP apps | docs | active | |
| https://help.sap.com/docs/SAP_CONTINUOUS_INTEGRATION_AND_DELIVERY | SAP CI/CD service | Managed CI/CD service on BTP | docs | active | |
| https://help.sap.com/docs/datasphere | SAP Datasphere | Business data fabric / data warehousing | docs | active | data-engineer overlap |
| https://help.sap.com/docs/SAP_ANALYTICS_CLOUD | SAP Analytics Cloud | SaaS BI/planning/predictive analytics | docs | active | data-engineer overlap |

### 2.5 `ai-developer`

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://btp-ai-bp.docs.sap/ | SAP BTP AI Best Practices | Curated guides and patterns for AI on BTP | docs | active | User-named target — the kind of microsite the homepage must surface |
| https://ai4u-website.cfapps.eu10-004.hana.ondemand.com | AI4U Use Case Repository | 50+ real-world AI projects built on SAP BTP | code-samples, discovery | active | `cfapps.*` URL unstable — ask for canonical alias |
| https://skills.cloud.sap/ | AI Skills Library | Searchable catalog of 24 certified "skills" | docs, discovery | active | User-named target |
| https://help.sap.com/docs/sap-ai-core | SAP AI Core (docs) | Runtime for training/serving ML and GenAI on BTP | docs | active | |
| https://help.sap.com/docs/sap-ai-launchpad | SAP AI Launchpad (docs) | Web UI to manage AI scenarios, models, deployments | docs | active | |
| https://help.sap.com/docs/joule | SAP Joule (docs) | Generative-AI copilot embedded across SAP products | docs | active | |

### 2.6 `abap-developer`

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://help.sap.com/docs/abap-cloud | ABAP Cloud (docs) | Canonical docs for ABAP Cloud, clean-core, RAP, BTP ABAP environment | docs | active | |
| https://help.sap.com/docs/abap-cloud/abap-rap/abap-restful-application-programming-model | ABAP RAP | Recommended framework for Fiori + OData services in ABAP Cloud | docs | active | |
| https://community.sap.com/t5/abap-blog/bg-p/abap-blogs | ABAP Community Blogs | ABAP-focused community blog stream | community-qa, news | active | |

### 2.7 `community` — Q&A, blogs, news, video, events

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://community.sap.com | SAP Community | Networking, Q&A, blogs, groups for all SAP roles | community-qa, news | active | |
| https://community.sap.com/t5/all-sap-community-blogs/ct-p/all-blogs | All SAP Community Blogs | Aggregated blog stream | news | active | `blogs.sap.com` redirects here |
| https://news.sap.com | SAP News Center | Official corporate news, customer stories, product announcements | news | active | |
| https://youtube.com/@sapdevs | SAP Developers (YouTube) | Tutorials, Tech Bytes, Developer News (weekly), live streams | videos | active | `/c/SAPDevelopers` legacy URL 404s |
| https://www.sap.com/about/events/sap-teched.html | SAP TechEd | Annual developer conference | events | active | |
| https://www.sap.com/about/events/sapphire.html | SAP Sapphire | Flagship customer/partner conference | events | active | |
| https://www.sap.com/about/events.html | SAP Events Hub | All SAP events landing page | events | active | |
| https://sapinsider.org | SAPinsider | Independent SAP professional community + events | community-qa, events | unknown | Probe returned 522; site widely known to exist |
| https://www.asug.com | ASUG | North America's largest SAP user community (independent) | community-qa, events | active | Third-party — partner |
| https://github.com/SAP | SAP on GitHub | SAP's open-source projects org | code-samples, tools | active | |
| https://github.com/SAP-samples | SAP-samples on GitHub | Sample code, tutorials, workshops | code-samples, tutorials | active | |
| https://github.com/SAP-docs | SAP Documentation on GitHub | Markdown sources for BTP/UI5/ABAP/Integration Suite docs; accepts CC-BY-4.0 contributions | docs | active | Hidden gem — public can contribute |

### 2.8 Cross-bucket

| URL | Name | Purpose | Content type | Currency | Note |
| --- | --- | --- | --- | --- | --- |
| https://help.sap.com | SAP Help Portal | Centralized product documentation for all SAP products | docs | active | |
| https://www.sap.com/products/technology-platform/hana.html | SAP HANA Cloud (marketing) | Product page for in-memory database with vector engine | docs | active | Canonical dev docs at `help.sap.com/docs/SAP_HANA_CLOUD` |
| https://help.sap.com/docs/signavio | SAP Signavio (docs) | Process intelligence platform documentation | docs | active | architect overlap |

## 3. Uncertain / needs human verification

- **`developers.sap.com/*` topic, tutorial-navigator, mission-catalog, events, groups pages** — all 403 to bot fetch. These are the pages being replaced; the redesigner has ground truth.
- **`www.sap.com/products/*` marketing pages** for Build, Build Code, AI Foundation, AI Launchpad, Joule, BAS, HANA, RISE — all 403 to bot fetch. They exist for real browsers.
- **`sap.github.io/ui5-webcomponents/`** and **`sap.github.io/ui5-webcomponents-react/`** — both 404 at their root; live docs live at versioned subpaths (e.g. `/nightly/`, `/v2/`). Canonical URL needs maintainer confirmation.
- **`sap.github.io/styleguides/`** — 404 at probe time. Was once active; may have moved.
- **`hub.sap.com` vs `api.sap.com`** — both surface the Business Accelerator Hub. Aliases or distinct? Needs SAP-side confirmation.
- **`sapinsider.org`** — returned HTTP 522 (Cloudflare); content not verifiable today.
- **`open.sap.com`** — redirects to a migration page that 404s. Treat as fully retired and do NOT link.
- **`*.docs.sap` siblings of `btp-ai-bp.docs.sap`** — DNS for 19 of 20 sibling subdomains failed. Worth asking the BTP AI BP owners whether more `*.docs.sap` microsites are planned.
- **`ai4u-website.cfapps.eu10-004.hana.ondemand.com`** — unstable CF route format. Ask for a canonical alias before publishing.
- **`me.sap.com`, `launchpad.support.sap.com`** — login-walled customer/admin surfaces; flagged so they don't accidentally re-enter scope.
- **`devtoberfest.community.sap.com`** — DNS gone. Devtoberfest now lives as a path under `community.sap.com`.

## 4. Excluded

- `wdf.sap.corp` / `*.sap.corp` — internal-only.
- `me.sap.com`, `launchpad.support.sap.com` — login-walled customer/admin surfaces.
- Social: LinkedIn, Twitter/X, Mastodon, Discord (`discord.gg/sapcommunity` requires Discord auth).
- Pure corporate/store/HR/press: `store.sap.com` (redirects to `www.sap.com/store.html`, not developer-facing).
