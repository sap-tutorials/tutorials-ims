import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// packages/mcp/mcp-developer-tools.js
import cds7 from "@sap/cds";

// packages/core/resolve-db-user.js
import cds2 from "@sap/cds";

// packages/core/legacy-id.js
import cds from "@sap/cds";

// packages/core/resolve-db-user.js
function resolveUserSapId(user) {
  if (!user || !user.id || user.id === "anonymous") return null;
  const t = user.authInfo?.token;
  if (t?.userId) return t.userId;
  if (t?.payload?.user_uuid) return t.payload.user_uuid;
  return user.id;
}
async function resolveDbUser(user, columns) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  const { Users } = cds2.entities("com.sap.developers.ims");
  let q = SELECT.one.from(Users).where({ sapId });
  if (columns && columns.length) q = q.columns(...columns);
  return await q;
}

// packages/mcp/tutorial-step-slicer.js
import cds4 from "@sap/cds";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import * as cheerio from "cheerio";

// packages/core/feature-flags/db-flags.js
import cds3 from "@sap/cds";

// packages/core/feature-flags/registry.js
var adminTile = (tile, hash, note) => ({ method: "admin-tile", tile, hash, note });
var imsConfigUpsert = (imsKey) => ({
  method: "db-upsert",
  text: `AdminService.setContentDeltaFlags action (busts cache), or UPSERT ImsConfig key '${imsKey}' = 'true'/'false'.`
});
var featureFlagUpsert = (registryKey, imsKey) => ({
  method: "db-upsert",
  text: `AdminService.setFeatureFlag(key:'${registryKey}', enabled) action (busts cache), or UPSERT ImsConfig key '${imsKey}' = 'true'/'false'.`
});
var FEATURE_FLAGS = [
  // ---- Knowledge Graph env flags (env-layered via resolveKnowledgeGraphSettings where applicable) ----
  {
    key: "KNOWLEDGE_GRAPH_ENABLED",
    label: "Knowledge Graph master switch",
    category: "Knowledge Graph",
    kind: "db-setting",
    entity: "KnowledgeGraphSettings",
    column: "enabled",
    resolver: "kg",
    envVar: "KNOWLEDGE_GRAPH_ENABLED",
    valueType: "boolean",
    default: false,
    issue: "",
    status: "ga",
    description: "Master switch for the /graph/* service surface. Off \u2192 503.",
    howToChange: adminTile("knowledgeGraph", "#knowledgeGraph", "Or env KNOWLEDGE_GRAPH_ENABLED.")
  },
  {
    key: "KG_LEARNING_PATH_ENABLED",
    label: "KG learning-path reasoner",
    category: "Knowledge Graph",
    kind: "db-setting",
    entity: "KnowledgeGraphSettings",
    column: "learningPathEnabled",
    resolver: "kg",
    valueType: "boolean",
    default: false,
    issue: "kg-learning-path",
    status: "dev-only",
    description: 'Ordered/personalized "what should I learn next / prerequisite chain" reasoner exposed via learningPath(). DB-driven config (KnowledgeGraphSettings.learningPathEnabled); no env var. DEV-only, default OFF, fail-open.',
    howToChange: adminTile("knowledgeGraph", "#knowledgeGraph", "Toggle learning-path reasoner in the Knowledge Graph settings tile")
  },
  {
    key: "KG_CONCEPT_DEFINITIONS_ENABLED",
    label: "KG concept-definition generator",
    category: "Knowledge Graph",
    kind: "db-setting",
    entity: "KnowledgeGraphSettings",
    column: "conceptDefinitionsEnabled",
    resolver: "kg",
    valueType: "boolean",
    default: false,
    issue: "#2426",
    status: "dev-only",
    description: "LLM-authored, grounded concept definitions (#2426). Gates the generate-concept-definitions scheduled job. DB-driven config (KnowledgeGraphSettings.conceptDefinitionsEnabled); no env var. DEV-only, default OFF, fail-open.",
    howToChange: adminTile("knowledgeGraph", "#knowledgeGraph", "Toggle the concept-definition generator in the Knowledge Graph settings tile")
  },
  {
    key: "KG_ONDEMAND_ENABLED",
    label: "KG on-demand extraction",
    category: "Knowledge Graph",
    kind: "db-setting",
    entity: "KnowledgeGraphSettings",
    column: "onDemandExtractionEnabled",
    resolver: "kg",
    envVar: "KG_ONDEMAND_ENABLED",
    valueType: "boolean",
    default: false,
    issue: "#948",
    status: "ga",
    description: "On-demand concept extraction from zero-seed search queries.",
    howToChange: adminTile("knowledgeGraph", "#knowledgeGraph", "Or env KG_ONDEMAND_ENABLED.")
  },
  {
    key: "KG_PAGERANK_ENABLED",
    label: "KG PageRank blend",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.pagerank",
    valueType: "boolean",
    default: false,
    issue: "#916",
    status: "ga",
    description: "Blends per-tutorial PageRank into KG neighborhood ranking. DB-driven config (ImsConfig key flag.kg.pagerank); no env var. Default OFF.",
    howToChange: featureFlagUpsert("KG_PAGERANK_ENABLED", "flag.kg.pagerank")
  },
  {
    key: "KG_EXPLORE_3D_ENABLED",
    label: "Explore 3D graph view",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.explore3d",
    valueType: "boolean",
    default: false,
    issue: "#2517",
    status: "dev-only",
    description: "Opt-in 3D force-directed view on /explore/ (three.js). Desktop-only, lazy-loaded. DB-driven config (ImsConfig flag.kg.explore3d); DEV-first, default OFF, fail-open.",
    howToChange: featureFlagUpsert("KG_EXPLORE_3D_ENABLED", "flag.kg.explore3d")
  },
  {
    key: "KG_PATH_V2_ENABLED",
    label: "KG path-finding v2",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.pathV2",
    valueType: "boolean",
    default: false,
    issue: "#913",
    status: "beta",
    description: "Property-graph v2 pathBetween with fail-open v1 SPARQL fallback. DB-driven config (ImsConfig key flag.kg.pathV2); no env var. Default OFF.",
    howToChange: featureFlagUpsert("KG_PATH_V2_ENABLED", "flag.kg.pathV2")
  },
  {
    key: "communityRankWeight",
    label: "KG community search weight",
    category: "Knowledge Graph",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "communityRankWeight",
    resolver: "chat",
    envVar: "KG_COMMUNITY_WEIGHT",
    valueType: "number",
    default: 0,
    issue: "#1171",
    status: "dev-only",
    description: "Additive Louvain-community rank term in search (>0 enables). Requires searchKgRerankEnabled=true. Admin-editable; KG_COMMUNITY_WEIGHT env var is a fallback only.",
    howToChange: adminTile("joule", "#joule", "Or env KG_COMMUNITY_WEIGHT (fallback only, used when the column is unset).")
  },
  {
    key: "KG_WEIGHT",
    label: "KG concept-overlap search weight",
    category: "Knowledge Graph",
    kind: "constant",
    valueType: "number",
    default: 2,
    issue: "#945",
    status: "ga",
    description: "Hardcoded concept-overlap rank multiplier. Not runtime-configurable."
  },
  // ---- Security / abuse protection ----
  {
    key: "RATE_LIMIT_ENABLED",
    label: "Origin rate limiting",
    category: "Security",
    kind: "db",
    imsConfigKey: "flag.ratelimit",
    valueType: "boolean",
    default: false,
    issue: "origin-abuse-protection",
    status: "dev-only",
    description: "Cross-instance (cds-caching backed) rate limiter on the anon/expensive surface (/content, /build, /graph, /mcp*, \u2026). Layered tiers: anon IP floor, higher tier for an already-present PAT/XSUAA token, top tier for HMAC-signed first-party agents. DB-driven config (ImsConfig key flag.ratelimit); thresholds in ImsConfig ratelimit.* via rate-limit-settings.js. No env var. Default OFF, fail-open.",
    howToChange: featureFlagUpsert("RATE_LIMIT_ENABLED", "flag.ratelimit")
  },
  {
    key: "INPUT_VALIDATION_ENABLED",
    label: "Origin input validation",
    category: "Security",
    kind: "db",
    imsConfigKey: "flag.inputvalidation",
    valueType: "boolean",
    default: false,
    issue: "origin-abuse-protection",
    status: "dev-only",
    description: "WAF-equivalent input validation on the anon/agentic write surface (PR3). Body-size caps + JSON depth/shape limits on anon POST bodies before handlers run, and a depth + complexity limit (plus prod-only introspection block) on GraphQL /graphql/public. DB-driven config (ImsConfig key flag.inputvalidation); thresholds in ImsConfig inputvalidation.* via input-validation-settings.js. No env var. Default OFF, fail-open.",
    howToChange: featureFlagUpsert("INPUT_VALIDATION_ENABLED", "flag.inputvalidation")
  },
  {
    key: "LOADSHED_ENABLED",
    label: "Origin load-shedding",
    category: "Security",
    kind: "db",
    imsConfigKey: "flag.loadshed",
    valueType: "boolean",
    default: false,
    issue: "origin-abuse-protection",
    status: "dev-only",
    description: "In-flight concurrency guard on the anonymous HANA content-serve path (content-store.js serveStoredSlug \u2014 tutorial HTML + content pages + author/advocate pages). When concurrent per-request gzip-BLOB reads exceed loadshed.maxConcurrent, excess requests are shed with 503 + Retry-After instead of piling up toward OOM under a scraper flood that gets past the edge cache (the serve path has no static fallback). Cache hits are never counted. Per-instance ceiling (in-memory, not cross-instance). DB-driven config (ImsConfig key flag.loadshed); ceiling + Retry-After in ImsConfig loadshed.maxConcurrent / loadshed.retryAfterSeconds via load-shed-settings.js. No env var. Default OFF, fail-open (a guard fault admits).",
    howToChange: featureFlagUpsert("LOADSHED_ENABLED", "flag.loadshed")
  },
  // ---- Navigator ----
  {
    key: "NAV_INCLUDE_NESTED_GROUPS",
    label: "Navigator nested-group cards",
    category: "Navigator",
    kind: "db-setting",
    entity: "NavigatorSettings",
    column: "includeNestedGroups",
    resolver: "navigator",
    envVar: "NAV_INCLUDE_NESTED_GROUPS",
    valueType: "boolean",
    default: false,
    issue: "#364",
    status: "ga",
    description: "When on, /build/navigator emits cards for nested groups (~65 extra cards on dev).",
    howToChange: adminTile("navigator", "#navigator", "Or env NAV_INCLUDE_NESTED_GROUPS.")
  },
  // ---- UI events ----
  {
    key: "UI_EVENTS_ENABLED",
    label: "UI event telemetry",
    category: "Telemetry",
    kind: "db-setting",
    entity: "UiEventsSettings",
    column: "enabled",
    resolver: "uiEvents",
    envVar: "UI_EVENTS_ENABLED",
    valueType: "boolean",
    default: false,
    issue: "#204",
    status: "ga",
    description: "UI event tracking. Off \u2192 /api/ui-event 503, tracker self-disables.",
    howToChange: adminTile("uiEvents", "#uiEvents", "Or env UI_EVENTS_ENABLED.")
  },
  // ---- Chat / AI booleans (direct ChatSettings row; NO env layer) ----
  {
    key: "ChatSettings.enabled",
    label: "Joule chat master switch",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "enabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "",
    status: "ga",
    description: "Master switch for the Joule chat assistant.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.ragEnabled",
    label: "RAG / vector grounding",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "ragEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "",
    status: "ga",
    description: "Retrieval-augmented grounding over tutorial embeddings.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.semanticSearchEnabled",
    label: "Public semantic search",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "semanticSearchEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#2246",
    status: "dev-only",
    description: "Anonymous public semantic/vector search: SearchService.semantic_search function + /mcp/search MCP tool. Server embeds the query and returns scored content references (tutorials/concepts/external) \u2014 never vectors. Off \u2192 503. Default OFF until corpora are backfilled and the anon surface is vetted.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.codeCheckEnabled",
    label: "AI code-check",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "codeCheckEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#171",
    status: "ga",
    description: "AI code-check tool. Off \u2192 /api/codecheck 503.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.validateAnswerEnabled",
    label: "AI answer grader",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "validateAnswerEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#209",
    status: "ga",
    description: "AI free-text answer grader. Off \u2192 /api/validate-answer 503.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.branchingEnabled",
    label: "Branching learning paths",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "branchingEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#172",
    status: "ga",
    description: "Branching paths master flag. Off \u2192 /api/branches/decide 404.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.kgPathBetweenEnabled",
    label: "KG learning-path tool",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "kgPathBetweenEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#445",
    status: "ga",
    description: "findLearningPath Joule tool registration.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.communityPeersEnabled",
    label: "KG community-peers tool",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "communityPeersEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "#1126",
    status: "dev-only",
    description: "findCommunityPeers Joule tool. Ships dark until PROD Louvain data verified.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.puzzleHintEnabled",
    label: "Puzzle hint Joule tool",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "puzzleHintEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "puzzleHint Joule tool registration. Returns safe hint material without revealing the answer.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.kgSearchExpansionEnabled",
    label: "KG search expansion",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "kgSearchExpansionEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: true,
    issue: "#943",
    status: "ga",
    description: "expandSearchConcepts Joule tool. Default ON (cheap).",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.searchKgRerankEnabled",
    label: "KG-boosted search ranking",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "searchKgRerankEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: true,
    issue: "#945",
    status: "ga",
    description: "Server-side KG rerank of search results. Default ON. Gates KG_COMMUNITY_WEIGHT.",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.kgRelatedContentEnabled",
    label: "KG related-content tool",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "kgRelatedContentEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: true,
    issue: "#1125",
    status: "ga",
    description: "findRelatedContent Joule tool. Default ON (cache-reused).",
    howToChange: adminTile("joule", "#joule")
  },
  {
    key: "ChatSettings.whatsNewEnabled",
    label: "What's New Joule tool",
    category: "Chat / AI",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "whatsNewEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: true,
    issue: "#1859",
    status: "ga",
    description: "getWhatsNew Joule tool + learner-path What's New guidance (chat-context.js). Default ON.",
    howToChange: adminTile("joule", "#joule")
  },
  // ---- A2A (Agent-to-Agent) ----
  {
    key: "ChatSettings.a2aEnabled",
    label: "A2A agent endpoint",
    category: "A2A",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "a2aEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: true,
    issue: "#1220",
    status: "dev-only",
    description: "Exposes the A2A JSON-RPC endpoint (POST /a2a) and the agent card (GET /.well-known/agent-card.json). Kill switch \u2014 set false to signal the endpoint is disabled in the agent card.",
    howToChange: adminTile("joule", "#joule", "Managed via ChatSettings.a2aEnabled DB column.")
  },
  // ---- Observability ----
  {
    key: "ChatSettings.alertsEnabled",
    label: "ANS push alerting",
    category: "Observability",
    kind: "db-setting",
    entity: "ChatSettings",
    column: "alertsEnabled",
    resolver: "chat",
    valueType: "boolean",
    default: false,
    issue: "",
    status: "ga",
    description: "Master switch for SAP Alert Notification push alerts (publish-reject, scheduled-job failures, rebuild-dispatch failures). DB-backed, admin-editable; no env var. Enable after deploying the MTA and binding the email action.",
    howToChange: adminTile("joule", "#joule", "Managed via ChatSettings.alertsEnabled DB column.")
  },
  {
    key: "METRICS_ENABLED",
    label: "Metrics collection",
    category: "Observability",
    kind: "db",
    imsConfigKey: "flag.metrics",
    valueType: "boolean",
    default: true,
    issue: "",
    status: "ga",
    description: "Prometheus-style metrics snapshots and DB wrap instrumentation. Kill switch \u2014 set false to disable all metric writes. DB-driven config (ImsConfig key flag.metrics); no env var. Default ON.",
    howToChange: featureFlagUpsert("METRICS_ENABLED", "flag.metrics")
  },
  // ---- MCP (Phase 2 / Phase 3) ----
  {
    key: "MCP_AUTH_ENABLED",
    label: "MCP OAuth auth tier",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.auth",
    valueType: "boolean",
    default: true,
    issue: "#1105",
    status: "ga",
    description: "Phase 2 MCP /mcp-auth and /mcp-pat routes. Kill switch \u2014 set false to return 503 on both routes. DB-driven config (ImsConfig key flag.mcp.auth); no env var. Default ON. NOTE: the boot-time route mount reads this on a cold cache and so honors the declared default (ON) at boot; the DB value gates the per-request paths and takes full effect after the warm-up / next restart.",
    howToChange: featureFlagUpsert("MCP_AUTH_ENABLED", "flag.mcp.auth")
  },
  {
    key: "MCP_PAT_MINT_ENABLED",
    label: "MCP PAT minting",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.patMint",
    valueType: "boolean",
    default: true,
    issue: "#1105",
    status: "ga",
    description: "Allows PAT tokens to be minted via the MCP auth tier. Kill switch \u2014 set false to disable minting (existing PATs still valid). DB-driven config (ImsConfig key flag.mcp.patMint); no env var. Default ON.",
    howToChange: featureFlagUpsert("MCP_PAT_MINT_ENABLED", "flag.mcp.patMint")
  },
  {
    key: "MCP_PHASE3_ENABLED",
    label: "MCP Phase-3 compose router",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.phase3",
    valueType: "boolean",
    default: true,
    issue: "#1106",
    status: "ga",
    description: "MCP Phase-3 compose router (resources + prompts + admin tools). Kill switch \u2014 set false to serve tools-only via plain @cap-js/mcp adapter. DB-driven config (ImsConfig key flag.mcp.phase3); no env var. Default ON. NOTE: the boot-time compose-router mount reads this on a cold cache and so honors the declared default (ON) at boot; the per-request /mcp-admin gate uses the warm DB value.",
    howToChange: featureFlagUpsert("MCP_PHASE3_ENABLED", "flag.mcp.phase3")
  },
  {
    key: "MCP_RESOURCES_ENABLED",
    label: "MCP resources",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.resources",
    valueType: "boolean",
    default: true,
    issue: "#1106",
    status: "ga",
    description: "MCP resource registration inside the Phase-3 compose router. Kill switch \u2014 set false to omit resources from the compose server. DB-driven config (ImsConfig key flag.mcp.resources); no env var. Default ON.",
    howToChange: featureFlagUpsert("MCP_RESOURCES_ENABLED", "flag.mcp.resources")
  },
  {
    key: "MCP_PROMPTS_ENABLED",
    label: "MCP prompts",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.prompts",
    valueType: "boolean",
    default: true,
    issue: "#1106",
    status: "ga",
    description: "MCP prompt registration inside the Phase-3 compose router. Kill switch \u2014 set false to omit prompts from the compose server. DB-driven config (ImsConfig key flag.mcp.prompts); no env var. Default ON.",
    howToChange: featureFlagUpsert("MCP_PROMPTS_ENABLED", "flag.mcp.prompts")
  },
  {
    key: "MCP_ADMIN_TOOLS_ENABLED",
    label: "MCP admin tools",
    category: "MCP",
    kind: "db",
    imsConfigKey: "flag.mcp.adminTools",
    valueType: "boolean",
    default: true,
    issue: "#1106",
    status: "ga",
    description: "MCP admin tool registration inside the Phase-3 compose router. Kill switch \u2014 set false to omit admin tools from the compose server. DB-driven config (ImsConfig key flag.mcp.adminTools); no env var. Default ON.",
    howToChange: featureFlagUpsert("MCP_ADMIN_TOOLS_ENABLED", "flag.mcp.adminTools")
  },
  // ---- Knowledge Graph kill switches ----
  {
    key: "KG_RETIRE_ORPHANS_ENABLED",
    label: "KG orphan concept retirement",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.retireOrphans",
    valueType: "boolean",
    default: true,
    issue: "#1115",
    status: "ga",
    description: "Nightly job that retires zero-link orphaned concepts (ACTIVE\u2192RETIRED). Kill switch \u2014 set false to skip retirement on each nightly run. DB-driven config (ImsConfig key flag.kg.retireOrphans); no env var. Default ON.",
    howToChange: featureFlagUpsert("KG_RETIRE_ORPHANS_ENABLED", "flag.kg.retireOrphans")
  },
  {
    key: "KG_STEP_SLICER_ENABLED",
    label: "KG tutorial step slicer",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.stepSlicer",
    valueType: "boolean",
    default: true,
    issue: "",
    status: "ga",
    description: "Per-step concept extraction slice during tutorial ingestion. Kill switch \u2014 set false to skip step-level slicing (whole-tutorial extraction still runs). DB-driven config (ImsConfig key flag.kg.stepSlicer); no env var. Default ON.",
    howToChange: featureFlagUpsert("KG_STEP_SLICER_ENABLED", "flag.kg.stepSlicer")
  },
  {
    key: "KG_DEVTOBERFEST_SESSIONS_ENABLED",
    label: "KG Devtoberfest session ingestion",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.devtoberfestSessions",
    valueType: "boolean",
    default: false,
    issue: "#2311",
    status: "dev-only",
    description: 'Twice-weekly job that ingests rich Devtoberfest Planner sessions (title/abstract/speaker/YouTube) from the cross-container facade into the Knowledge Graph as first-class DevtoberfestSession nodes (predicate "presents") and embeds them for the semantic-search external corpus. Requires the master KG switch (KNOWLEDGE_GRAPH_ENABLED) AND cross-container Leg B (ACTIVITY_SESSION_V1 / DTF_*_V1 synonym+grant) deployed \u2014 the facade query is empty/errors without it (fail-closed). DB-driven config (ImsConfig key flag.kg.devtoberfestSessions); no env var. Default OFF.',
    howToChange: featureFlagUpsert("KG_DEVTOBERFEST_SESSIONS_ENABLED", "flag.kg.devtoberfestSessions")
  },
  {
    key: "TECHED_DEVTOBERFEST_CROSSLINK_ENABLED",
    label: "TechEd \u2194 Devtoberfest session cross-links",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.teched.devtoberfestCrosslink",
    valueType: "boolean",
    default: false,
    issue: "#2312",
    status: "dev-only",
    description: "Bidirectional related-session cross-linking between Devtoberfest sessions and SAP TechEd sessions, computed from shared Knowledge-Graph concepts. Both are first-class KG nodes (#2311): Devtoberfest session \u2192 DevtoberfestSessionConceptLinks; TechEd session \u2192 TechEdSessionConceptLinks, over the SAME Concepts registry. When ON, the Devtoberfest schedule feed attaches relatedTechEdSessions (keyed by session ID) and /build/teched attaches relatedDevtoberfestSessions (top 3 by concept overlap). Fail-open: when either concept-link table is cold/empty (e.g. unit SQLite), the related arrays are empty and nothing throws. DB-driven config (ImsConfig key flag.teched.devtoberfestCrosslink); no env var. Default OFF.",
    howToChange: featureFlagUpsert("TECHED_DEVTOBERFEST_CROSSLINK_ENABLED", "flag.teched.devtoberfestCrosslink")
  },
  {
    key: "KG_TECHED_SESSIONS_ENABLED",
    label: "KG TechEd session ingestion",
    category: "Knowledge Graph",
    kind: "db",
    imsConfigKey: "flag.kg.techedSessions",
    valueType: "boolean",
    default: false,
    issue: "#2312",
    status: "dev-only",
    description: 'KG concept-link enrichment for the weekly SAP TechEd session ingest. When on (and the master KG switch KNOWLEDGE_GRAPH_ENABLED is on), the fetch-teched-sessions job embeds each new/changed session and LLM-extracts "covers" concept links into TechEdSessionConceptLinks. The fetch + upsert + delta core of the job ALWAYS runs regardless of this flag; only the LLM/embedding enrichment is gated. DB-driven config (ImsConfig key flag.kg.techedSessions); no env var. Default OFF. Fail-open.',
    howToChange: featureFlagUpsert("KG_TECHED_SESSIONS_ENABLED", "flag.kg.techedSessions")
  },
  // ---- Content ----
  {
    key: "COMMUNITY_BLOGS_CLASSIFIER_ENABLED",
    label: "Community blogs classifier",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.community.blogsClassifier",
    valueType: "boolean",
    default: true,
    issue: "#1033",
    status: "ga",
    description: "Scheduled AI classifier that drains PENDING CommunityBlogPosts rows via SAP Generative AI Hub. Kill switch \u2014 set false to skip all classification runs. DB-driven config (ImsConfig key flag.community.blogsClassifier); no env var. Default ON.",
    howToChange: featureFlagUpsert("COMMUNITY_BLOGS_CLASSIFIER_ENABLED", "flag.community.blogsClassifier")
  },
  {
    key: "HOMEPAGE_NEWS_RELEVANCE_ENABLED",
    label: "Homepage news relevance scoring",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.homepage.newsRelevance",
    valueType: "boolean",
    default: true,
    issue: "",
    status: "ga",
    description: "AI-based relevance scoring for homepage news items. Kill switch \u2014 set false to fall back to chronological ordering. DB-driven config (ImsConfig key flag.homepage.newsRelevance); no env var. Default ON.",
    howToChange: featureFlagUpsert("HOMEPAGE_NEWS_RELEVANCE_ENABLED", "flag.homepage.newsRelevance")
  },
  {
    key: "TECHED_HOMEPAGE_ENABLED",
    label: "Homepage TechEd sessions band",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.homepage.teched",
    valueType: "boolean",
    default: false,
    issue: "#2312",
    status: "dev-only",
    description: "When true, upcoming SAP TechEd 2026 sessions (from external.TechEdSessions) are surfaced as always-on cards in the homepage events band, each linking to its session URL (falling back to /teched/). Additive to the existing CodeJam/Devtoberfest band; region-agnostic like Devtoberfest. Fail-open: an empty catalog or a query error yields no cards (the band is unchanged). DB-driven config (ImsConfig key flag.homepage.teched); no env var. Default OFF.",
    howToChange: featureFlagUpsert("TECHED_HOMEPAGE_ENABLED", "flag.homepage.teched")
  },
  {
    key: "CONTENT_DELTA_WRITE_ENABLED",
    label: "Content Option-B dual-write",
    category: "Content",
    kind: "db",
    imsConfigKey: "content.delta.write",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "Workstream D Option B: on publish, mirror freshly-published slugs into ContentCurrent + ContentHistory alongside the legacy ContentFiles write. Fail-safe (never throws into the commit tx); legacy ContentFiles remains the source of truth until the read cutover. DB-driven config (ImsConfig key content.delta.write); no env var. Default OFF.",
    howToChange: imsConfigUpsert("content.delta.write")
  },
  {
    key: "CONTENT_DELTA_READ_ENABLED",
    label: "Content Option-B read from ContentCurrent",
    category: "Content",
    kind: "db",
    imsConfigKey: "content.delta.read",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "Workstream D Option B: serve + readers source from the mutable ContentCurrent (per-slug fallback to legacy ContentFiles). Enable after ContentCurrent is fully seeded. DB-driven config (ImsConfig key content.delta.read); no env var. Default OFF.",
    howToChange: imsConfigUpsert("content.delta.read")
  },
  {
    key: "CONTENT_DELTA_SKIP_CARRYFORWARD",
    label: "Content Option-B skip carry-forward (O(changed) publish)",
    category: "Content",
    kind: "db",
    imsConfigKey: "content.delta.skipCarryForward",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "Workstream D Option B: publish writes ONLY changed slugs (no carry-forward); rollback replays ContentHistory into ContentCurrent. Enable ONLY after the read cutover is live AND ContentCurrent is fully seeded. DB-driven config (ImsConfig key content.delta.skipCarryForward); no env var. Default OFF.",
    howToChange: imsConfigUpsert("content.delta.skipCarryForward")
  },
  {
    key: "FRESHNESS_SCAN_ENABLED",
    label: "Tutorial freshness bulk scan",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.freshness.scan",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "When true, the nightly freshness-scan job runs the detector across the tutorial catalog. DB-driven config (ImsConfig key flag.freshness.scan); no env var. Default OFF.",
    howToChange: featureFlagUpsert("FRESHNESS_SCAN_ENABLED", "flag.freshness.scan")
  },
  {
    key: "PROVENANCE_ENVELOPE_ENABLED",
    label: "Signed provenance & freshness envelope",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.provenance.envelope",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "When true, serves the signed provenance JWS at /content/tutorials/:slug/provenance, publishes the JWKS at /.well-known/tutorial-provenance/jwks.json, and emits advisory X-Freshness-Confidence / X-Content-Provenance headers. DB-driven config (ImsConfig key flag.provenance.envelope); no env var. Default OFF.",
    howToChange: featureFlagUpsert("PROVENANCE_ENVELOPE_ENABLED", "flag.provenance.envelope")
  },
  {
    key: "SKILL_BUNDLE_ENABLED",
    label: "Installable Skill bundle endpoint",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.skill.bundle",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "When true, serves an installable agent-Skill zip at /content/tutorials/:slug/skill (SKILL.md procedure + verify.sh generated from assert blocks + provenance/freshness stamp). Public, anonymous, read-only over PUBLISHED tutorials. DB-driven config (ImsConfig key flag.skill.bundle); no env var. Default OFF (#2245).",
    howToChange: featureFlagUpsert("SKILL_BUNDLE_ENABLED", "flag.skill.bundle")
  },
  // ---- Taxonomy ----
  {
    key: "SEMAPHORE_SYNC_ENABLED",
    label: "Semaphore taxonomy auto-sync",
    category: "Taxonomy",
    kind: "db",
    imsConfigKey: "flag.semaphore.sync",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "When true, the weekly semaphore-tag-sync job pulls the SAPCore model from the Semaphore SES allterms API and upserts Tags (keyed on semaphoreId). Fail-open: a fetch/mapping error records a FAILED run and never mutates tags. Pairs with ImsConfig keys semaphore.sync.{model,lang,filter,actualTagClasses,interestItemClasses,dryRun} and the semaphore-destination. DB-driven config (ImsConfig key flag.semaphore.sync); no env var. Default OFF (#2184).",
    howToChange: featureFlagUpsert("SEMAPHORE_SYNC_ENABLED", "flag.semaphore.sync")
  },
  // ---- Notifications ----
  {
    key: "FEEDBACK_EMAIL_ENABLED",
    label: "Owner feedback digest email",
    category: "Notifications",
    kind: "db",
    imsConfigKey: "feedback.email.enabled",
    valueType: "boolean",
    default: false,
    issue: "#2188",
    status: "ga",
    description: "When true, the daily feedback-owner-digest job emails each tutorial owner a summary of new commented feedback. Second gate: only fires when the CF space is prod, and requires the SMTP secrets in Credential Store \u2014 so this toggle is inert on dev/qa. Toggling takes effect within the job's 60s flag cache. DB-driven config (ImsConfig key feedback.email.enabled); no env var. Default OFF (#2188).",
    howToChange: featureFlagUpsert("FEEDBACK_EMAIL_ENABLED", "feedback.email.enabled")
  },
  // ---- KTT (Kasimir Teaches TLAs) ----
  {
    key: "KTT_ENABLED",
    label: "KTT \u2014 Kasimir Teaches TLAs",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.ktt.enabled",
    valueType: "boolean",
    default: false,
    status: "beta",
    description: "Enables the /explore/ktt/ acronym trainer and its /ktt CAP endpoints. Off \u2192 completeLesson/syncProgress reject 503.",
    howToChange: featureFlagUpsert("KTT_ENABLED", "flag.ktt.enabled")
  },
  // ---- Generative UI (research spike #2362) ----
  {
    key: "CHALLENGE_WIDGET_ENABLED",
    label: "AI challenge widget (json-render POC)",
    category: "Content",
    kind: "db",
    imsConfigKey: "flag.challengeWidget",
    valueType: "boolean",
    default: false,
    issue: "#2362",
    status: "dev-only",
    description: "Research spike (#2362): AI-authored json-render challenge panel per tutorial step. The model emits a constrained UI spec (srv/lib/ai-challenge-spec.js) rendered by a generic Vue catalog (hugo-apps/src/challenge-render). Anti-leak: reference answers are stripped from the public spec and returned separately for the ValidateAnswerSpecs sidecar. Because tutorial HTML is baked at build time, GENERATION is gated by the CHALLENGE_WIDGET_ENABLED build-time env var (scripts/fetch-tutorials.ts); this DB flag is the greenlight/kill record and admin control of record. Default OFF, DEV-only, fail-open.",
    howToChange: featureFlagUpsert("CHALLENGE_WIDGET_ENABLED", "flag.challengeWidget")
  },
  // ---- Edge cache ----
  {
    key: "EDGE_PURGE_ENABLED",
    label: "Akamai edge Fast-Purge on publish",
    category: "Security",
    kind: "db",
    imsConfigKey: "flag.edgepurge",
    valueType: "boolean",
    default: false,
    status: "dev-only",
    description: "When true, a successful content publish/rollback fires a fire-and-forget Akamai Fast-Purge (CCU v3) purge-by-tag for the changed slugs, AND the served content Cache-Control s-maxage is raised from 600s to 86400s (safe only because the purge now bounds staleness). Requires the AKAMAI_FASTPURGE_EDGERC JSON credential in Credential Store; inert (no-op, short TTL) without it. Fail-open. Numeric tunables: ImsConfig edgepurge.network (production|staging), edgepurge.timeoutMs. DB-driven config (ImsConfig key flag.edgepurge); no env var. Default OFF.",
    howToChange: featureFlagUpsert("EDGE_PURGE_ENABLED", "flag.edgepurge")
  }
];

// packages/core/feature-flags/db-flags.js
var LOG = cds3.log("feature-flags");
var NS = "com.sap.developers.ims";
var FLAG_TTL_MS = 60 * 1e3;
var EXCLUDED_IMS_KEYS = /* @__PURE__ */ new Set([
  "content.delta.write",
  "content.delta.read",
  "content.delta.skipCarryForward"
]);
var DB_FLAGS = /* @__PURE__ */ new Map();
for (const f of FEATURE_FLAGS) {
  if (f.kind === "db" && f.valueType === "boolean" && f.imsConfigKey && !EXCLUDED_IMS_KEYS.has(f.imsConfigKey)) {
    DB_FLAGS.set(f.key, { imsConfigKey: f.imsConfigKey, default: Boolean(f.default) });
  }
}
var ALL_IMS_KEYS = [...DB_FLAGS.values()].map((m) => m.imsConfigKey);
var STATE = globalThis.__imsFeatureFlagsState__ ??= {
  values: /* @__PURE__ */ Object.create(null),
  at: 0,
  refreshing: null
};
function isFresh() {
  return STATE.at !== 0 && Date.now() - STATE.at < FLAG_TTL_MS;
}
function scheduleRefresh() {
  if (STATE.refreshing) return;
  if (!cds3.model) return;
  STATE.refreshing = refreshFeatureFlags().catch(() => {
  }).finally(() => {
    STATE.refreshing = null;
  });
}
async function refreshFeatureFlags() {
  try {
    const db = await cds3.connect.to("db");
    const { ImsConfig } = cds3.entities(NS);
    const rows = await db.run(
      SELECT.from(ImsConfig).columns("key", "value").where({ key: { in: ALL_IMS_KEYS } })
    );
    const values = /* @__PURE__ */ Object.create(null);
    for (const r of rows || []) values[r.key] = String(r.value).toLowerCase() === "true";
    STATE.values = values;
    STATE.at = Date.now();
  } catch (err) {
    LOG.warn("feature flag refresh failed; keeping last-known values:", err.message);
    STATE.at = Date.now();
  }
  return { ...STATE.values };
}
function isFlagEnabled(registryKey) {
  const meta = DB_FLAGS.get(registryKey);
  if (!meta) {
    LOG.warn(`isFlagEnabled: unknown feature flag '${registryKey}' \u2014 returning false`);
    return false;
  }
  if (!isFresh()) scheduleRefresh();
  const v = STATE.values[meta.imsConfigKey];
  return v === void 0 ? meta.default : v === true;
}

// packages/core/metrics.js
var counters = /* @__PURE__ */ new Map();
var MAX_NAME_LEN = 64;
var lastWarnAt = 0;
function warn(msg) {
  const now = Date.now();
  if (now - lastWarnAt > 6e4) {
    lastWarnAt = now;
    console.warn(`[metrics] ${msg}`);
  }
}
function isDisabled() {
  return !isFlagEnabled("METRICS_ENABLED");
}
function counter(name, n = 1) {
  try {
    if (isDisabled()) return;
    if (typeof name !== "string" || !name) throw new Error(`invalid counter name: ${name}`);
    if (name.length > MAX_NAME_LEN) throw new Error(`metric name too long (${name.length} > ${MAX_NAME_LEN}): ${name}`);
    if (typeof n !== "number" || !isFinite(n) || n < 0) throw new Error(`invalid counter increment: ${n}`);
    counters.set(name, (counters.get(name) || 0) + n);
  } catch (err) {
    warn(err.message);
  }
}

// packages/core/tutorial-markdown.js
var RAW_BASE_URL = "https://raw.githubusercontent.com";
function stripImageDirectiveComments(content) {
  return content.replace(/<!--[^>]*?-->\s*(?=!\[)/g, "");
}
function absolutizeImagePaths(content, { slug, repo, branch } = {}) {
  if (!slug || !repo || !branch) return content;
  const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`;
  return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, path) => {
    if (path.startsWith("http://") || path.startsWith("https://")) return match;
    if (path.includes("../")) return match;
    const clean = path.replace(/^\.?\//, "");
    return `![${alt}](${base}/${clean})`;
  });
}

// packages/core/tutorial-markdown-steps.js
var VALIDATE_LINE = /^\s*\[VALIDATE_\d+\]\s*$/;
var DONE_LINE = /^\s*\[DONE\]\s*$/;
var H3 = /^### (.+)$/;
var FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
var FENCE_CLOSE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
function createFenceTracker() {
  let fenceChar = null;
  let fenceLen = 0;
  return function inFence(line) {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN);
      if (open) {
        fenceChar = open[2][0];
        fenceLen = open[2].length;
        return true;
      }
      return false;
    }
    const close = line.match(FENCE_CLOSE);
    if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
      return true;
    }
    return true;
  };
}
function commentLineFlags(lines) {
  const fence = createFenceTracker();
  const flags = new Array(lines.length).fill(false);
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence(line)) continue;
    if (inComment) {
      flags[i] = true;
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const open = line.indexOf("<!--");
    if (open === -1) continue;
    if (line.indexOf("-->", open + 4) !== -1) continue;
    flags[i] = true;
    inComment = true;
  }
  return flags;
}
function stripMarkers(lines) {
  return lines.filter((l) => !VALIDATE_LINE.test(l) && !DONE_LINE.test(l));
}
function stripMarkdownToText(md) {
  return md.replace(/```[^\n]*\n?|~~~[^\n]*\n?/g, " ").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`+/g, "").replace(/^#{1,6}\s+/gm, "").replace(/[*_>]/g, "").replace(/^\s*[-+]\s+/gm, "").replace(/\s+/g, " ").trim();
}
function parseMarkdownSteps(body) {
  if (typeof body !== "string" || body.length === 0) return [];
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const fence = createFenceTracker();
  const commented = commentLineFlags(lines);
  const raw = [];
  let currentTitle = "";
  let currentLines = [];
  let inStep = false;
  const flush = () => {
    if (!inStep) return;
    raw.push({ title: currentTitle, content: stripMarkers(currentLines).join("\n").trim() });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence(line)) {
      if (inStep) currentLines.push(line);
      continue;
    }
    if (commented[i]) continue;
    const h3 = line.match(H3);
    if (h3) {
      flush();
      currentTitle = h3[1].trim();
      currentLines = [];
      inStep = true;
      continue;
    }
    if (inStep) currentLines.push(line);
  }
  flush();
  return raw.map((s, idx) => {
    const heading = `### ${s.title}`;
    const stripped = stripImageDirectiveComments(s.content).trim();
    const markdown = stripped ? `${heading}

${stripped}` : heading;
    return {
      number: idx + 1,
      title: s.title,
      markdown,
      text: stripMarkdownToText(markdown)
    };
  });
}

