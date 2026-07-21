// srv/lib/feature-flags/registry.js
// Hand-authored source of truth for the Feature Flag Viewer (Admin UI).
// The drift test in test/unit/feature-flags-registry.test.js fails the build
// if a new env flag or settings boolean is added without a matching entry.
//
// kind:
//   'env'        — read from process.env; effective value via envRule.
//   'db-setting' — a boolean/number column on a settings entity.
//                  `resolver` picks how the effective value is resolved:
//                    'kg'/'uiEvents' → the env-layered resolveXSettings()
//                    'chat'          → direct ChatSettings row (no env layer)
//   'constant'   — a hardcoded, non-runtime-configurable value (shown, no howToChange).
// envRule: 'true-enables' | 'false-disables' | 'numeric'.
// status:  'ga' | 'dev-only' | 'beta' | 'parked'.

export const KINDS = ['env', 'db-setting', 'constant'];
export const ENV_RULES = ['true-enables', 'false-disables', 'numeric'];
export const STATUSES = ['ga', 'dev-only', 'beta', 'parked'];

const cfEnv = (name, value) => ({
  method: 'cf-env',
  command: `cf set-env tutorials-srv ${name} ${value} && cf restart tutorials-srv`,
});
const adminTile = (tile, hash, note) => ({ method: 'admin-tile', tile, hash, note });

