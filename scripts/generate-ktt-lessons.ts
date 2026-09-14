/**
 * scripts/generate-ktt-lessons.ts
 *
 * Generates hugo/data/ktt_lessons.json — the KTT ("Kasimir Teaches TLAs") lesson
 * content file consumed by the Vue KTT island at /explore/ktt/.
 *
 * GROUNDING NOTE: Every TLA→expansion in SEED has been verified against:
 *   - CAP official documentation (cds-mcp search_docs)
 *   - SAP Help Portal / SAP Discovery Center official product names
 *   - sap-devs-server MCP context (get_context / search_resources)
 *   - IETF / OASIS standards (OData, JWT, SAML, TLS, REST)
 *
 * Run with: npx tsx scripts/generate-ktt-lessons.ts
 * Optional AI draft mode: npx tsx scripts/generate-ktt-lessons.ts --draft
 *   (--draft is a no-op stub in v1; all kasimir/distractor lines are hand-authored)
 */
import { writeFileSync } from 'node:fs';
import { validateLessons, KttData, KttUnit, KttLesson, KttBeat } from './lib/ktt-lessons-schema.js';

/** Curated + grounded TLA seed data. unitId maps to unit definitions below. */
interface SeedEntry {
  tla: string;
  expansion: string;
  blurb: string;
  category: string;
  unitId: string;
  lessonIdx: number; // 0-based index within the unit's lessons
  distractors: string[]; // plausible-but-wrong expansions, >=2
  kasimirRight: string; // ≤160 chars — shown when correct
  kasimirWrong: string; // ≤160 chars — shown when wrong
}