// packages/mcp/tutorial-step-slicer.js
var NS2 = "com.sap.developers.ims";
var LOG2 = cds4.log("mcp-slicer");
var TTL_MS = 30 * 60 * 1e3;
function sliceKey(slug, version) {
  return `slice:${slug}::${version}`;
}
function mdSliceKey(slug, version) {
  return `slice-md:${slug}::${version}`;
}
function slugTag(slug) {
  return `slice-slug:${slug}`;
}
var _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds4.connect.to("caching");
  return _cachePromise;
}
async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
async function getActiveVersion() {
  const { ContentManifest } = cds4.entities(NS2);
  const [row] = await SELECT.from(ContentManifest).where({ status: "ACTIVE" }).columns("version");
  return row?.version ?? null;
}
async function loadAndParse(slug) {
  if (!isFlagEnabled("KG_STEP_SLICER_ENABLED")) return null;
  const version = await getActiveVersion();
  if (!version) return null;
  const cacheKey = sliceKey(slug, version);
  let hit;
  try {
    hit = await (await cache()).get(cacheKey);
  } catch (err) {
    LOG2.warn(`slicer: cache get failed for ${slug}, treating as miss: ${err.message}`);
    hit = null;
  }
  if (hit) {
    counter("mcp.slice[outcome=hit]");
    return { steps: new Map(hit.stepsEntries), totalSteps: hit.totalSteps };
  }
  const { ContentFiles } = cds4.entities(NS2);
  const [meta] = await SELECT.from(ContentFiles).where({ version, slug }).columns("slug", "mimeType");
  if (!meta) return null;
  let blobRow;
  try {
    blobRow = await SELECT.one.from(ContentFiles).where({ version, slug }).columns("content");
  } catch (err) {
    LOG2.warn(`slicer: BLOB fetch failed for ${slug}`, err.message);
    counter("mcp.slice[outcome=error]");
    return null;
  }
  const buffer = await toBuffer(blobRow.content);
  let html;
  try {
    html = gunzipSync(buffer).toString("utf8");
  } catch (err) {
    LOG2.warn(`slicer: gunzip failed for ${slug}`, err.message);
    counter("mcp.slice[outcome=error]");
    return null;
  }
  const $ = cheerio.load(html);
  const steps = /* @__PURE__ */ new Map();
  const sections = $("section.step[data-step-number]");
  sections.each((_, el) => {
    const $el = $(el);
    const stepNumber = parseInt($el.attr("data-step-number"), 10);
    if (!Number.isFinite(stepNumber)) return;
    const title = $el.find("h2.step-title").first().text().trim();
    const stepHtml = $.html($el);
    steps.set(stepNumber, { html: stepHtml, text: stripHtml(stepHtml), title });
  });
  if (steps.size === 0) {
    LOG2.warn(`slicer: no <section class="step"> found for ${slug}; content may be malformed`);
    counter("mcp.slice[outcome=error]");
    return null;
  }
  const result = { steps, totalSteps: steps.size };
  try {
    await (await cache()).set(
      cacheKey,
      { stepsEntries: [...steps.entries()], totalSteps: steps.size },
      { ttl: TTL_MS, tags: [{ value: slugTag(slug) }] }
    );
  } catch (err) {
    LOG2.warn(`slicer: cache set failed for ${slug}, entry not cached: ${err.message}`);
  }
  counter("mcp.slice[outcome=miss]");
  return result;
}
async function sliceStep(slug, stepNumber) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  const step = parsed.steps.get(stepNumber);
  if (!step) return null;
  return { html: step.html, text: step.text, stepTitle: step.title, totalSteps: parsed.totalSteps };
}
async function getRepoProvenance(slug) {
  try {
    const { RepoCatalog } = cds4.entities(NS2);
    if (!RepoCatalog) return { repo: null, branch: null };
    const row = await SELECT.one.from(RepoCatalog).where({ slug }).columns("repo", "branch");
    return { repo: row?.repo ?? null, branch: row?.branch ?? null };
  } catch (err) {
    LOG2.warn(`slicer: repo-provenance lookup failed for ${slug}: ${err.message}`);
    return { repo: null, branch: null };
  }
}
async function loadAndParseMarkdown(slug) {
  if (!isFlagEnabled("KG_STEP_SLICER_ENABLED")) return null;
  const version = await getActiveVersion();
  if (!version) return null;
  const cacheKey = mdSliceKey(slug, version);
  let hit;
  try {
    hit = await (await cache()).get(cacheKey);
  } catch (err) {
    LOG2.warn(`slicer: md cache get failed for ${slug}, treating as miss: ${err.message}`);
    hit = null;
  }
  if (hit) {
    counter("mcp.slice.md[outcome=hit]");
    return { steps: new Map(hit.stepsEntries), totalSteps: hit.totalSteps };
  }
  const { ContentFiles } = cds4.entities(NS2);
  let blobRow;
  try {
    blobRow = await SELECT.one.from(ContentFiles).where({ version, slug }).columns("sourceContent");
  } catch (err) {
    LOG2.warn(`slicer: md source fetch failed for ${slug}`, err.message);
    counter("mcp.slice.md[outcome=error]");
    return null;
  }
  if (!blobRow || blobRow.sourceContent == null) return null;
  let markdown;
  try {
    markdown = gunzipSync(await toBuffer(blobRow.sourceContent)).toString("utf8");
  } catch (err) {
    LOG2.warn(`slicer: md gunzip failed for ${slug}`, err.message);
    counter("mcp.slice.md[outcome=error]");
    return null;
  }
  const parsedSteps = parseMarkdownSteps(markdown);
  if (parsedSteps.length === 0) {
    LOG2.warn(`slicer: no markdown steps parsed for ${slug}; source may be malformed`);
    counter("mcp.slice.md[outcome=error]");
    return null;
  }
  const { repo, branch } = await getRepoProvenance(slug);
  const steps = /* @__PURE__ */ new Map();
  for (const s of parsedSteps) {
    const md = absolutizeImagePaths(s.markdown, { slug, repo, branch });
    steps.set(s.number, { markdown: md, text: s.text, title: s.title });
  }
  const result = { steps, totalSteps: steps.size };
  try {
    await (await cache()).set(
      cacheKey,
      { stepsEntries: [...steps.entries()], totalSteps: steps.size },
      { ttl: TTL_MS, tags: [{ value: slugTag(slug) }] }
    );
  } catch (err) {
    LOG2.warn(`slicer: md cache set failed for ${slug}, entry not cached: ${err.message}`);
  }
  counter("mcp.slice.md[outcome=miss]");
  return result;
}
async function sliceStepMarkdown(slug, stepNumber) {
  const parsed = await loadAndParseMarkdown(slug);
  if (!parsed) return null;
  const step = parsed.steps.get(stepNumber);
  if (!step) return null;
  return { markdown: step.markdown, text: step.text, stepTitle: step.title, totalSteps: parsed.totalSteps };
}
async function sliceAllSteps(slug) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  return [...parsed.steps.entries()].sort(([a], [b]) => a - b).map(([stepNumber, { title }]) => ({ stepNumber, title }));
}
async function invalidateSlug(slug) {
  try {
    await (await cache()).deleteByTag(slugTag(slug));
  } catch (err) {
    LOG2.warn(`slicer: invalidate failed for ${slug}, relying on TTL: ${err.message}`);
  }
}
cds4.on("served", () => {
  cds4.on("content.published", ({ slug }) => {
    if (slug) invalidateSlug(slug).catch(() => {
    });
  });
});