export const FEATURE_FLAGS = [
  // ---- Knowledge Graph env flags (env-layered via resolveKnowledgeGraphSettings where applicable) ----
  {
    key: 'KNOWLEDGE_GRAPH_ENABLED', label: 'Knowledge Graph master switch',
    category: 'Knowledge Graph', kind: 'db-setting', entity: 'KnowledgeGraphSettings',
    column: 'enabled', resolver: 'kg', envVar: 'KNOWLEDGE_GRAPH_ENABLED',
    valueType: 'boolean', default: false,
    issue: '', status: 'ga',
    description: 'Master switch for the /graph/* service surface. Off → 503.',
    howToChange: adminTile('knowledgeGraph', '#knowledgeGraph', 'Or env KNOWLEDGE_GRAPH_ENABLED.'),
  },
  {
    key: 'KG_ONDEMAND_ENABLED', label: 'KG on-demand extraction',
    category: 'Knowledge Graph', kind: 'db-setting', entity: 'KnowledgeGraphSettings',
    column: 'onDemandExtractionEnabled', resolver: 'kg', envVar: 'KG_ONDEMAND_ENABLED',
    valueType: 'boolean', default: false, issue: '#948', status: 'ga',
    description: 'On-demand concept extraction from zero-seed search queries.',
    howToChange: adminTile('knowledgeGraph', '#knowledgeGraph', 'Or env KG_ONDEMAND_ENABLED.'),
  },
  {
    key: 'KG_PAGERANK_ENABLED', label: 'KG PageRank blend', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_PAGERANK_ENABLED', envRule: 'true-enables',
    valueType: 'boolean', default: false, issue: '#916', status: 'ga',
    description: 'Blends per-tutorial PageRank into KG neighborhood ranking.',
    howToChange: cfEnv('KG_PAGERANK_ENABLED', 'true'),
  },
  {
    key: 'KG_PATH_V2_ENABLED', label: 'KG path-finding v2', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_PATH_V2_ENABLED', envRule: 'true-enables',
    valueType: 'boolean', default: false, issue: '#913', status: 'beta',
    description: 'Property-graph v2 pathBetween with fail-open v1 SPARQL fallback.',
    howToChange: cfEnv('KG_PATH_V2_ENABLED', 'true'),
  },
  {
    key: 'communityRankWeight', label: 'KG community search weight',
    category: 'Knowledge Graph', kind: 'db-setting', entity: 'ChatSettings',
    column: 'communityRankWeight', resolver: 'chat', envVar: 'KG_COMMUNITY_WEIGHT',
    valueType: 'number', default: 0, issue: '#1171', status: 'dev-only',
    description: 'Additive Louvain-community rank term in search (>0 enables). Requires searchKgRerankEnabled=true. Admin-editable; KG_COMMUNITY_WEIGHT env var is a fallback only.',
    howToChange: adminTile('joule', '#joule', 'Or env KG_COMMUNITY_WEIGHT (fallback only, used when the column is unset).'),
  },
  {
    key: 'KG_WEIGHT', label: 'KG concept-overlap search weight',
    category: 'Knowledge Graph', kind: 'constant', valueType: 'number', default: 2.0,
    issue: '#945', status: 'ga',
    description: 'Hardcoded concept-overlap rank multiplier. Not runtime-configurable.',
  },
  // ---- Navigator ----
  {
    key: 'NAV_INCLUDE_NESTED_GROUPS', label: 'Navigator nested-group cards',
    category: 'Navigator', kind: 'db-setting', entity: 'NavigatorSettings',
    column: 'includeNestedGroups', resolver: 'navigator', envVar: 'NAV_INCLUDE_NESTED_GROUPS',
    valueType: 'boolean', default: false, issue: '#364', status: 'ga',
    description: 'When on, /build/navigator emits cards for nested groups (~65 extra cards on dev).',
    howToChange: adminTile('navigator', '#navigator', 'Or env NAV_INCLUDE_NESTED_GROUPS.'),
  },
  // ---- UI events ----
  {
    key: 'UI_EVENTS_ENABLED', label: 'UI event telemetry', category: 'Telemetry',
    kind: 'db-setting', entity: 'UiEventsSettings', column: 'enabled', resolver: 'uiEvents',
    envVar: 'UI_EVENTS_ENABLED', valueType: 'boolean', default: false, issue: '#204', status: 'ga',
    description: 'UI event tracking. Off → /api/ui-event 503, tracker self-disables.',
    howToChange: adminTile('uiEvents', '#uiEvents', 'Or env UI_EVENTS_ENABLED.'),
  },
  // ---- Chat / AI booleans (direct ChatSettings row; NO env layer) ----
  {
    key: 'ChatSettings.enabled', label: 'Joule chat master switch', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'enabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '', status: 'ga',
    description: 'Master switch for the Joule chat assistant.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.ragEnabled', label: 'RAG / vector grounding', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'ragEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '', status: 'ga',
    description: 'Retrieval-augmented grounding over tutorial embeddings.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.codeCheckEnabled', label: 'AI code-check', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'codeCheckEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#171', status: 'ga',
    description: 'AI code-check tool. Off → /api/codecheck 503.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.validateAnswerEnabled', label: 'AI answer grader', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'validateAnswerEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#209', status: 'ga',
    description: 'AI free-text answer grader. Off → /api/validate-answer 503.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.branchingEnabled', label: 'Branching learning paths', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'branchingEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#172', status: 'ga',
    description: 'Branching paths master flag. Off → /api/branches/decide 404.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.kgPathBetweenEnabled', label: 'KG learning-path tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgPathBetweenEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#445', status: 'ga',
    description: 'findLearningPath Joule tool registration.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.communityPeersEnabled', label: 'KG community-peers tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'communityPeersEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#1126', status: 'dev-only',
    description: 'findCommunityPeers Joule tool. Ships dark until PROD Louvain data verified.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.kgSearchExpansionEnabled', label: 'KG search expansion', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgSearchExpansionEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#943', status: 'ga',
    description: 'expandSearchConcepts Joule tool. Default ON (cheap).',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.searchKgRerankEnabled', label: 'KG-boosted search ranking', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'searchKgRerankEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#945', status: 'ga',
    description: 'Server-side KG rerank of search results. Default ON. Gates KG_COMMUNITY_WEIGHT.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.kgRelatedContentEnabled', label: 'KG related-content tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgRelatedContentEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#1125', status: 'ga',
    description: 'findRelatedContent Joule tool. Default ON (cache-reused).',
    howToChange: adminTile('joule', '#joule'),
  },
  // ---- A2A (Agent-to-Agent) ----
  {
    key: 'ChatSettings.a2aEnabled', label: 'A2A agent endpoint', category: 'A2A',
    kind: 'db-setting', entity: 'ChatSettings', column: 'a2aEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#1220', status: 'dev-only',
    description: 'Exposes the A2A JSON-RPC endpoint (POST /a2a) and the agent card (GET /.well-known/agent-card.json). Kill switch — set false to signal the endpoint is disabled in the agent card.',
    howToChange: adminTile('joule', '#joule', 'Managed via ChatSettings.a2aEnabled DB column.'),
  },
  // ---- Observability ----
  {
    key: 'METRICS_ENABLED', label: 'Metrics collection', category: 'Observability',
    kind: 'env', envVar: 'METRICS_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '', status: 'ga',
    description: 'Prometheus-style metrics snapshots and DB wrap instrumentation. Kill switch — set false to disable all metric writes.',
    howToChange: cfEnv('METRICS_ENABLED', 'false'),
  },
  // ---- MCP (Phase 2 / Phase 3) ----
  {
    key: 'MCP_AUTH_ENABLED', label: 'MCP OAuth auth tier', category: 'MCP',
    kind: 'env', envVar: 'MCP_AUTH_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1105', status: 'ga',
    description: 'Phase 2 MCP /mcp-auth and /mcp-pat routes. Kill switch — set false to return 503 on both routes.',
    howToChange: cfEnv('MCP_AUTH_ENABLED', 'false'),
  },
  {
    key: 'MCP_PAT_MINT_ENABLED', label: 'MCP PAT minting', category: 'MCP',
    kind: 'env', envVar: 'MCP_PAT_MINT_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1105', status: 'ga',
    description: 'Allows PAT tokens to be minted via the MCP auth tier. Kill switch — set false to disable minting (existing PATs still valid).',
    howToChange: cfEnv('MCP_PAT_MINT_ENABLED', 'false'),
  },
  {
    key: 'MCP_PHASE3_ENABLED', label: 'MCP Phase-3 compose router', category: 'MCP',
    kind: 'env', envVar: 'MCP_PHASE3_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1106', status: 'ga',
    description: 'MCP Phase-3 compose router (resources + prompts + admin tools). Kill switch — set false to serve tools-only via plain @cap-js/mcp adapter.',
    howToChange: cfEnv('MCP_PHASE3_ENABLED', 'false'),
  },
  {
    key: 'MCP_RESOURCES_ENABLED', label: 'MCP resources', category: 'MCP',
    kind: 'env', envVar: 'MCP_RESOURCES_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1106', status: 'ga',
    description: 'MCP resource registration inside the Phase-3 compose router. Kill switch — set false to omit resources from the compose server.',
    howToChange: cfEnv('MCP_RESOURCES_ENABLED', 'false'),
  },
  {
    key: 'MCP_PROMPTS_ENABLED', label: 'MCP prompts', category: 'MCP',
    kind: 'env', envVar: 'MCP_PROMPTS_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1106', status: 'ga',
    description: 'MCP prompt registration inside the Phase-3 compose router. Kill switch — set false to omit prompts from the compose server.',
    howToChange: cfEnv('MCP_PROMPTS_ENABLED', 'false'),
  },
  {
    key: 'MCP_ADMIN_TOOLS_ENABLED', label: 'MCP admin tools', category: 'MCP',
    kind: 'env', envVar: 'MCP_ADMIN_TOOLS_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1106', status: 'ga',
    description: 'MCP admin tool registration inside the Phase-3 compose router. Kill switch — set false to omit admin tools from the compose server.',
    howToChange: cfEnv('MCP_ADMIN_TOOLS_ENABLED', 'false'),
  },
  // ---- Knowledge Graph kill switches ----
  {
    key: 'KG_RETIRE_ORPHANS_ENABLED', label: 'KG orphan concept retirement', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_RETIRE_ORPHANS_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1115', status: 'ga',
    description: 'Nightly job that retires zero-link orphaned concepts (ACTIVE→RETIRED). Kill switch — set false to skip retirement on each nightly run.',
    howToChange: cfEnv('KG_RETIRE_ORPHANS_ENABLED', 'false'),
  },
  {
    key: 'KG_STEP_SLICER_ENABLED', label: 'KG tutorial step slicer', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_STEP_SLICER_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '', status: 'ga',
    description: 'Per-step concept extraction slice during tutorial ingestion. Kill switch — set false to skip step-level slicing (whole-tutorial extraction still runs).',
    howToChange: cfEnv('KG_STEP_SLICER_ENABLED', 'false'),
  },
  // ---- Content ----
  {
    key: 'COMMUNITY_BLOGS_CLASSIFIER_ENABLED', label: 'Community blogs classifier', category: 'Content',
    kind: 'env', envVar: 'COMMUNITY_BLOGS_CLASSIFIER_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '#1033', status: 'ga',
    description: 'Scheduled AI classifier that drains PENDING CommunityBlogPosts rows via SAP Generative AI Hub. Kill switch — set false to skip all classification runs.',
    howToChange: cfEnv('COMMUNITY_BLOGS_CLASSIFIER_ENABLED', 'false'),
  },
  {
    key: 'HOMEPAGE_NEWS_RELEVANCE_ENABLED', label: 'Homepage news relevance scoring', category: 'Content',
    kind: 'env', envVar: 'HOMEPAGE_NEWS_RELEVANCE_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '', status: 'ga',
    description: 'AI-based relevance scoring for homepage news items. Kill switch — set false to fall back to chronological ordering.',
    howToChange: cfEnv('HOMEPAGE_NEWS_RELEVANCE_ENABLED', 'false'),
  },
];