const SEED: SeedEntry[] = [
  // ─── Unit 1: Core Platform ───────────────────────────────────────────────────
  {
    tla: 'SAP', expansion: 'Systems, Applications, Products in Data Processing',
    blurb: 'The full name of the company behind your daily BTP adventures. Founded in Walldorf, 1972.',
    category: 'company',
    unitId: 'unit-1-platform', lessonIdx: 0,
    distractors: ['Software Architecture Platform', 'Service Automation Protocol'],
    kasimirRight: 'Correct! Even I know who signs my cat food invoices. 🐱',
    kasimirWrong: 'SAP = Systems, Applications, Products in Data Processing. It\'s literally on the letterhead!',
  },
  {
    tla: 'BTP', expansion: 'SAP Business Technology Platform',
    blurb: 'SAP\'s unified cloud platform for building, extending, and integrating business applications. The successor to SAP Cloud Platform (SCP).',
    category: 'platform',
    unitId: 'unit-1-platform', lessonIdx: 0,
    distractors: ['SAP Big-data Transaction Platform', 'SAP Business Transaction Processing'],
    kasimirRight: 'BTP — the cloud with a view from Walldorf! Nicely done. ☁️',
    kasimirWrong: 'BTP = SAP Business Technology Platform. The "T" is Technology, not Transaction.',
  },
  {
    tla: 'SCP', expansion: 'SAP Cloud Platform',
    blurb: 'The former name of SAP BTP (deprecated 2021). You\'ll still see SCP in older tutorials and Stack Overflow answers.',
    category: 'platform',
    unitId: 'unit-1-platform', lessonIdx: 0,
    distractors: ['SAP Continuous Provisioning', 'SAP Core Protocol'],
    kasimirRight: 'SCP — the old BTP. Nostalgia is allowed. 📜',
    kasimirWrong: 'SCP = SAP Cloud Platform, the predecessor to BTP. History matters in enterprise software!',
  },
  {
    tla: 'IAS', expansion: 'SAP Identity Authentication Service',
    blurb: 'SAP\'s cloud-based Identity Provider (IdP) on BTP. Handles authentication for SAP apps and custom services via SAML 2.0 and OIDC.',
    category: 'security',
    unitId: 'unit-1-platform', lessonIdx: 0,
    distractors: ['Integrated Authorization Service', 'Internal Application Server'],
    kasimirRight: 'IAS — the bouncer of the SAP cloud. Excellent! 🚪',
    kasimirWrong: 'IAS = SAP Identity Authentication Service. It\'s the IdP, not just any authorization layer.',
  },
  // Lesson 1-1 above; now lesson 1-2
  {
    tla: 'CAP', expansion: 'SAP Cloud Application Programming Model',
    blurb: 'SAP\'s framework for building cloud-native business applications using CDS, Node.js, and Java. The backbone of tutorials-ims.',
    category: 'framework',
    unitId: 'unit-1-platform', lessonIdx: 1,
    distractors: ['Cloud API Protocol', 'Customer Application Pack'],
    kasimirRight: 'CAP! You\'ve earned a treat. My whole world runs on CAP. 🐾',
    kasimirWrong: 'CAP = SAP Cloud Application Programming Model. CDS, Node.js, Java — it\'s all in there.',
  },
  {
    tla: 'BAS', expansion: 'SAP Business Application Studio',
    blurb: 'SAP\'s browser-based IDE on BTP, built on VS Code Open Source. The recommended tool for CAP, Fiori, and ABAP Cloud development.',
    category: 'tooling',
    unitId: 'unit-1-platform', lessonIdx: 1,
    distractors: ['Backend Automation System', 'Business API Services'],
    kasimirRight: 'BAS — where humans write the code that Kasimir reviews. Well played! 💻',
    kasimirWrong: 'BAS = SAP Business Application Studio — the cloud IDE on BTP, not a backend system.',
  },
  {
    tla: 'SDK', expansion: 'Software Development Kit',
    blurb: 'A bundle of tools, libraries, and documentation for building on a platform. SAP Cloud SDK adds BTP destinations, resilience, and type-safe OData clients.',
    category: 'tooling',
    unitId: 'unit-1-platform', lessonIdx: 1,
    distractors: ['Service Deployment Kit', 'Standard Data Keyring'],
    kasimirRight: 'SDK — the box of LEGO bricks every developer loves. Exactly right! 🧰',
    kasimirWrong: 'SDK = Software Development Kit. Not "Service Deployment" anything.',
  },
  {
    tla: 'API', expansion: 'Application Programming Interface',
    blurb: 'A defined contract that lets software components talk to each other. SAP publishes thousands of APIs on SAP Business Accelerator Hub (api.sap.com).',
    category: 'architecture',
    unitId: 'unit-1-platform', lessonIdx: 1,
    distractors: ['Automated Process Integration', 'Application Persistence Index'],
    kasimirRight: 'API — the handshake of the cloud world. I knew you\'d get this one! 🤝',
    kasimirWrong: 'API = Application Programming Interface. The "P" is Programming, not Process.',
  },
  // Lesson 1-3
  {
    tla: 'MTA', expansion: 'Multi-Target Application',
    blurb: 'SAP\'s deployment artefact format for BTP. A single `.mtar` archive bundles multiple modules (backend, UI, DB) and wires up service bindings automatically.',
    category: 'deployment',
    unitId: 'unit-1-platform', lessonIdx: 2,
    distractors: ['Managed Tenant Architecture', 'Module Transfer Archive'],
    kasimirRight: 'MTA — one package to rule them all! Purrfectly correct. 📦',
    kasimirWrong: 'MTA = Multi-Target Application. It bundles all your BTP modules into one deployable archive.',
  },
  {
    tla: 'ANS', expansion: 'SAP Alert Notification Service',
    blurb: 'A BTP service that sends real-time alerts about application events to email, Slack, or custom webhooks. Used in tutorials-ims for operational monitoring.',
    category: 'operations',
    unitId: 'unit-1-platform', lessonIdx: 2,
    distractors: ['Automated Notification System', 'Application Node Service'],
    kasimirRight: 'ANS — the smoke alarm of your BTP app. Alert! You\'re correct! 🚨',
    kasimirWrong: 'ANS = SAP Alert Notification Service. It notifies, alerts, and generally keeps you from sleeping.',
  },
  {
    tla: 'SAC', expansion: 'SAP Analytics Cloud',
    blurb: 'SAP\'s SaaS business intelligence platform for dashboards, planning, and predictive analytics. Lives on BTP.',
    category: 'analytics',
    unitId: 'unit-1-platform', lessonIdx: 2,
    distractors: ['SAP Application Console', 'SAP Automation Center'],
    kasimirRight: 'SAC — where data becomes pretty pictures! Right on target. 📊',
    kasimirWrong: 'SAC = SAP Analytics Cloud. Dashboards, planning, predictions — all in the cloud.',
  },
  {
    tla: 'MDK', expansion: 'SAP Mobile Development Kit',
    blurb: 'A cross-platform toolkit for building native-looking SAP mobile apps that work offline. Based on a metadata-driven approach — no separate iOS/Android code.',
    category: 'mobile',
    unitId: 'unit-1-platform', lessonIdx: 2,
    distractors: ['Mobile Data Kit', 'Metadata Deployment Kit'],
    kasimirRight: 'MDK — go mobile! Even I have a paw-friendly app. Great answer! 📱',
    kasimirWrong: 'MDK = SAP Mobile Development Kit. Cross-platform, metadata-driven, and furiously offline-capable.',
  },

  // ─── Unit 2: CDS & App Development ───────────────────────────────────────────
  {
    tla: 'CDS', expansion: 'Core Data Services',
    blurb: 'CAP\'s universal declarative language for data models and service definitions. Also powers S/4HANA views. The backbone of everything in CAP.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 0,
    distractors: ['Cloud Data Store', 'Connected Data Services'],
    kasimirRight: 'CDS — the language I dream in! You\'ve clearly been reading the docs. 📚',
    kasimirWrong: 'CDS = Core Data Services — SAP\'s universal modeling language. Not "Cloud" anything.',
  },
  {
    tla: 'CSN', expansion: 'Core Schema Notation',
    blurb: 'CDS models compiled to a compact JSON representation (pronounced "Season"). The runtime format CAP uses internally — generated from CDL source files.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 0,
    distractors: ['Cloud Service Network', 'Core Serialization Notation'],
    kasimirRight: 'CSN — like JSON Schema but for full entity-relationship models. Season greetings! 🎄',
    kasimirWrong: 'CSN = Core Schema Notation, pronounced "Season". It\'s the JSON form of your CDS models.',
  },
  {
    tla: 'CDL', expansion: 'Conceptual Definition Language',
    blurb: 'The human-readable source syntax you write in `.cds` files — entities, services, annotations. Official CAP docs state: "We use CDS\'s Conceptual Definition Language (CDL)…". Compiles to CSN for runtime use.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 0,
    distractors: ['Cloud Deployment Language', 'Core Data Library'],
    kasimirRight: 'CDL — what you write, CSN is what the machine reads. You\'re fluent! ✍️',
    kasimirWrong: 'CDL = Conceptual Definition Language (official CAP term). The .cds files you write are CDL; they compile down to CSN.',
  },
  {
    tla: 'CQL', expansion: 'CDS Query Language',
    blurb: 'The SQL-like query language for CAP: `SELECT.from(Books).where(...)`. Type-safe, composable, and database-agnostic. Part of the `cds.ql` API.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 0,
    distractors: ['Cloud Query Layer', 'Core Queue Language'],
    kasimirRight: 'CQL — SELECT * FROM correct_answers! Top marks. 🐱‍💻',
    kasimirWrong: 'CQL = CDS Query Language — the SELECT.from(...) syntax in `cds.ql`. Never write raw SQL!',
  },
  // Lesson 2-2
  {
    tla: 'OData', expansion: 'Open Data Protocol',
    blurb: 'An OASIS standard REST-based protocol for CRUD APIs with query capabilities ($filter, $expand, $top…). All CAP services can be served as OData V4.',
    category: 'protocol',
    unitId: 'unit-2-cds', lessonIdx: 1,
    distractors: ['Optimised Data Access', 'Object Data Architecture'],
    kasimirRight: 'OData — the protocol that makes SAP APIs queryable from Excel. Impressive! 📡',
    kasimirWrong: 'OData = Open Data Protocol (OASIS standard). Think REST + $filter + $expand — pure power.',
  },
  {
    tla: 'RAP', expansion: 'ABAP RESTful Application Programming Model',
    blurb: 'SAP\'s recommended framework for building Fiori apps and OData services on ABAP. Uses CDS views, behavior definitions, and service bindings.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 1,
    distractors: ['Remote Application Protocol', 'Resource-Aware Processing'],
    kasimirRight: 'RAP — the CAP of the ABAP world! You\'re now officially bilingual. 🎓',
    kasimirWrong: 'RAP = ABAP RESTful Application Programming Model. It\'s to ABAP what CAP is to Node.js/Java.',
  },
  {
    tla: 'ABAP', expansion: 'Advanced Business Application Programming',
    blurb: 'SAP\'s original high-level programming language, born in the 1980s and still the heart of S/4HANA. ABAP Cloud is its clean-core, BTP-ready modern incarnation — and the foundation RAP is built on.',
    category: 'framework',
    unitId: 'unit-2-cds', lessonIdx: 1,
    distractors: ['Automated Batch Application Processing', 'ABAP Business Application Platform'],
    kasimirRight: 'ABAP — SAP\'s original language, older than most developers and still going strong! Correct. 🧓',
    kasimirWrong: 'ABAP = Advanced Business Application Programming. SAP\'s classic language, and RAP\'s foundation.',
  },
  {
    tla: 'REST', expansion: 'Representational State Transfer',
    blurb: 'The architectural style behind most web APIs: stateless HTTP, resources as URLs, verbs as HTTP methods (GET/POST/PUT/DELETE). OData is a RESTful protocol.',
    category: 'protocol',
    unitId: 'unit-2-cds', lessonIdx: 1,
    distractors: ['Remote Event Stream Transfer', 'Reliable Endpoint Service Technology'],
    kasimirRight: 'REST — the law of the web land. Stateless, resourceful, correct! 🌐',
    kasimirWrong: 'REST = Representational State Transfer (Roy Fielding, 2000). Every web API architect owes him a coffee.',
  },
  {
    tla: 'IDE', expansion: 'Integrated Development Environment',
    blurb: 'A software tool that combines code editor, debugger, and build tools in one UI. SAP\'s cloud IDE is BAS; locally VS Code + CDS extension is the go-to.',
    category: 'tooling',
    unitId: 'unit-2-cds', lessonIdx: 1,
    distractors: ['Internal Deployment Engine', 'Interface Design Editor'],
    kasimirRight: 'IDE — where the magic happens before the bug report! You knew it. 🖥️',
    kasimirWrong: 'IDE = Integrated Development Environment. VS Code + CDS extension = one happy IDE.',
  },
  // Lesson 2-3
  {
    tla: 'FLP', expansion: 'SAP Fiori Launchpad',
    blurb: 'The web shell that hosts SAP Fiori apps as tiles in a unified homepage. Handles navigation, routing, and user personalization across all Fiori apps.',
    category: 'ui',
    unitId: 'unit-2-cds', lessonIdx: 2,
    distractors: ['Flexible Layout Page', 'Fiori Link Provider'],
    kasimirRight: 'FLP — the tile garden where Fiori apps bloom! Nailed it. 🏡',
    kasimirWrong: 'FLP = SAP Fiori Launchpad — the shell that tiles up your Fiori apps in one place.',
  },
  {
    tla: 'UI5', expansion: 'SAPUI5',
    blurb: 'SAPUI5 is a product name, not a spelled-out acronym — "5" is the generation designator for SAP\'s enterprise JavaScript UI framework. Built on OpenUI5 (the open-source base), it delivers Fiori-ready components, Horizon theme, and OData V4 model binding out of the box.',
    category: 'ui',
    unitId: 'unit-2-cds', lessonIdx: 2,
    distractors: ['Universal Interface 5', 'SAP User Interaction 5'],
    kasimirRight: 'UI5 — the framework behind every Fiori face! Stylishly correct. 🎨',
    kasimirWrong: 'UI5 = SAPUI5 — SAP\'s enterprise JavaScript framework. OpenUI5 is its open-source twin.',
  },
  {
    tla: 'OPA', expansion: 'One Page Acceptance Test Framework',
    blurb: 'SAP\'s asynchronous integration-test framework for UI5/Fiori apps. Tests page objects and UI flows without flakiness, running inside the browser.',
    category: 'testing',
    unitId: 'unit-2-cds', lessonIdx: 2,
    distractors: ['Open Protocol Adapter', 'Object Page Action'],
    kasimirRight: 'OPA — the test cat catches every bug! Acceptably correct. 🧪',
    kasimirWrong: 'OPA = One Page Acceptance Test Framework — UI5\'s built-in asynchronous integration test library.',
  },
  {
    tla: 'CLI', expansion: 'Command-Line Interface',
    blurb: 'A text-based tool for interacting with software. CAP provides `cds` CLI; BTP has `btp`; CF has `cf`. Together they\'re the developer\'s Swiss army knife.',
    category: 'tooling',
    unitId: 'unit-2-cds', lessonIdx: 2,
    distractors: ['Cloud Layer Interface', 'Component Library Index'],
    kasimirRight: 'CLI — where humans type furiously and things actually happen! Correct! ⌨️',
    kasimirWrong: 'CLI = Command-Line Interface. `cds watch`, `btp login`, `cf push` — all CLI commands.',
  },

  // ─── Unit 3: HANA & Data ──────────────────────────────────────────────────────
  {
    tla: 'HANA', expansion: 'High-performance ANalytic Appliance',
    blurb: 'SAP\'s in-memory relational database. Processes analytical and transactional workloads simultaneously ("HTAP"). The default production database for CAP apps on BTP.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 0,
    distractors: ['Hybrid Application and Network Architecture', 'Hosted Analytical Node Application'],
    kasimirRight: 'HANA — in-memory, in-the-cloud, and in your heart. Right answer! 💾',
    kasimirWrong: 'HANA = High-performance ANalytic Appliance. The capital letters in the middle are the clue!',
  },
  {
    tla: 'HDI', expansion: 'HANA Deployment Infrastructure',
    blurb: 'A SAP HANA feature that manages database artefacts (tables, views, procedures) in isolated, versioned containers. CAP uses HDI containers for all HANA deployments.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 0,
    distractors: ['HANA Data Index', 'Hybrid Deployment Interface'],
    kasimirRight: 'HDI — HANA Deployment Infrastructure. Container-ised perfection! 📦',
    kasimirWrong: 'HDI = HANA Deployment Infrastructure. It\'s the container system that keeps your DB artefacts isolated.',
  },
  {
    tla: 'SDA', expansion: 'SAP HANA Smart Data Access',
    blurb: 'A HANA feature for querying remote data sources (S/4HANA, Oracle, etc.) as virtual tables — without physically moving the data. Federation without ETL.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 0,
    distractors: ['Smart Database Adapter', 'Structured Data Access'],
    kasimirRight: 'SDA — federation without migration! Your HANA knowledge is sharp. 🔗',
    kasimirWrong: 'SDA = SAP HANA Smart Data Access — virtual tables pointing at remote sources. No data movement needed.',
  },
  {
    tla: 'SDI', expansion: 'SAP HANA Smart Data Integration',
    blurb: 'HANA\'s data integration layer: real-time replication, batch loading, and transformation from heterogeneous sources using Data Provisioning Agents.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 0,
    distractors: ['Structured Data Index', 'Smart Deployment Interface'],
    kasimirRight: 'SDI — data flows like water to a thirsty cat! Correct! 🌊',
    kasimirWrong: 'SDI = SAP HANA Smart Data Integration. Real-time replication + transformations via DP Agents.',
  },
  // Lesson 3-2
  {
    tla: 'CPI', expansion: 'SAP Cloud Platform Integration',
    blurb: 'The former name for SAP Integration Suite\'s cloud integration capability. Still widely used in docs and project names. Handles message routing and transformation between systems.',
    category: 'integration',
    unitId: 'unit-3-hana', lessonIdx: 1,
    distractors: ['Cloud Process Interface', 'Core Protocol Integration'],
    kasimirRight: 'CPI — connecting the dots since before it was called Integration Suite! 🔌',
    kasimirWrong: 'CPI = SAP Cloud Platform Integration — now part of SAP Integration Suite, but the name persists.',
  },
  {
    tla: 'DWC', expansion: 'SAP Data Warehouse Cloud',
    blurb: 'SAP\'s cloud data warehouse solution, rebranded as SAP Datasphere in 2023. Provides data modelling, integration, and analytics on a single platform.',
    category: 'analytics',
    unitId: 'unit-3-hana', lessonIdx: 1,
    distractors: ['Distributed Warehouse Controller', 'Data Web Console'],
    kasimirRight: 'DWC — now Datasphere but the acronym lives on. Historically accurate! 📐',
    kasimirWrong: 'DWC = SAP Data Warehouse Cloud — rebranded to SAP Datasphere in 2023 but DWC still appears everywhere.',
  },
  {
    tla: 'BDC', expansion: 'SAP Business Data Cloud',
    blurb: 'SAP\'s unified, fully-managed SaaS solution (announced 2025) that connects and harmonises data across SAP and third-party sources — built on SAP Datasphere, SAP Analytics Cloud, and Databricks.',
    category: 'analytics',
    unitId: 'unit-3-hana', lessonIdx: 1,
    distractors: ['Business Data Center', 'Batch Data Communication'],
    kasimirRight: 'BDC — SAP\'s newest home for unified business data. Bang up to date! 📊',
    kasimirWrong: 'BDC = SAP Business Data Cloud — SAP\'s unified data platform, not the old batch-input trick.',
  },
  {
    tla: 'SQL', expansion: 'Structured Query Language',
    blurb: 'The standard language for relational databases. In CAP, you should use CQL (CDS Query Language) instead of raw SQL — but HANA\'s SQL dialect is what runs under the hood.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 1,
    distractors: ['Scalable Query Logic', 'Sequential Queue Language'],
    kasimirRight: 'SQL — the granddaddy of data languages. CAP wraps it, but knowing it never hurts! ✅',
    kasimirWrong: 'SQL = Structured Query Language. Use CQL in CAP code, but SQL is what HANA actually runs.',
  },
  {
    tla: 'ODP', expansion: 'Operational Data Provisioning',
    blurb: 'SAP\'s framework for extracting data from S/4HANA and ECC sources into analytics or integration platforms. Exposes CDS views, BW extractors, and SLT as replication sources.',
    category: 'integration',
    unitId: 'unit-3-hana', lessonIdx: 1,
    distractors: ['Open Data Provisioning', 'Output Data Protocol'],
    kasimirRight: 'ODP — the SAP data extraction expressway! Spot on. 🚂',
    kasimirWrong: 'ODP = Operational Data Provisioning — SAP\'s framework for exporting data from ERP systems to analytics.',
  },
  // Lesson 3-3
  {
    tla: 'ETL', expansion: 'Extract, Transform, Load',
    blurb: 'The classic data pipeline pattern: extract from source, transform (cleanse/enrich), load into target. Used in SAP Data Services, BW, and Datasphere pipelines.',
    category: 'integration',
    unitId: 'unit-3-hana', lessonIdx: 2,
    distractors: ['Enterprise Transfer Layer', 'Event Trigger Logic'],
    kasimirRight: 'ETL — the cat-nap to data-warehouse pipeline of legend! Extract correct answer, +1. 📥',
    kasimirWrong: 'ETL = Extract, Transform, Load — the three-step dance every data warehouse knows by heart.',
  },
  {
    tla: 'HDB', expansion: 'SAP HANA Database',
    blurb: 'The "HDB" prefix appears across HANA tooling: `hdbsql` (CLI SQL client), `.hdbtable` artefact files, and `@sap/hana-client` (the Node.js driver).',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 2,
    distractors: ['Hybrid Data Bus', 'HANA Deployment Bundle'],
    kasimirRight: 'HDB — you\'ll see this prefix everywhere in HANA-land. Well spotted! 🐾',
    kasimirWrong: 'HDB = SAP HANA Database — the prefix behind hdbsql, .hdbtable files, and the Node.js driver.',
  },
  {
    tla: 'DDL', expansion: 'Data Definition Language',
    blurb: 'The SQL subset for defining database structures: CREATE TABLE, ALTER TABLE, DROP. In CAP, CDS handles DDL generation automatically from your models.',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 2,
    distractors: ['Dynamic Data Loader', 'Distributed Definition Layer'],
    kasimirRight: 'DDL — CREATE TABLE? More like CREATE SUCCESS. Correct! 🏗️',
    kasimirWrong: 'DDL = Data Definition Language — CREATE, ALTER, DROP. CAP generates it from CDS; you rarely write it directly.',
  },
  {
    tla: 'LOB', expansion: 'Large Object',
    blurb: 'A database column type for storing large binary (BLOB) or text (CLOB) data. SAP HANA supports LOBs natively; CAP uses raw `db.run()` to read them (locators expire on SELECT).',
    category: 'database',
    unitId: 'unit-3-hana', lessonIdx: 2,
    distractors: ['Linked Object Buffer', 'Local Object Buffer'],
    kasimirRight: 'LOB — big data in a small column. Don\'t mix it with a CDS QL query! Correct! 📦',
    kasimirWrong: 'LOB = Large Object (BLOB/CLOB) — in HANA, never SELECT a LOB alongside metadata in one CDS QL query.',
  },

  // ─── Unit 4: Security & Ops ───────────────────────────────────────────────────
  {
    tla: 'XSUAA', expansion: 'Extended Services for User Account and Authorization',
    blurb: 'SAP BTP\'s OAuth 2.0 authorization service (also called "Authorization and Trust Management Service"). Manages roles, scopes, and JWT tokens for CAP apps.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 0,
    distractors: ['External Single-Use Authentication API', 'eXtended Security User Application API'],
    kasimirRight: 'XSUAA — the gatekeeper with too many letters! You cracked it. 🔑',
    kasimirWrong: 'XSUAA = Extended Services for User Account and Authorization. Every CAP prod app uses it.',
  },
  {
    tla: 'UAA', expansion: 'User Account and Authentication',
    blurb: 'Cloud Foundry\'s open-source OAuth 2.0 / OpenID Connect server. SAP\'s XSUAA is a proprietary extension of UAA, adding BTP-specific scopes and role collections.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 0,
    distractors: ['Universal Access Authority', 'Unified App Authenticator'],
    kasimirRight: 'UAA — the open-source core under XSUAA! Cloud Foundry heritage. Well done. 🦊',
    kasimirWrong: 'UAA = User Account and Authentication — the CF OAuth server that XSUAA is built on top of.',
  },
  {
    tla: 'SSO', expansion: 'Single Sign-On',
    blurb: 'Log in once, access everything. SAP IAS federates identity to BTP, SAP S/4HANA, and third-party apps so users don\'t need separate passwords per system.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 0,
    distractors: ['Secure Session Object', 'Synchronised Sign-Out'],
    kasimirRight: 'SSO — one password to rule them all! You didn\'t even need to log in twice. 🔓',
    kasimirWrong: 'SSO = Single Sign-On. Sign in once, use everything — Kasimir only has to remember one paw-print.',
  },
  {
    tla: 'JWT', expansion: 'JSON Web Token',
    blurb: 'A compact, URL-safe token format (RFC 7519) for conveying claims between parties. BTP uses JWTs to carry XSUAA scopes and user info between services.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 0,
    distractors: ['JavaScript Web Transfer', 'JSON Workflow Trigger'],
    kasimirRight: 'JWT — the travel passport of the cloud! Header.Payload.Signature, correct! 🛂',
    kasimirWrong: 'JWT = JSON Web Token (RFC 7519). Three base64-encoded parts: header.payload.signature.',
  },
  // Lesson 4-2
  {
    tla: 'IDP', expansion: 'Identity Provider',
    blurb: 'A system that authenticates users and issues identity tokens. SAP IAS is a BTP Identity Provider. Corporate IdPs (Azure AD, Okta) can be federated into IAS.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 1,
    distractors: ['Internal Data Processor', 'Interface Definition Protocol'],
    kasimirRight: 'IDP — the trust anchor of the auth chain. You clearly trust your acronym knowledge! 🏛️',
    kasimirWrong: 'IDP = Identity Provider — the system that says "yes, that IS Kasimir" during login.',
  },
  {
    tla: 'MFA', expansion: 'Multi-Factor Authentication',
    blurb: 'Requiring ≥2 verification methods (password + OTP, biometric, hardware key). SAP IAS supports MFA for BTP admin and application users.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 1,
    distractors: ['Managed Federation Access', 'Modular Flow Authentication'],
    kasimirRight: 'MFA — two factors better than one! Twice as secure, half as convenient. Correct! 🔐',
    kasimirWrong: 'MFA = Multi-Factor Authentication. Password + something else — a password alone is so last century.',
  },
  {
    tla: 'TLS', expansion: 'Transport Layer Security',
    blurb: 'The cryptographic protocol that secures HTTPS connections (successor to SSL). All BTP endpoints use TLS; CAP enforces it in production profiles automatically.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 1,
    distractors: ['Token Lifecycle Service', 'Trusted Link System'],
    kasimirRight: 'TLS — the invisible shield on every HTTPS call. Lock-tight answer! 🔒',
    kasimirWrong: 'TLS = Transport Layer Security — the "S" in HTTPS. SSL is the deprecated predecessor.',
  },
  {
    tla: 'ACL', expansion: 'Access Control List',
    blurb: 'A list specifying which users or roles can perform which operations on a resource. In CAP, `@restrict` annotations compile to XSUAA role-scope checks, implementing ACL logic.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 1,
    distractors: ['Application Component Layer', 'Async Callback Loop'],
    kasimirRight: 'ACL — the velvet rope of data security! Access granted to correct answers. 🚦',
    kasimirWrong: 'ACL = Access Control List. In CAP terms, it\'s what `@restrict` annotations enforce via XSUAA scopes.',
  },
  // Lesson 4-3
  {
    tla: 'ERP', expansion: 'Enterprise Resource Planning',
    blurb: 'Software that integrates core business processes (finance, HR, supply chain). SAP S/4HANA is the flagship ERP; it\'s why CAP and BTP exist — to extend and integrate ERP.',
    category: 'business',
    unitId: 'unit-4-security', lessonIdx: 2,
    distractors: ['Enterprise Reporting Platform', 'Event-Routing Protocol'],
    kasimirRight: 'ERP — the reason SAP exists and why your paycheck clears. Exactly right! 💼',
    kasimirWrong: 'ERP = Enterprise Resource Planning — the big system that runs the business. S/4HANA is SAP\'s ERP.',
  },
  {
    tla: 'GRC', expansion: 'Governance, Risk, and Compliance',
    blurb: 'A framework (and SAP product family) for managing audit, risk, and regulatory requirements. SAP GRC integrates with S/4HANA to automate access controls and policy enforcement.',
    category: 'business',
    unitId: 'unit-4-security', lessonIdx: 2,
    distractors: ['General Runtime Control', 'Global Resource Catalog'],
    kasimirRight: 'GRC — keeping the auditors happy since forever. Correctly compliant answer! 📋',
    kasimirWrong: 'GRC = Governance, Risk, and Compliance. A whole SAP product family dedicated to keeping regulators at bay.',
  },
  {
    tla: 'AMS', expansion: 'SAP Authorization Management Service',
    blurb: 'A BTP service (`@cap-js/ams`) providing policy-based authorization for CAP applications via the `@ams` CDS annotation. An alternative to pure XSUAA role checks.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 2,
    distractors: ['Application Monitoring Service', 'API Management Suite'],
    kasimirRight: 'AMS — policy-based, fine-grained, and very grown-up authorization. Nailed it! 🏆',
    kasimirWrong: 'AMS = SAP Authorization Management Service — the `@cap-js/ams` plugin for fine-grained policy authorization.',
  },
  {
    tla: 'RBAC', expansion: 'Role-Based Access Control',
    blurb: 'Assigning permissions to roles, then roles to users — rather than granting permissions directly. XSUAA role collections implement RBAC for BTP apps.',
    category: 'security',
    unitId: 'unit-4-security', lessonIdx: 2,
    distractors: ['Resource-Bound API Control', 'Runtime Backend Access Cache'],
    kasimirRight: 'RBAC — roles for the role, access for the few. Permission granted! 🎖️',
    kasimirWrong: 'RBAC = Role-Based Access Control. XSUAA role collections ARE the RBAC mechanism in BTP.',
  },

  // ─── Unit 5: SAP & AI ─────────────────────────────────────────────────────────
  {
    tla: 'AI', expansion: 'Artificial Intelligence',
    blurb: 'The broad field of building systems that perform tasks normally requiring human intelligence — reasoning, perception, language. SAP\'s "Business AI" strategy embeds it across the whole product suite.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 0,
    distractors: ['Automated Inference', 'Augmented Interaction'],
    kasimirRight: 'AI — teaching machines to think, and cats to nap ever more strategically. Correct! 🤖',
    kasimirWrong: 'AI = Artificial Intelligence. The umbrella term for machines that mimic human reasoning.',
  },
  {
    tla: 'ML', expansion: 'Machine Learning',
    blurb: 'A subset of AI where models learn patterns from data instead of being explicitly programmed. Powers SAP recommendations, forecasting, and the ValueList suggestions in this very project.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 0,
    distractors: ['Model Logic', 'Managed Learning'],
    kasimirRight: 'ML — where machines learn from data rather than hard-coded rules. Well trained! 🎯',
    kasimirWrong: 'ML = Machine Learning — the subset of AI where models learn patterns from data.',
  },
  {
    tla: 'LLM', expansion: 'Large Language Model',
    blurb: 'A neural network trained on vast amounts of text to predict and generate language. The engine behind modern chat assistants — including the one narrating these lessons.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 0,
    distractors: ['Linked Learning Module', 'Layered Logic Machine'],
    kasimirRight: 'LLM — the giant text-predicting brains behind modern chatbots. Purrfect! 🧠',
    kasimirWrong: 'LLM = Large Language Model — the huge neural nets trained on text to generate language.',
  },
  {
    tla: 'RAG', expansion: 'Retrieval-Augmented Generation',
    blurb: 'A pattern that grounds an LLM by first retrieving relevant documents, then having the model answer from them. Reduces hallucination — this project uses it for tutorial Q&A.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 0,
    distractors: ['Rapid Application Generator', 'Response Aggregation Gateway'],
    kasimirRight: 'RAG — grounding an LLM in real documents so it stops making things up. Sharp! 📚',
    kasimirWrong: 'RAG = Retrieval-Augmented Generation — fetch relevant docs, then let the LLM answer from them.',
  },
  // Lesson 5-2
  {
    tla: 'BAIP', expansion: 'SAP Business AI Platform',
    blurb: 'SAP\'s platform for building, deploying, and governing AI across business processes — bringing generative and predictive AI to BTP apps with enterprise data grounding.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 1,
    distractors: ['Business Application Integration Platform', 'BTP Analytics & Insights Portal'],
    kasimirRight: 'BAIP — SAP\'s platform for embedding AI across business processes. Right on! 🚀',
    kasimirWrong: 'BAIP = SAP Business AI Platform — SAP\'s platform for building and running business AI.',
  },
  {
    tla: 'NLP', expansion: 'Natural Language Processing',
    blurb: 'The AI discipline for understanding and generating human language — tokenisation, parsing, sentiment, translation. The foundation under every chatbot and search box.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 1,
    distractors: ['Neural Learning Pipeline', 'Native Language Parser'],
    kasimirRight: 'NLP — teaching computers to read and write human language. Eloquent answer! 💬',
    kasimirWrong: 'NLP = Natural Language Processing — the AI field for understanding and generating human language.',
  },
  {
    tla: 'ISLM', expansion: 'Intelligent Scenario Lifecycle Management',
    blurb: 'SAP\'s framework for managing embedded machine-learning scenarios end to end — training, deploying, and monitoring predictive models inside S/4HANA and BTP apps.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 1,
    distractors: ['Integrated Service Layer Model', 'Intelligent System Learning Module'],
    kasimirRight: 'ISLM — SAP\'s framework for managing embedded AI scenarios end to end. Impressive! 🔄',
    kasimirWrong: 'ISLM = Intelligent Scenario Lifecycle Management — SAP\'s way to operate embedded ML scenarios.',
  },
  {
    tla: 'MCP', expansion: 'Model Context Protocol',
    blurb: 'An open standard for connecting AI assistants to external tools and data sources through a uniform interface. SAP tooling (like the cds-mcp and sap-devs MCP servers) speaks it.',
    category: 'ai',
    unitId: 'unit-5-ai', lessonIdx: 1,
    distractors: ['Managed Cloud Platform', 'Multi-Channel Processing'],
    kasimirRight: 'MCP — the open standard wiring AI models to tools and data. Very current! 🔌',
    kasimirWrong: 'MCP = Model Context Protocol — the open standard connecting AI assistants to tools and data.',
  },
];