// packages/mcp/mcp-arg-validators.js
function assertRange({ name, value, min, max }) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
}
function assertEnum({ name, value, allowed }) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}
function clampLimit(value, defaultN, maxN) {
  if (value === void 0 || value === null) return defaultN;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return defaultN;
  return Math.min(maxN, Math.max(1, n));
}

// packages/mcp/mcp-progress-store.js
import cds6 from "@sap/cds";

// packages/core/user-progress.js
import cds5 from "@sap/cds";
var LOG3 = cds5.log("chat");
var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 25;
async function resolveDbUserId(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  if (user.__dbUserId !== void 0) return user.__dbUserId;
  try {
    const { Users } = cds5.entities("com.sap.developers.ims");
    const dbUser = await SELECT.one.from(Users).columns("ID").where({ sapId });
    user.__dbUserId = dbUser?.ID || null;
    return user.__dbUserId;
  } catch (err) {
    LOG3.warn("resolveDbUserId failed", err.message);
    return null;
  }
}
async function getUserProgress(user, opts = {}) {
  const dbUserId = await resolveDbUserId(user);
  if (!dbUserId) {
    return { inProgress: [], completedSlugs: [], lastCompletedSlug: null, completedMissionSlugs: [], completedGroupSlugs: [] };
  }
  const limit = Math.min(Math.max(1, opts.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const { TaskRecords, Tutorials, Missions, CompletionPaths } = cds5.entities("com.sap.developers.ims");
  const records = await SELECT.from(TaskRecords).columns("taskLegacyId", "taskType", "status", "progress", "modifiedAt", "completionDate", "titleSnapshot", "attemptNumber").where({
    user_ID: dbUserId,
    taskType: { in: ["TUTORIAL", "MISSION", "GROUP"] }
  });
  const tutorialIds = [];
  const missionIds = [];
  const groupIds = [];
  for (const r of records) {
    if (r.taskType === "TUTORIAL") tutorialIds.push(r.taskLegacyId);
    else if (r.taskType === "MISSION") missionIds.push(r.taskLegacyId);
    else if (r.taskType === "GROUP") groupIds.push(r.taskLegacyId);
  }
  const [tutorials, missions, groups] = await Promise.all([
    tutorialIds.length ? SELECT.from(Tutorials).columns("legacyId", "slug", "title").where({ legacyId: { in: tutorialIds } }) : [],
    missionIds.length ? SELECT.from(Missions).columns("legacyId", "slug", "title").where({ legacyId: { in: missionIds } }) : [],
    groupIds.length ? SELECT.from(CompletionPaths).columns("legacyId", "slug", "name as title").where({ legacyId: { in: groupIds } }) : []
  ]);
  const tutorialMeta = new Map(tutorials.map((t) => [t.legacyId, t]));
  const missionMeta = new Map(missions.map((m) => [m.legacyId, m]));
  const groupMeta = new Map(groups.map((g) => [g.legacyId, g]));
  const inProgress = [];
  const completedSlugs = [];
  const completedMissionSlugs = [];
  const completedGroupSlugs = [];
  for (const r of records) {
    const meta = r.taskType === "TUTORIAL" ? tutorialMeta.get(r.taskLegacyId) : r.taskType === "MISSION" ? missionMeta.get(r.taskLegacyId) : groupMeta.get(r.taskLegacyId);
    if (!meta?.slug) continue;
    if (r.status === "COMPLETED" || r.status === "SUPERSEDED") {
      if (r.taskType === "TUTORIAL") {
        const completedAt = r.completionDate || r.modifiedAt || null;
        completedSlugs.push({ slug: meta.slug, completedAt });
      } else if (r.taskType === "MISSION") completedMissionSlugs.push(meta.slug);
      else if (r.taskType === "GROUP") completedGroupSlugs.push(meta.slug);
    } else if (r.status === "IN_PROGRESS" && r.taskType === "TUTORIAL") {
      inProgress.push({
        slug: meta.slug,
        title: meta.title || r.titleSnapshot || meta.slug,
        progressPercent: typeof r.progress === "number" ? r.progress : 0,
        lastTouchedAt: r.modifiedAt || null
      });
    }
  }
  inProgress.sort((a, b) => {
    const at = a.lastTouchedAt ? new Date(a.lastTouchedAt).getTime() : 0;
    const bt = b.lastTouchedAt ? new Date(b.lastTouchedAt).getTime() : 0;
    return bt - at;
  });
  completedSlugs.sort((a, b) => {
    const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return bt - at;
  });
  const lastCompletedSlug = completedSlugs.length > 0 ? completedSlugs[0].slug : null;
  const seen = /* @__PURE__ */ new Set();
  const completedSlugList = [];
  for (const c of completedSlugs) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    completedSlugList.push(c.slug);
  }
  return {
    inProgress: inProgress.slice(0, limit),
    completedSlugs: completedSlugList,
    lastCompletedSlug,
    completedMissionSlugs,
    completedGroupSlugs
  };
}

// packages/mcp/mcp-progress-store.js
var NS3 = "com.sap.developers.ims";
async function getMyTutorials(user, { status = "all", limit = 20 } = {}) {
  const progress = await getUserProgress(user);
  const inProgress = progress.inProgress.map((t) => ({
    slug: t.slug,
    title: t.title,
    status: "in_progress",
    lastActivityAt: t.lastTouchedAt ?? null,
    attemptNumber: t.attemptNumber ?? 1
  }));
  const completed = progress.completedSlugs.map((slug) => ({
    slug,
    title: null,
    status: "completed",
    lastActivityAt: null,
    attemptNumber: null
  }));
  const rows = [...inProgress, ...completed];
  const filtered = status === "all" ? rows : rows.filter((r) => r.status === status);
  return filtered.slice(0, limit);
}
async function getMyMissions(user, { status = "all", limit = 10 } = {}) {
  const progress = await getUserProgress(user);
  const rows = progress.completedMissionSlugs.map((slug) => ({
    slug,
    title: null,
    status: "completed",
    completedCount: null,
    totalCount: null,
    nextTutorialSlug: null
  }));
  const filtered = status === "all" ? rows : status === "completed" ? rows : [];
  return filtered.slice(0, limit);
}
async function getMyEvents(user, { when = "upcoming", limit = 20 } = {}) {
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return [];
  const { Events, EventRegistrations } = cds6.entities(NS3);
  const now = /* @__PURE__ */ new Date();
  const regs = await SELECT.from(EventRegistrations).where({ user_ID: dbUser.ID }).columns("event_ID");
  const registeredIds = new Set(regs.map((r) => r.event_ID));
  let events = [];
  if (when === "upcoming") {
    events = await SELECT.from(Events).where({ startDate: { ">=": now } }).columns("ID", "legacyId", "name", "eventType", "startDate", "endDate").orderBy("startDate asc").limit(limit);
  } else if (when === "past") {
    events = await SELECT.from(Events).where({ endDate: { "<": now } }).columns("ID", "legacyId", "name", "eventType", "startDate", "endDate").orderBy("startDate desc").limit(limit);
  } else if (when === "registered") {
    if (registeredIds.size === 0) return [];
    events = await SELECT.from(Events).where({ ID: { in: [...registeredIds] } }).columns("ID", "legacyId", "name", "eventType", "startDate", "endDate").orderBy("startDate desc").limit(limit);
  }
  return events.map((e) => ({
    slug: e.legacyId != null ? String(e.legacyId) : null,
    name: e.name,
    eventType: e.eventType,
    startDate: e.startDate,
    endDate: e.endDate,
    registered: registeredIds.has(e.ID)
  }));
}
async function getMyCompletedSteps(user, slug) {
  if (!slug || typeof slug !== "string") return null;
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return null;
  const { Tutorials, Steps, TaskRecords } = cds6.entities(NS3);
  const [tutorial] = await SELECT.from(Tutorials).where({ slug: slug.toLowerCase() }).columns("ID", "legacyId");
  if (!tutorial) return null;
  const steps = await SELECT.from(Steps).where({ tutorial_ID: tutorial.ID }).columns("legacyId", "stepOrder");
  if (steps.length === 0) return { slug, completedSteps: [], attemptNumber: 1, lastActivityAt: null };
  const stepLegacyIds = steps.map((s) => s.legacyId);
  const records = await SELECT.from(TaskRecords).where({
    user_ID: dbUser.ID,
    taskType: "STEP",
    status: "COMPLETED",
    taskLegacyId: { in: stepLegacyIds }
  }).columns("taskLegacyId", "attemptNumber", "modifiedAt", "completionDate");
  const completedSteps = records.map((r) => steps.find((s) => s.legacyId === r.taskLegacyId)?.stepOrder).filter(Boolean).sort((a, b) => a - b);
  const maxAttempt = records.reduce((m, r) => Math.max(m, r.attemptNumber ?? 1), 1);
  const lastActivityAt = records.reduce((latest, r) => {
    const t = r.modifiedAt ?? r.completionDate;
    return !latest || t && new Date(t) > new Date(latest) ? t : latest;
  }, null);
  return {
    slug,
    completedSteps,
    attemptNumber: maxAttempt,
    lastActivityAt
  };
}

// packages/mcp/mcp-developer-tools.js
var LOG4 = cds7.log("mcp-dev");
async function withToolMetrics(req, fn) {
  try {
    const result = await fn();
    counter("mcp.tool.ok");
    return result;
  } catch (err) {
    counter("mcp.tool.error");
    throw err;
  }
}
var STATUS_TUT = ["in_progress", "completed", "all"];
var STATUS_MIS = ["in_progress", "completed", "not_started", "all"];
var WHEN_EVT = ["upcoming", "past", "registered"];
var STEP_FORMAT = ["markdown", "html"];
async function requireDbUser(req) {
  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) {
    LOG4.warn("[mcp-dev] resolveDbUser miss", { userId: req.user?.id, tokenSource: req.user?.tokenSource });
    return req.reject(401, "unable to resolve user");
  }
  return dbUser;
}
async function handleGetMyTutorials(req) {
  return withToolMetrics(req, async () => {
    const status = req.data.status ?? "all";
    try {
      assertEnum({ name: "status", value: status, allowed: STATUS_TUT });
    } catch (e) {
      return req.reject(400, e.message);
    }
    const limit = clampLimit(req.data.limit, 20, 50);
    const dbUser = await requireDbUser(req);
    if (dbUser === void 0) return;
    return getMyTutorials(req.user, { status, limit });
  });
}
async function handleGetMyMissions(req) {
  return withToolMetrics(req, async () => {
    const status = req.data.status ?? "all";
    try {
      assertEnum({ name: "status", value: status, allowed: STATUS_MIS });
    } catch (e) {
      return req.reject(400, e.message);
    }
    const limit = clampLimit(req.data.limit, 10, 50);
    const dbUser = await requireDbUser(req);
    if (dbUser === void 0) return;
    return getMyMissions(req.user, { status, limit });
  });
}
async function handleGetMyEvents(req) {
  return withToolMetrics(req, async () => {
    const when = req.data.when ?? "upcoming";
    try {
      assertEnum({ name: "when", value: when, allowed: WHEN_EVT });
    } catch (e) {
      return req.reject(400, e.message);
    }
    const limit = clampLimit(req.data.limit, 20, 50);
    const dbUser = await requireDbUser(req);
    if (dbUser === void 0) return;
    return getMyEvents(req.user, { when, limit });
  });
}
async function handleGetMyCompletedSteps(req) {
  return withToolMetrics(req, async () => {
    const { slug } = req.data;
    if (!slug || typeof slug !== "string") return req.reject(400, "slug is required");
    const dbUser = await requireDbUser(req);
    if (dbUser === void 0) return;
    const result = await getMyCompletedSteps(req.user, slug.toLowerCase());
    if (result === null) return req.reject(404, `tutorial not found: ${slug}`);
    return result;
  });
}
async function handleGetTutorialStep(req) {
  return withToolMetrics(req, async () => {
    const { slug, stepNumber } = req.data;
    const format = req.data.format ?? "markdown";
    if (!slug || typeof slug !== "string") return req.reject(400, "slug is required");
    if (!Number.isInteger(stepNumber) || stepNumber < 1)
      return req.reject(400, "stepNumber must be a positive integer");
    try {
      assertEnum({ name: "format", value: format, allowed: STEP_FORMAT });
    } catch (e) {
      return req.reject(400, e.message);
    }
    const lcSlug = slug.toLowerCase();
    if (format === "html") {
      const slice2 = await sliceStep(lcSlug, stepNumber);
      if (!slice2) return req.reject(404, "step not found");
      return {
        slug: lcSlug,
        stepNumber,
        stepTitle: slice2.stepTitle,
        content: slice2.html,
        contentFormat: "html",
        textLength: slice2.text.length,
        totalSteps: slice2.totalSteps
      };
    }
    const slice = await sliceStepMarkdown(lcSlug, stepNumber);
    if (!slice) return req.reject(404, "step not found");
    return {
      slug: lcSlug,
      stepNumber,
      stepTitle: slice.stepTitle,
      content: slice.markdown,
      contentFormat: "markdown",
      textLength: slice.text.length,
      totalSteps: slice.totalSteps
    };
  });
}
async function handleCompleteStep(req) {
  return withToolMetrics(req, async () => {
    if (req.user?.tokenSource === "pat" && !req.user.is("pat-write")) {
      return req.reject(403, "this token lacks write scope");
    }
    const { slug, stepNumber } = req.data;
    if (!slug || typeof slug !== "string") return req.reject(400, "slug is required");
    if (!Number.isInteger(stepNumber) || stepNumber < 1)
      return req.reject(400, "stepNumber must be a positive integer");
    const srv = req._?.service ?? cds7.services.DeveloperService;
    return srv.send({
      event: "completeStep",
      data: { slug: slug.toLowerCase(), stepNumber },
      user: req.user
    });
  });
}
async function handleResetTutorialProgress(req) {
  return withToolMetrics(req, async () => {
    if (req.user?.tokenSource === "pat" && !req.user.is("pat-write")) {
      return req.reject(403, "this token lacks write scope");
    }
    const { slug } = req.data;
    if (!slug || typeof slug !== "string") return req.reject(400, "slug is required");
    const srv = req._?.service ?? cds7.services.DeveloperService;
    return srv.send({
      event: "resetTutorialProgress",
      data: { slug: slug.toLowerCase() },
      user: req.user
    });
  });
}
export {
  assertEnum,
  assertRange,
  clampLimit,
  getMyCompletedSteps,
  getMyEvents,
  getMyMissions,
  getMyTutorials,
  handleCompleteStep,
  handleGetMyCompletedSteps,
  handleGetMyEvents,
  handleGetMyMissions,
  handleGetMyTutorials,
  handleGetTutorialStep,
  handleResetTutorialProgress,
  invalidateSlug,
  sliceAllSteps,
  sliceStep,
  sliceStepMarkdown
};
