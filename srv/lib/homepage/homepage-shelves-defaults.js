// srv/lib/homepage/homepage-shelves-defaults.js
//
// CANONICAL baseline for the HomepageShelves table (verb-page shelf entries +
// footer links). Single source of truth, seeded idempotently at boot by
// srv/lib/homepage/seed-homepage-shelves.js (called from cds.on('served')).
//
// Replaces the former test/data seed CSV + the manual db/data/staging
// third-party JSON + `npm run seed:thirdparty`. HomepageShelves is
// admin-managed on HANA (no .hdbtabledata ships in --production), so these
// rows are inserted ONLY when their (verb,url) is missing — admin edits to
// existing rows are never overwritten, and a deploy can never full-replace
// the table (that was the pre-#1404c4c4 data-loss bug).
//
// To add/curate a baseline link: edit this array (or use /admin-ui/#homepage
// at runtime). Rows: 97 across 7 verbs — {"LEARN":9,"BUILD":14,"INTEGRATE":14,"OPERATE":9,"AI":16,"CONNECT":16,"MODEL":19}
//
// GENERATED once from the retired CSV + staging JSON; now hand-maintained.

export const HOMEPAGE_SHELVES_DEFAULTS = [
  {
    "ID": "66333900-0001-0001-0001-000000000001",
    "verb": "LEARN",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "Tutorial Navigator",
    "url": "/tutorial-navigator/",
    "isExternal": false,
    "isActive": true,
    "description": "Browse and filter 1 400+ hands-on tutorials across all SAP topics"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000002",
    "verb": "LEARN",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "SAP Learning Journeys",
    "url": "https://learning.sap.com/learning-journeys",
    "isExternal": true,
    "isActive": true,
    "description": "Curated multi-course paths toward certifications and role mastery"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000003",
    "verb": "LEARN",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "New to Cloud SAP?",
    "url": "/missions/",
    "isExternal": false,
    "isActive": true,
    "description": "Guided mission paths for developers moving from on-prem to cloud and AI"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000004",
    "verb": "LEARN",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "learning.sap.com",
    "url": "https://learning.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "Free and paid learning journeys, self-paced courses, and certification prep"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000005",
    "verb": "LEARN",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "SAP Help Portal",
    "url": "https://help.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "Centralized product documentation for all SAP products"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000006",
    "verb": "LEARN",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "Certifications",
    "url": "https://www.sap.com/training-certification.html",
    "isExternal": true,
    "isActive": true,
    "description": "Official SAP certification paths and instructor-led training"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000007",
    "verb": "LEARN",
    "shelf": "TOOLS",
    "sortOrder": 70,
    "title": "BTP Free Tier Signup",
    "url": "https://cockpit.btp.cloud.sap",
    "isExternal": true,
    "isActive": true,
    "description": "Start building on SAP BTP with a free tier account — no credit card required"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000008",
    "verb": "LEARN",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "SAP-samples on GitHub",
    "url": "https://github.com/SAP-samples",
    "isExternal": true,
    "isActive": true,
    "description": "Hundreds of sample apps, tutorials, and workshop repos from SAP"
  },
  {
    "ID": "66333900-0001-0001-0001-000000000009",
    "verb": "LEARN",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 90,
    "title": "SAP Developer News",
    "url": "https://youtube.com/@sapdevs",
    "isExternal": true,
    "isActive": true,
    "description": "Weekly Friday show covering the latest developer news, tutorials, and events"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000001",
    "verb": "BUILD",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "SAP CAP",
    "url": "https://cap.cloud.sap",
    "isExternal": true,
    "isActive": true,
    "description": "Official docs for the Cloud Application Programming Model — Node.js + Java"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000002",
    "verb": "BUILD",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "ABAP Cloud + RAP",
    "url": "https://help.sap.com/docs/abap-cloud",
    "isExternal": true,
    "isActive": true,
    "description": "Clean-core ABAP development with RAP, ADT, and the BTP ABAP environment"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000003",
    "verb": "BUILD",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "Fiori / UI5",
    "url": "https://ui5.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "SAP UI5 Demo Kit — API reference, samples, and interactive demos"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000004",
    "verb": "BUILD",
    "shelf": "START_HERE",
    "sortOrder": 40,
    "title": "SAP Build",
    "url": "https://www.sap.com/products/technology-platform/build.html",
    "isExternal": true,
    "isActive": true,
    "description": "Low-code app, automation, and website suite on BTP for faster delivery"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000005",
    "verb": "BUILD",
    "shelf": "START_HERE",
    "sortOrder": 50,
    "title": "SAP Build Code",
    "url": "https://www.sap.com/products/technology-platform/build-code.html",
    "isExternal": true,
    "isActive": true,
    "description": "AI-assisted pro-code development tooling on BTP with Joule co-pilot"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000006",
    "verb": "BUILD",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "SAP Cloud SDK",
    "url": "https://sap.github.io/cloud-sdk/",
    "isExternal": true,
    "isActive": true,
    "description": "Java + JavaScript SDKs for consuming SAP APIs from any cloud app"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000007",
    "verb": "BUILD",
    "shelf": "REFERENCE",
    "sortOrder": 70,
    "title": "Fiori Design System",
    "url": "https://www.sap.com/design-system/",
    "isExternal": true,
    "isActive": true,
    "description": "SAP Fiori design guidelines for web, mobile, and Build apps"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000008",
    "verb": "BUILD",
    "shelf": "REFERENCE",
    "sortOrder": 80,
    "title": "Business Application Studio",
    "url": "https://help.sap.com/docs/SAP_BUSINESS_APPLICATION_STUDIO",
    "isExternal": true,
    "isActive": true,
    "description": "Official docs for the cloud IDE purpose-built for SAP development"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000009",
    "verb": "BUILD",
    "shelf": "TOOLS",
    "sortOrder": 90,
    "title": "SAP Development Tools",
    "url": "https://tools.hana.ondemand.com",
    "isExternal": true,
    "isActive": true,
    "description": "Download portal for Eclipse plugins, CLIs, HANA client, and SDKs"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000010",
    "verb": "BUILD",
    "shelf": "TOOLS",
    "sortOrder": 100,
    "title": "UI5 Web Components for React",
    "url": "https://sap.github.io/ui5-webcomponents-react/",
    "isExternal": true,
    "isActive": true,
    "description": "React wrappers for UI5 web components — enterprise-grade UI in React"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000011",
    "verb": "BUILD",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 110,
    "title": "SAP Tech Bytes",
    "url": "https://youtube.com/@sapdevs",
    "isExternal": true,
    "isActive": true,
    "description": "Short-form, code-focused SAP Developers YouTube videos"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000012",
    "verb": "BUILD",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 120,
    "title": "CAP Community Blogs",
    "url": "https://community.sap.com/t5/all-sap-community-blogs/ct-p/all-blogs",
    "isExternal": true,
    "isActive": true,
    "description": "Latest community articles on CAP, ABAP, Fiori, and BTP development"
  },
  {
    "ID": "66333900-0001-0002-0001-000000000013",
    "verb": "BUILD",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 130,
    "title": "CodeJams",
    "url": "/tutorial-navigator/",
    "isExternal": false,
    "isActive": true,
    "description": "Hands-on in-person and virtual workshops delivered by SAP experts"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000001",
    "verb": "INTEGRATE",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "SAP Business Accelerator Hub",
    "url": "https://api.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "Browse and test SAP APIs across S/4HANA, SuccessFactors, Ariba, and more"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000002",
    "verb": "INTEGRATE",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "SAP Integration Suite",
    "url": "https://help.sap.com/docs/integration-suite",
    "isExternal": true,
    "isActive": true,
    "description": "Docs for Cloud Integration, API Management, and Event Mesh on BTP"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000003",
    "verb": "INTEGRATE",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "Your First Integration Flow",
    "url": "/tutorial-navigator/",
    "isExternal": false,
    "isActive": true,
    "description": "Step-by-step tutorials for building your first integration on SAP BTP"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000004",
    "verb": "INTEGRATE",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "SAP Event Mesh",
    "url": "https://help.sap.com/docs/event-mesh",
    "isExternal": true,
    "isActive": true,
    "description": "Managed message broker for event-driven architectures on BTP"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000005",
    "verb": "INTEGRATE",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "SAP Destination Service",
    "url": "https://help.sap.com/docs/destination-service",
    "isExternal": true,
    "isActive": true,
    "description": "BTP service that brokers credentials to external endpoints securely"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000006",
    "verb": "INTEGRATE",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "Open Resource Discovery",
    "url": "https://open-resource-discovery.org",
    "isExternal": true,
    "isActive": true,
    "description": "Open protocol for publishing and discovering application + service metadata"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000007",
    "verb": "INTEGRATE",
    "shelf": "REFERENCE",
    "sortOrder": 70,
    "title": "SAP OData Vocabularies",
    "url": "https://sap.github.io/odata-vocabularies/",
    "isExternal": true,
    "isActive": true,
    "description": "OData annotation term definitions across SAP business domains"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000008",
    "verb": "INTEGRATE",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "Project Piper",
    "url": "https://www.project-piper.io/",
    "isExternal": true,
    "isActive": true,
    "description": "Pre-built CI/CD pipelines and shared library for SAP application delivery"
  },
  {
    "ID": "66333900-0001-0003-0001-000000000009",
    "verb": "INTEGRATE",
    "shelf": "TOOLS",
    "sortOrder": 90,
    "title": "Integration Samples",
    "url": "https://github.com/SAP-samples",
    "isExternal": true,
    "isActive": true,
    "description": "Integration flow samples, API patterns, and event-driven architecture demos"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000001",
    "verb": "OPERATE",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "SAP BTP Cockpit",
    "url": "https://cockpit.btp.cloud.sap",
    "isExternal": true,
    "isActive": true,
    "description": "Browser console for managing BTP global accounts, subaccounts, and spaces"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000002",
    "verb": "OPERATE",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "BTP CLI",
    "url": "https://help.sap.com/docs/btp-cli",
    "isExternal": true,
    "isActive": true,
    "description": "Command-line reference for the `btp` tool — automate BTP account management"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000003",
    "verb": "OPERATE",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "BTP Getting Started",
    "url": "https://help.sap.com/docs/btp/sap-business-technology-platform/getting-started",
    "isExternal": true,
    "isActive": true,
    "description": "Onboarding entry point and checklist for SAP Business Technology Platform"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000004",
    "verb": "OPERATE",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "SAP BTP Documentation",
    "url": "https://help.sap.com/docs/btp",
    "isExternal": true,
    "isActive": true,
    "description": "Canonical reference docs for SAP Business Technology Platform"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000005",
    "verb": "OPERATE",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "SAP Discovery Center",
    "url": "https://discovery-center.cloud.sap",
    "isExternal": true,
    "isActive": true,
    "description": "BTP service catalog, guided missions, estimator, and pricing"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000006",
    "verb": "OPERATE",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "Kyma",
    "url": "https://kyma-project.io",
    "isExternal": true,
    "isActive": true,
    "description": "Open-source Kubernetes platform for cloud-native BTP extensions"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000007",
    "verb": "OPERATE",
    "shelf": "REFERENCE",
    "sortOrder": 70,
    "title": "SAP HANA Cloud",
    "url": "https://help.sap.com/docs/SAP_HANA_CLOUD",
    "isExternal": true,
    "isActive": true,
    "description": "Canonical docs for HANA Cloud in-memory database with vector engine"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000008",
    "verb": "OPERATE",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "Business Application Studio",
    "url": "https://help.sap.com/docs/SAP_BUSINESS_APPLICATION_STUDIO",
    "isExternal": true,
    "isActive": true,
    "description": "Cloud IDE purpose-built for CAP, Fiori, mobile, and full-stack BTP development"
  },
  {
    "ID": "66333900-0001-0004-0001-000000000009",
    "verb": "OPERATE",
    "shelf": "TOOLS",
    "sortOrder": 90,
    "title": "SAP Development Tools",
    "url": "https://tools.hana.ondemand.com",
    "isExternal": true,
    "isActive": true,
    "description": "Download Eclipse plugins, CLIs, HANA client, and SDKs"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000001",
    "verb": "AI",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "BTP AI Best Practices",
    "url": "https://btp-ai-bp.docs.sap/",
    "isExternal": true,
    "isActive": true,
    "description": "Curated guides and architecture patterns for building AI apps on BTP"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000002",
    "verb": "AI",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "AI Skills Library",
    "url": "https://skills.cloud.sap/",
    "isExternal": true,
    "isActive": true,
    "description": "Searchable catalog of certified AI skills built on SAP BTP"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000009",
    "verb": "AI",
    "shelf": "START_HERE",
    "sortOrder": 25,
    "title": "Joule Studio",
    "url": "https://help.sap.com/docs/joule-studio",
    "isExternal": true,
    "isActive": true,
    "description": "Low-code authoring environment for custom Joule skills, prompts, and tool integrations — next-generation edition (Q3 2026)",
    "badge": "NEW"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000003",
    "verb": "AI",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "Your First Joule Extension",
    "url": "/tutorial-navigator/",
    "isExternal": false,
    "isActive": true,
    "description": "Tutorial series for building custom Joule extensions with the AI SDK"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000004",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "SAP Joule",
    "url": "https://help.sap.com/docs/joule",
    "isExternal": true,
    "isActive": true,
    "description": "Docs for SAP's generative-AI copilot embedded across SAP products"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000010",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 45,
    "title": "Joule Studio (Classic)",
    "url": "https://help.sap.com/docs/joule-studio#classic",
    "isExternal": true,
    "isActive": true,
    "description": "Classic Joule Studio edition — GA since December 2025 — for teams already shipping skills today"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000005",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "SAP AI Core",
    "url": "https://help.sap.com/docs/sap-ai-core",
    "isExternal": true,
    "isActive": true,
    "description": "Runtime for training and serving ML + GenAI models on BTP"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000006",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "SAP AI Launchpad",
    "url": "https://help.sap.com/docs/sap-ai-launchpad",
    "isExternal": true,
    "isActive": true,
    "description": "Web UI to manage AI scenarios, models, and deployments on BTP"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000007",
    "verb": "AI",
    "shelf": "TOOLS",
    "sortOrder": 70,
    "title": "AI4U Use Case Repository",
    "url": "https://ai4u-website.cfapps.eu10-004.hana.ondemand.com",
    "isExternal": true,
    "isActive": true,
    "description": "50+ real-world AI projects built on SAP BTP — searchable by scenario"
  },
  {
    "ID": "66333900-0001-0005-0001-000000000008",
    "verb": "AI",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "RAG on HANA Cookbook",
    "url": "https://github.com/SAP-samples",
    "isExternal": true,
    "isActive": true,
    "description": "Retrieval-augmented generation patterns using HANA Cloud vector engine"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000001",
    "verb": "CONNECT",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "SAP Community",
    "url": "https://community.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "Networking, Q&A, blogs, and groups for all SAP developer roles"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000002",
    "verb": "CONNECT",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "SAP Developers YouTube",
    "url": "https://youtube.com/@sapdevs",
    "isExternal": true,
    "isActive": true,
    "description": "Tutorial videos, Tech Bytes, Developer News, and live streams"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000003",
    "verb": "CONNECT",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "Devtoberfest",
    "url": "https://community.sap.com/t5/devtoberfest/gh-p/Devtoberfest",
    "isExternal": true,
    "isActive": true,
    "description": "Annual open developer celebration with sessions, challenges, and prizes"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000004",
    "verb": "CONNECT",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "SAP News Center",
    "url": "https://news.sap.com",
    "isExternal": true,
    "isActive": true,
    "description": "Official corporate news, customer stories, and product announcements"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000005",
    "verb": "CONNECT",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "Community Blogs",
    "url": "https://community.sap.com/t5/all-sap-community-blogs/ct-p/all-blogs",
    "isExternal": true,
    "isActive": true,
    "description": "Aggregated blog stream from the SAP Community"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000006",
    "verb": "CONNECT",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "Developer Advocates",
    "url": "/developer-advocates/",
    "isExternal": false,
    "isActive": true,
    "description": "Meet the SAP Developer Advocate team and find their content"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000007",
    "verb": "CONNECT",
    "shelf": "TOOLS",
    "sortOrder": 70,
    "title": "SAP on GitHub",
    "url": "https://github.com/SAP",
    "isExternal": true,
    "isActive": true,
    "description": "SAP's open-source projects and repositories on GitHub"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000008",
    "verb": "CONNECT",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "SAP-samples on GitHub",
    "url": "https://github.com/SAP-samples",
    "isExternal": true,
    "isActive": true,
    "description": "Sample code, tutorial repos, and workshop materials from SAP"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000009",
    "verb": "CONNECT",
    "shelf": "TOOLS",
    "sortOrder": 90,
    "title": "SAP-docs on GitHub",
    "url": "https://github.com/SAP-docs",
    "isExternal": true,
    "isActive": true,
    "description": "Markdown sources for BTP/UI5/ABAP docs — public PRs welcome",
    "badge": "HIDDEN_GEM"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000010",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 100,
    "title": "SAP TechEd",
    "url": "https://www.sap.com/about/events/sap-teched.html",
    "isExternal": true,
    "isActive": true,
    "description": "Annual developer conference with sessions, workshops, and hands-on labs"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000011",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 110,
    "title": "ASUG",
    "url": "https://www.asug.com",
    "isExternal": true,
    "isActive": true,
    "description": "North America's largest SAP user community — events and networking",
    "badge": "THIRD_PARTY"
  },
  {
    "ID": "66333900-0001-0006-0001-000000000012",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 120,
    "title": "SAPinsider",
    "url": "https://sapinsider.org",
    "isExternal": true,
    "isActive": true,
    "description": "Independent SAP professional community publication and events",
    "badge": "THIRD_PARTY"
  },
  {
    "ID": "66333900-1029-1001-0001-000000000001",
    "verb": "MODEL",
    "shelf": "START_HERE",
    "sortOrder": 10,
    "title": "SAP HANA Cloud",
    "url": "https://help.sap.com/docs/hana-cloud",
    "isExternal": true,
    "isActive": true,
    "description": "Managed in-memory database with columnar analytics, spatial, and graph capabilities"
  },
  {
    "ID": "66333900-1029-1001-0001-000000000002",
    "verb": "MODEL",
    "shelf": "START_HERE",
    "sortOrder": 20,
    "title": "SAP Datasphere",
    "url": "https://help.sap.com/docs/SAP_DATASPHERE",
    "isExternal": true,
    "isActive": true,
    "description": "Business data fabric — model, federate, and govern data across SAP and third-party sources"
  },
  {
    "ID": "66333900-1029-1001-0001-000000000003",
    "verb": "MODEL",
    "shelf": "START_HERE",
    "sortOrder": 30,
    "title": "SAP Business Data Cloud",
    "url": "https://www.sap.com/products/data-cloud/business-data-cloud.html",
    "isExternal": true,
    "isActive": true,
    "description": "Unified data platform that combines SAP + Databricks for AI-ready business data",
    "badge": "NEW"
  },
  {
    "ID": "66333900-1029-1002-0001-000000000001",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 40,
    "title": "HANA Cloud Modeling Guide",
    "url": "https://help.sap.com/docs/hana-cloud/sap-hana-cloud-modeling-guide/sap-hana-cloud-modeling-guide",
    "isExternal": true,
    "isActive": true,
    "description": "Reference for calculation views, HDI containers, and semantic modeling in HANA Cloud"
  },
  {
    "ID": "66333900-1029-1002-0001-000000000002",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 50,
    "title": "Datasphere Modeling",
    "url": "https://help.sap.com/docs/SAP_DATASPHERE/9f804b8efa8043539289f42f372c4862/459f2ecb37fd4c0299edac35e1670ac6.html",
    "isExternal": true,
    "isActive": true,
    "description": "Build semantic views, data flows, and analytic models in Datasphere spaces"
  },
  {
    "ID": "66333900-1029-1002-0001-000000000003",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 60,
    "title": "SAP Analytics Cloud",
    "url": "https://help.sap.com/docs/SAP_ANALYTICS_CLOUD",
    "isExternal": true,
    "isActive": true,
    "description": "Cloud analytics — stories, dashboards, planning, and predictive on top of your data models"
  },
  {
    "ID": "66333900-1029-1003-0001-000000000001",
    "verb": "MODEL",
    "shelf": "TOOLS",
    "sortOrder": 70,
    "title": "SAP HANA Database Explorer",
    "url": "https://help.sap.com/docs/hana-cloud-database/sap-hana-database-explorer/sap-hana-database-explorer",
    "isExternal": true,
    "isActive": true,
    "description": "Web-based SQL console, catalog browser, and modeling tool for HANA Cloud"
  },
  {
    "ID": "66333900-1029-1003-0001-000000000002",
    "verb": "MODEL",
    "shelf": "TOOLS",
    "sortOrder": 80,
    "title": "hana-cli",
    "url": "https://www.npmjs.com/package/hana-cli",
    "isExternal": true,
    "isActive": true,
    "description": "Command-line toolkit for HANA — SQL, table inspection, data profiling, and imports"
  },
  {
    "ID": "66333900-1029-1003-0001-000000000003",
    "verb": "MODEL",
    "shelf": "TOOLS",
    "sortOrder": 90,
    "title": "Data Model Samples",
    "url": "https://github.com/SAP-samples?q=hana&type=all",
    "isExternal": true,
    "isActive": true,
    "description": "Canonical HANA, Datasphere, and analytics data-model examples on SAP-samples"
  },
  {
    "ID": "66333900-1029-1004-0001-000000000001",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 100,
    "title": "HANA Cloud What's New",
    "url": "https://help.sap.com/docs/hana-cloud/sap-hana-cloud-what-s-new/sap-hana-cloud-what-s-new",
    "isExternal": true,
    "isActive": true,
    "description": "Release notes for HANA Cloud — new features and quarterly capability additions"
  },
  {
    "ID": "66333900-1029-1004-0001-000000000002",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 110,
    "title": "Datasphere Roadmap",
    "url": "https://roadmaps.sap.com/board?PRODUCT=73555000100800002141",
    "isExternal": true,
    "isActive": true,
    "description": "Public roadmap for SAP Datasphere — planned innovations and delivery timelines"
  },
  {
    "ID": "66333900-1029-1004-0001-000000000003",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 120,
    "title": "Data & Analytics Community",
    "url": "https://community.sap.com/t5/technology/ct-p/technology-blogs",
    "isExternal": true,
    "isActive": true,
    "description": "SAP Community blogs and Q&A for HANA, Datasphere, BDC, and SAC practitioners"
  },
  {
    "ID": "66333900-rpt1-0005-0001-000000000001",
    "verb": "AI",
    "shelf": "START_HERE",
    "sortOrder": 26,
    "title": "SAP RPT-1 Playground",
    "url": "https://rpt.cloud.sap",
    "description": "Try SAP's RPT-1 tabular foundation model in the browser — bring your own data or use SAP-provided example datasets.",
    "badge": "NEW",
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Predict on your tables with RPT-1 — no training, right in the browser.",
    "whyItMatters": "RPT-1 is SAP's semantics-aware foundation model for tabular data. The playground lets you run classification and regression on your own tables or SAP sample datasets without any setup — the fastest way to see what the model does.",
    "personaTags": [
      "role:developer",
      "role:student",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-rpt1-0005-0001-000000000002",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 35,
    "title": "SAP RPT-1 on Hugging Face",
    "url": "https://huggingface.co/SAP/sap-rpt-1-oss",
    "description": "Open-source release of SAP RPT-1 — model card, weights, and usage examples for the tabular foundation model.",
    "badge": "NEW",
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "The open-source RPT-1 model card, weights, and examples.",
    "whyItMatters": "RPT-1 is published open-source on Hugging Face as a semantics-aware tabular in-context learner for classification and regression. The model card is the reference for developers integrating it into their own pipelines.",
    "personaTags": [
      "role:developer",
      "role:student",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-rpt1-1029-0001-000000000001",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 65,
    "title": "SAP RPT-1",
    "url": "https://rpt.cloud.sap",
    "description": "SAP's relational/tabular foundation model — predict directly on structured data without task-specific training.",
    "badge": "NEW",
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "A foundation model that predicts directly on your data models.",
    "whyItMatters": "RPT-1 brings foundation-model prediction to structured, tabular data — the shape of most SAP business data. For teams modeling data in HANA Cloud or Datasphere, it is a fast path to classification and regression without building a bespoke ML pipeline.",
    "personaTags": [
      "role:developer",
      "role:architect",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-0002-0001-000000000001",
    "verb": "BUILD",
    "shelf": "TOOLS",
    "sortOrder": 200,
    "title": "Vercel",
    "url": "https://vercel.com",
    "description": "Frontend cloud for building and deploying React, Vue, and static sites with global edge delivery.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Deploy React and Vue frontends to a global edge in minutes.",
    "whyItMatters": "CAP treats React and Vue as first-class frontends. Vercel is a common host for those SPAs, giving developers preview deployments, edge functions, and CI-driven releases that pair well with a CAP backend on BTP.",
    "personaTags": [
      "role:developer",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000001",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 200,
    "title": "Dremio",
    "url": "https://www.dremio.com",
    "description": "Lakehouse platform for SQL analytics directly on data lake storage, built around Apache Iceberg.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Query your data lake with SQL — no copies, no cubes.",
    "whyItMatters": "Dremio is a leading open lakehouse engine. For teams federating SAP data with lake storage, it is a practical reference for Iceberg-based analytics alongside SAP Datasphere and Business Data Cloud.",
    "personaTags": [
      "role:developer",
      "role:architect",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000002",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 210,
    "title": "Dremio Community",
    "url": "https://community.dremio.com",
    "description": "Community forum for Dremio users — Q&A, how-tos, and release discussion.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Ask questions and share patterns with other Dremio users.",
    "whyItMatters": "The Dremio community forum is where lakehouse practitioners troubleshoot Iceberg, reflections, and federation — useful when integrating lake data with SAP analytics.",
    "personaTags": [
      "role:developer",
      "role:architect"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000003",
    "verb": "MODEL",
    "shelf": "REFERENCE",
    "sortOrder": 220,
    "title": "Apache Iceberg",
    "url": "https://iceberg.apache.org",
    "description": "Open table format for huge analytic datasets — the storage standard behind modern lakehouses.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "The open table format underpinning modern lakehouses.",
    "whyItMatters": "Iceberg is the table format SAP Business Data Cloud and many lake engines build on. Understanding it helps architects reason about how SAP and non-SAP data interoperate at the storage layer.",
    "personaTags": [
      "role:developer",
      "role:architect",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000004",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 230,
    "title": "Data Engineering Weekly",
    "url": "https://www.dataengineeringweekly.com",
    "description": "Curated weekly newsletter on data engineering trends, tools, and architecture.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Stay current on the wider data-engineering ecosystem.",
    "whyItMatters": "A concise weekly read that keeps data architects aware of trends beyond the SAP stack — pipelines, formats, and platform shifts that influence integration choices.",
    "personaTags": [
      "role:architect"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000005",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 240,
    "title": "The Data Stack Show",
    "url": "https://datastackshow.com",
    "description": "Podcast with data engineers and founders on how modern data stacks are built and run.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Conversations on how real data stacks get built.",
    "whyItMatters": "Practitioner interviews that surface the tradeoffs behind modern data platforms — helpful context for teams positioning SAP data products within a broader stack.",
    "personaTags": [
      "role:developer",
      "role:architect"
    ]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000006",
    "verb": "MODEL",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 250,
    "title": "Reltio Community",
    "url": "https://community.reltio.com",
    "description": "Community for Reltio master-data-management practitioners — Q&A and best practices.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Master-data-management practices from the Reltio community.",
    "whyItMatters": "MDM is a frequent companion to SAP data landscapes. The Reltio community is a reference point for entity resolution and data-quality patterns that complement SAP master data.",
    "personaTags": [
      "role:developer",
      "role:architect"
    ]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000001",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 200,
    "title": "Hugging Face",
    "url": "https://huggingface.co",
    "description": "Hub for open models, datasets, and ML tooling — the de facto registry for the AI ecosystem.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "The open hub for models, datasets, and ML tooling.",
    "whyItMatters": "Hugging Face is where most open models and datasets live. Developers building AI on BTP often source or evaluate models here before deploying via SAP AI Core.",
    "personaTags": [
      "role:developer",
      "role:student",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000002",
    "verb": "AI",
    "shelf": "TOOLS",
    "sortOrder": 210,
    "title": "TabPFN (Prior Labs)",
    "url": "https://github.com/PriorLabs/TabPFN",
    "description": "Foundation model for tabular data that delivers strong results on small datasets without training.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "A foundation model for tabular data — no training required.",
    "whyItMatters": "Most enterprise data is tabular. TabPFN is a notable open model for tabular prediction, relevant to developers exploring ML on structured SAP data.",
    "personaTags": [
      "role:developer",
      "role:student"
    ]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000003",
    "verb": "AI",
    "shelf": "REFERENCE",
    "sortOrder": 220,
    "title": "Prior Labs Research",
    "url": "https://priorlabs.ai/research",
    "description": "Research and technical reports behind TabPFN and tabular foundation models.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "The research behind tabular foundation models.",
    "whyItMatters": "Prior Labs publishes the papers and reports underpinning TabPFN, including work featured in Nature — a primary source for developers evaluating the approach.",
    "personaTags": [
      "role:developer",
      "role:student"
    ]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000004",
    "verb": "AI",
    "shelf": "TOOLS",
    "sortOrder": 230,
    "title": "Kaggle",
    "url": "https://www.kaggle.com",
    "description": "Platform for datasets, notebooks, and ML competitions with a large practitioner community.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Datasets, notebooks, and competitions to sharpen ML skills.",
    "whyItMatters": "Kaggle is a practical training ground for data science. Its datasets and notebooks help developers and students build the ML skills they later apply on SAP data.",
    "personaTags": [
      "role:developer",
      "role:student"
    ]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000001",
    "verb": "INTEGRATE",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 200,
    "title": "n8n Community Forum",
    "url": "https://community.n8n.io",
    "description": "Official forum for the n8n workflow-automation community — Q&A, templates, and help.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Get help and share n8n automation workflows.",
    "whyItMatters": "n8n is a popular open workflow-automation tool used to integrate SAP and non-SAP systems. Its forum is the primary place to find node patterns and troubleshoot flows.",
    "personaTags": [
      "role:developer",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000002",
    "verb": "INTEGRATE",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 210,
    "title": "n8n Discord",
    "url": "https://discord.gg/n8n",
    "description": "Real-time chat community for n8n users and contributors.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Real-time chat with the n8n community.",
    "whyItMatters": "The n8n Discord is where users get quick answers and share in-progress automations — a fast channel when building integrations that touch SAP endpoints.",
    "personaTags": [
      "role:developer"
    ]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000003",
    "verb": "INTEGRATE",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 220,
    "title": "n8n on YouTube",
    "url": "https://www.youtube.com/c/n8n-io",
    "description": "Official n8n channel — tutorials, feature demos, and automation walkthroughs.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Video tutorials and demos for n8n automation.",
    "whyItMatters": "n8n's YouTube channel walks through building automations step by step — a fast way to learn node patterns before wiring up SAP integrations.",
    "personaTags": [
      "role:developer"
    ]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000004",
    "verb": "INTEGRATE",
    "shelf": "TOOLS",
    "sortOrder": 230,
    "title": "n8n (n8n-io/n8n)",
    "url": "https://github.com/n8n-io/n8n",
    "description": "Source repository for the n8n workflow-automation platform.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "The open-source n8n automation engine on GitHub.",
    "whyItMatters": "The n8n repo is the source of truth for the automation engine and its nodes — the place to file issues, read code, and understand how integrations execute.",
    "personaTags": [
      "role:developer",
      "deployment:cloud"
    ]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000005",
    "verb": "INTEGRATE",
    "shelf": "TOOLS",
    "sortOrder": 240,
    "title": "n8n docs (n8n-io/n8n-docs)",
    "url": "https://github.com/n8n-io/n8n-docs",
    "description": "Documentation source for n8n — node references and self-hosting guides.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Docs and node references for n8n, open to contributions.",
    "whyItMatters": "The n8n-docs repo holds node references and self-hosting guides, and accepts public PRs — useful when documenting a custom SAP integration node.",
    "personaTags": [
      "role:developer"
    ]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000001",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 200,
    "title": "r/SAP",
    "url": "https://www.reddit.com/r/SAP",
    "description": "Reddit community discussing SAP products, careers, and day-to-day practice.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Candid SAP discussion from the wider practitioner community.",
    "whyItMatters": "r/SAP is an unfiltered view of what SAP practitioners are dealing with — a useful pulse-check beyond official channels.",
    "personaTags": [
      "role:developer"
    ]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000002",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 210,
    "title": "r/dataengineering",
    "url": "https://www.reddit.com/r/dataengineering",
    "description": "Reddit community for data engineers — tooling debates, career, and architecture.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Where data engineers debate tools and architecture.",
    "whyItMatters": "A high-signal community for data-platform trends and tradeoffs that inform how SAP data fits a broader engineering stack.",
    "personaTags": [
      "role:architect"
    ]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000003",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 220,
    "title": "r/MachineLearning",
    "url": "https://www.reddit.com/r/MachineLearning",
    "description": "Reddit community covering ML research, tooling, and applied practice.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "ML research and applied practice, community-curated.",
    "whyItMatters": "Keeps developers aware of ML advances they may bring to SAP data — from model families to applied techniques.",
    "personaTags": [
      "role:developer"
    ]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000004",
    "verb": "CONNECT",
    "shelf": "KEEP_CURRENT",
    "sortOrder": 230,
    "title": "r/n8n",
    "url": "https://www.reddit.com/r/n8n",
    "description": "Reddit community for n8n workflow automation — recipes and troubleshooting.",
    "badge": null,
    "isExternal": true,
    "isActive": true,
    "authoringStatus": "REVIEWED",
    "personaWeight": 0,
    "tagline": "Automation recipes and troubleshooting for n8n.",
    "whyItMatters": "A community source for n8n automation recipes, complementing the official forum when building integrations across SAP and other systems.",
    "personaTags": [
      "role:developer"
    ]
  }
];