/** Unit metadata (title, icon, order). */
interface UnitMeta { id: string; title: string; icon: string; order: number; lessonTitles: string[]; lessonIntros: string[]; }

const UNITS: UnitMeta[] = [
  {
    id: 'unit-1-platform',
    title: 'SAP Core Platform',
    icon: '🏗️',
    order: 1,
    lessonTitles: ['Who\'s SAP, and what\'s BTP?', 'The CAP Stack', 'Deploying & Operating'],
    lessonIntros: [
      'Ah, a fresh student! Before we write a single line of CDS, let\'s settle the most fundamental questions: who runs this show, and what platform are we on?',
      'Now we\'re cooking! CAP is where the magic happens. Let me introduce you to my favourite framework — and no, I\'m not biased just because it\'s named after something a professor wears.',
      'Congratulations — you\'ve built a CAP app! Now how do you actually ship it? MTA archives, alert services, analytics clouds — the operational layer awaits.',
    ],
  },
  {
    id: 'unit-2-cds',
    title: 'CDS & App Development',
    icon: '🛠️',
    order: 2,
    lessonTitles: ['The CDS Language Family', 'Protocols & Standards', 'Tools of the Trade'],
    lessonIntros: [
      'CDS is not one thing — it\'s a whole language family. CSN, CDL, CQL… I collect acronyms the way others collect stamps. Let\'s unpack them.',
      'Every API speaks a language. OData, REST, RAP — the protocols that let your app talk to the world. Put on your headphones; it\'s time for a multilingual lesson.',
      'A developer without tools is just someone staring at a blank screen. FLP, UI5, OPA, CLI — the toolkit that turns ideas into shipped features.',
    ],
  },
  {
    id: 'unit-3-hana',
    title: 'HANA & Data',
    icon: '🗄️',
    order: 3,
    lessonTitles: ['The HANA Universe', 'Integration & Migration', 'Data Engineering Basics'],
    lessonIntros: [
      'SAP HANA — high-performance, in-memory, and living in its own acronym universe. HDI, SDA, SDI… even I need a map sometimes.',
      'Data doesn\'t just sit still. CPI, DWC, SQL, ODP — the connectors and extractors that keep data flowing where it needs to go.',
      'Time to get into the weeds: ETL pipelines, HDB artefacts, DDL, and the dreaded LOB column. Grab a coffee — or a warm saucer of milk.',
    ],
  },
  {
    id: 'unit-4-security',
    title: 'Security & Ops',
    icon: '🔒',
    order: 4,
    lessonTitles: ['Authentication & Tokens', 'Identity & Factors', 'Business & Governance'],
    lessonIntros: [
      'Security is not optional, and neither is this lesson. XSUAA, UAA, SSO, JWT — the alphabet soup that keeps your data from becoming everyone\'s data.',
      'Logging in is just the start. IDP, MFA, TLS, ACL — the layers that stop the wrong people from doing the wrong things.',
      'The business side of security: ERP context, GRC compliance, AMS policies, and the RBAC model that ties it all together.',
    ],
  },
  {
    id: 'unit-5-ai',
    title: 'SAP & AI',
    icon: '🤖',
    order: 5,
    lessonTitles: ['AI Foundations', 'SAP\'s AI Stack'],
    lessonIntros: [
      'Everyone\'s talking about AI, but half of them can\'t spell the acronyms. Let\'s fix that. AI, ML, LLM, RAG — the vocabulary you need before we get to the SAP-flavoured parts.',
      'Now the SAP twist. BAIP, NLP, ISLM, MCP — how SAP wraps all that clever maths into a governed, enterprise-ready platform. Even a cat can sound like a solution architect after this.',
    ],
  },
];

