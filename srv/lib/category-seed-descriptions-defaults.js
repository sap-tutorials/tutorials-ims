// srv/lib/category-seed-descriptions-defaults.js
//
// Single source of truth for the baseline Category.seedDescription texts.
//
// These paragraphs are what the category classifier EMBEDS and cosine-compares
// against each tutorial/mission/group's (title + description + primaryTag). They
// are intentionally keyword-rich and product-named so the embedding path
// (srv/lib/category-classifier.js) can classify without falling back to the LLM.
//
// The Categories reference rows themselves come from
// db/data/com.sap.developers.ims-Categories.csv (ID/slug/label/sortOrder only —
// no seedDescription column, so seeds are NOT shipped via CSV; that would
// full-replace the admin-editable column on every deploy). Instead these are
// seeded idempotently + non-destructively at boot by
// ./seed-category-descriptions.js, which fills ONLY rows whose seedDescription
// is empty — admin edits made at /admin-ui/ are preserved.
//
// Keyed by Categories.slug (stable) so a re-ordered/re-IDed CSV can't misalign.

export const CATEGORY_SEED_DESCRIPTIONS = {
  'app-dev-automation':
    'Building business applications and extensions with the SAP Cloud Application ' +
    'Programming Model (CAP), SAP Build and SAP Build Process Automation, low-code and ' +
    'pro-code development, workflow and business process automation, the ABAP RESTful ' +
    'Application Programming Model (RAP), side-by-side extensions, SAP Business Application ' +
    'Studio, and developer tooling for creating, deploying, and automating apps and services.',

  'data-analytics':
    'Working with data using SAP HANA Cloud, SAP Datasphere, and SAP Analytics Cloud: data ' +
    'modeling, SQL and calculation views, data federation and replication, business ' +
    'intelligence, reporting, dashboards, stories, data warehousing, and analytical models.',

  'extended-planning':
    'Financial and operational planning, budgeting, forecasting, and analysis with SAP ' +
    'Analytics Cloud planning, SAP Datasphere, and extended planning and analysis (xP&A): ' +
    'predictive planning, allocations, value driver trees, and enterprise performance management.',

  'integration':
    'Connecting systems and services with SAP Integration Suite: Cloud Integration, API ' +
    'Management, Open Connectors, event-driven integration with SAP Event Mesh and Advanced ' +
    'Event Mesh, EDI and B2B, destinations, connectivity, and integrating SAP with ' +
    'third-party applications.',

  'artificial-intelligence':
    'Building intelligent applications with SAP AI Core, the Generative AI Hub, SAP Business ' +
    'AI, and Joule: machine learning, large language models, embeddings and ' +
    'retrieval-augmented generation (RAG), document information extraction, orchestration, ' +
    'and AI-powered automation and copilots.',

  'frontend-ux':
    'Creating user interfaces and experiences with SAPUI5, SAP Fiori and Fiori Elements, UI5 ' +
    'Web Components, SAP Build Apps, HTML, CSS and JavaScript, React and Vue front ends, ' +
    'responsive design, theming, and building engaging developer and end-user experiences.',

  'cloud-operations':
    'Operating and administering SAP BTP, the Cloud Foundry and Kyma runtimes: deployment ' +
    'with multitarget applications (MTA), CI/CD pipelines and DevOps, security and ' +
    'authentication with XSUAA, monitoring, logging and alerting, subaccounts, entitlements, ' +
    'and cloud lifecycle management.',

  'abap-core':
    'ABAP programming and ABAP Cloud development: clean core extensibility, SAP S/4HANA and ' +
    'on-premise systems, RAP and CDS views in ABAP, the ABAP Development Tools (ADT) in ' +
    'Eclipse, released (tier-1) APIs, and core ERP business logic and data models.',
};
