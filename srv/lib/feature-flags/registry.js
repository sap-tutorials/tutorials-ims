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
    key: 'KG_COMMUNITY_WEIGHT', label: 'KG community search weight',
    category: 'Knowledge Graph', kind: 'env', envVar: 'KG_COMMUNITY_WEIGHT',
    envRule: 'numeric', valueType: 'number', default: 0, issue: '#1171', status: 'dev-only',
    description: 'Additive Louvain-community rank term in search (>0 enables). Requires searchKgRerankEnabled=true.',
    howToChange: cfEnv('KG_COMMUNITY_WEIGHT', '1.5'),
  },
  {
    key: 'KG_WEIGHT', label: 'KG concept-overlap search weight',
    category: 'Knowledge Graph', kind: 'constant', valueType: 'number', default: 2.0,
    issue: '#945', status: 'ga',
    description: 'Hardcoded concept-overlap rank multiplier. Not runtime-configurable.',
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
    howToChange: adminTile('joule', '#joule',
      'Not yet on the Joule Settings form — PATCH /admin/ChatSettings(<ID>) directly until added.'),
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
];