const LESSON_ID_START = 90001;

function assemble(): KttData {
  let legacyId = LESSON_ID_START;

  const units: KttUnit[] = UNITS.map((uMeta) => {
    const unitSeed = SEED.filter(s => s.unitId === uMeta.id);
    // Group by lessonIdx
    const maxLessonIdx = Math.max(...unitSeed.map(s => s.lessonIdx));
    const lessons: KttLesson[] = [];

    for (let li = 0; li <= maxLessonIdx; li++) {
      const lSeed = unitSeed.filter(s => s.lessonIdx === li);
      if (lSeed.length === 0) continue;

      const lessonId = `${uMeta.id}-lesson-${li + 1}`;
      const thisLegacyId = legacyId++;

      const beats: KttBeat[] = [
        {
          type: 'story',
          kasimir: uMeta.lessonIntros[li] ?? `Welcome to lesson ${li + 1} of ${uMeta.title}!`,
          mood: 'teaching',
        },
        ...lSeed.map<KttBeat>(s => ({
          type: 'drill',
          kind: 'mc',
          tla: s.tla,
          prompt: `What does ${s.tla} stand for?`,
          answer: s.expansion,
          distractors: s.distractors,
          kasimirRight: s.kasimirRight,
          kasimirWrong: s.kasimirWrong,
        })),
        {
          type: 'story',
          kasimir: `Lesson complete! You've mastered ${lSeed.map(s => s.tla).join(', ')}. Kasimir approves. 🐱`,
          mood: 'celebrate',
        },
      ];

      lessons.push({
        id: lessonId,
        legacyId: thisLegacyId,
        title: uMeta.lessonTitles[li] ?? `Lesson ${li + 1}`,
        acronyms: lSeed.map(s => ({
          tla: s.tla,
          expansion: s.expansion,
          blurb: s.blurb,
          category: s.category,
        })),
        beats,
      });
    }

    return {
      id: uMeta.id,
      title: uMeta.title,
      icon: uMeta.icon,
      order: uMeta.order,
      lessons,
    };
  });

  return { units };
}

const data = assemble();
const errs = validateLessons(data);
if (errs.length) {
  console.error('KTT lesson validation failed:\n' + errs.join('\n'));
  process.exit(1);
}
writeFileSync('hugo/data/ktt_lessons.json', JSON.stringify(data, null, 2) + '\n');

// ---------------------------------------------------------------------------
// CAP seed CSV for the KttLessons catalog (db/data/…-KttLessons.csv).
//
// Loaded automatically into HANA (and the in-memory SQLite used by cds.test)
// so srv/lib/user-progress.js can join a KTT_LESSON completion's legacyId →
// title/slug in MyCompletions, and syncProgress can reconstruct mastery.
// Without this seed the table ships EMPTY and every KTT completion is dropped.
//
// `slug` intentionally equals the lesson `id` (e.g. "unit-1-platform-lesson-1")
// because that is the exact key the island stores in `progress.mastered` and
// sends as `lessonSlug` — see hugo-apps/src/ktt/App.vue.
//
// `ID` is DETERMINISTIC (derived from legacyId, never random) so regenerating
// this file is byte-identical — no churn in git. Scheme: a fixed structured
// UUID template with the legacyId zero-padded into the final node segment.
// ---------------------------------------------------------------------------
const CSV_DELIM = ';';

/** RFC-4180-style field escaping against the ';' delimiter. */
function csvField(value: string): string {
  const s = String(value ?? '');
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Deterministic, valid v4-shaped UUID derived solely from the legacyId. */
function deterministicLessonId(legacyId: number): string {
  return `9077e000-0000-4000-8000-${String(legacyId).padStart(12, '0')}`;
}

const csvLines: string[] = ['ID;legacyId;slug;unitId;title'];
for (const unit of data.units) {
  for (const lesson of unit.lessons) {
    csvLines.push([
      csvField(deterministicLessonId(lesson.legacyId)),
      csvField(String(lesson.legacyId)),
      csvField(lesson.id),
      csvField(unit.id),
      csvField(lesson.title),
    ].join(CSV_DELIM));
  }
}
writeFileSync('db/data/com.sap.developers.ims-KttLessons.csv', csvLines.join('\n') + '\n');

const totalLessons = data.units.reduce((a, u) => a + u.lessons.length, 0);
const totalAcronyms = data.units.reduce((a, u) => a + u.lessons.reduce((b, l) => b + l.acronyms.length, 0), 0);
console.log(`Wrote ${data.units.length} units, ${totalLessons} lessons, ${totalAcronyms} acronyms.`);
console.log(`Wrote db/data/com.sap.developers.ims-KttLessons.csv (${csvLines.length - 1} data rows).`);
