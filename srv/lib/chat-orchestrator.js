import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { validateQuerySpec } from './query-spec-validator.mjs';
import { specToSql } from './spec-to-sql.mjs';
import { getAnalyticsContext } from './analytics-llm-context.js';
import { GET_BRANCH_RECOMMENDATION_TOOL, getBranchRecommendationHandler } from './branch/joule-tool.js';
import { FIND_LEARNING_PATH_TOOL, findLearningPathHandler } from './kg/joule-tool-find-path.js';
import { EXPAND_SEARCH_CONCEPTS_TOOL, expandSearchConceptsHandler } from './kg/joule-tool-expand-concepts.js';
import { embed as embedInputs } from './embedding-client.js';
import { resolveEmbeddingSettings } from './chat-settings-resolver.js';

const LOG = cds.log('chat');
const MAX_TURNS = 5;

// Process-level guard: emit the rich getRelevantSteps failure log only once per
// (deploymentId, model) combination. Repeats are silenced so a misconfigured
// embedding deployment doesn't flood cf logs with thousands of identical lines.
const ragWarnedKeys = new Set();

/**
 * Adapt the shared `embed(inputs, model)` client (batched, retry-wrapped)
 * to the single-string `{ embed(text, opts?) => Promise<Float32Array> }`
 * shape used by KG tools. Mirrors the identical wrapper in
 * srv/jobs/concept-embedding-backfill.js — keeping the two in sync means
 * either both work or neither does.
 *
 * The signal option is accepted for API compatibility with the KG-tool DI
 * contract (see joule-tool-expand-concepts.js § embed with AbortSignal) but
 * the underlying batched client doesn't currently plumb it through; the
 * handler's wall-clock deadline is the real backstop.
 */
function defaultEmbedClient(model) {
  return {
    async embed(text /* , opts */) {
      const [vec] = await embedInputs([text], model);
      return vec;
    },
  };
}

const SEARCH_TUTORIALS_TOOL = {
  type: 'function',
  function: {
    name: 'searchTutorials',
    description: 'Search the SAP tutorial catalog. Use when the user asks to find a tutorial or needs context from a tutorial other than the current one.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords to search' },
        tags:  { type: 'array',  items: { type: 'string' }, description: 'optional tag filters' },
        type:  { type: 'string', enum: ['tutorial', 'mission', 'group'], description: 'optional kind filter' }
      },
      required: ['query']
    }
  }
};

const SEARCH_ADMIN_DOCS_TOOL = {
  type: 'function',
  function: {
    name: 'searchAdminDocs',
    description: 'Keyword search over the platform repository documentation. Use to answer "how does X work" questions about the tutorial system itself.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, topN: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
  },
};
const ANALYTICS_DIMENSIONS = ['taskType','event','tag','mission','tutorial','group','completionMonth','completionWeek'];
const ANALYTICS_FILTER_OPS = ['equals','in','contains','sinceDays','between'];

const ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'analyticsQuery',
    description: [
      'Run a structured analytics query over completion data.',
      'Allowed facts: completion, start.',
      'Allowed dimensions: taskType, event, tag, mission, tutorial, group, completionMonth, completionWeek.',
      'Allowed measures: count, distinctUsers. Cells with distinctUsers < 5 are suppressed.',
      'Filters MUST be an array of {field, op, value}. Date filters MUST set field to a date-trunc dimension name (completionMonth or completionWeek), not a column name.',
      'Examples:',
      '- last 30 days: filter=[{"field":"completionWeek","op":"sinceDays","value":30}]',
      '- between dates: filter=[{"field":"completionMonth","op":"between","value":["2026-01-01","2026-03-31"]}]',
      '- specific event: filter=[{"field":"event","op":"equals","value":"TechEd 2025"}]'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', enum: ['completion','start'] },
        dimensions: { type: 'array', items: { type: 'string', enum: ANALYTICS_DIMENSIONS } },
        measures: { type: 'array', items: { type: 'string', enum: ['count','distinctUsers'] } },
        filter: {
          type: 'array',
          description: 'Array of filter clauses. Each clause names a dimension (the `field`), an operator, and a value.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: ANALYTICS_DIMENSIONS, description: 'Dimension name from the allowed list. Use completionMonth or completionWeek for date filters.' },
              op:    { type: 'string', enum: ANALYTICS_FILTER_OPS },
              value: {
                description: 'sinceDays: integer days. between: [startDate, endDate] as ISO strings. in: array of strings. equals/contains: string.',
              }
            },
            required: ['field','op','value']
          }
        },
        topN: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['fact','dimensions','measures'],
    },
  },
};

const GENERATE_ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'generateAnalyticsQuery',
    description: 'Translate a natural-language analytics request into a structured QuerySpec that the user can review in the chip builder. The QuerySpec is validated and SQL is re-derived server-side; do NOT emit raw SQL. Use this when the user wants to construct or refine a query that they will run themselves.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'A QuerySpec v1 object: { version: 1, from: { entity, alias }, joins: [], filterTree: null|{op,operands}, groupBy: [], select: [{kind:"column"|"agg", id, ref:{alias,column}, fn?}], orderBy: [], limit: null|number }.',
        },
        explanation: {
          type: 'string',
          description: 'A short (1-2 sentence) plain-language explanation of what the query does.',
        },
      },
      required: ['spec'],
    },
  },
};

const EXPLAIN_ANALYTICS_RESULT_TOOL = {
  type: 'function',
  function: {
    name: 'explainAnalyticsResult',
    description: 'Produce a 1-3 sentence plain-language summary of an analytics result sample. The user has just run a query and wants context. The columns + rows are already PII-redacted client-side; do NOT echo cell values verbatim if they look sensitive. Highlight totals, outliers, trends.',
    parameters: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
        summary: { type: 'string', description: 'Your 1-3 sentence summary.' },
      },
      required: ['columns', 'rows', 'summary'],
    },
  },
};

const GET_RELEVANT_STEPS_TOOL = {
  type: 'function',
  function: {
    name: 'getRelevantSteps',
    description: 'Retrieve tutorial step excerpts semantically relevant to the user\'s question using vector search. Use when the user asks a how-to or conceptual question that may be answered by tutorial content.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The user\'s question to match against tutorial step content' }
      },
      required: ['question']
    }
  }
};

const GET_USER_PROGRESS_TOOL = {
  type: 'function',
  function: {
    name: 'getUserProgress',
    description: 'Fetch the SIGNED-IN user\'s tutorial progress: in-progress tutorials (started but not finished, ordered by recency) plus slugs of already-completed tutorials, missions, and groups. Use when the user asks to resume, "where did I leave off", "what should I learn next", or any question where you must avoid re-recommending finished content. Anonymous users return empty arrays.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max in-progress tutorials to return (default 10)' }
      }
    }
  }
};

const CHECK_CODE_TOOL = {
  type: 'function',
  function: {
    name: 'checkCode',
    description: 'Grade a learner-submitted code snippet against a tutorial step\'s author-defined goal. Returns a structured verdict with pass/partial/fail, a summary, suggestions, and what the learner got right. Use ONLY when the user has pasted code AND named a tutorial slug + step number.',
    parameters: {
      type: 'object',
      required: ['tutorialSlug', 'stepNumber', 'submittedCode'],
      properties: {
        tutorialSlug:  { type: 'string' },
        stepNumber:    { type: 'integer' },
        submittedCode: { type: 'string', maxLength: 20000 },
        language:      { type: 'string' }
      }
    }
  }
};

const GET_DEVTOBERFEST_INFO_TOOL = {
  type: 'function',
  function: {
    name: 'getDevtoberfestInfo',
    description: "Fetch authoritative Devtoberfest event information. Call this for any factual question about the current Devtoberfest event — dates, rules, points, gameboard, activities, legal terms, videos, or live streams. Pass section='all' if unsure which slice is relevant.",
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'],
          description: "Which slice of Devtoberfest data to return. Default 'all' returns event + links + a summary of every other section's availability."
        }
      }
    }
  }
};

const FIND_RELATED_CONTENT_TOOL = {
  type: 'function',
  function: {
    name: 'findRelatedContent',
    description: [
      'Find SAP external content (learning journeys, blog posts, Discovery',
      'Center missions, videos, API docs, code samples, help docs, community',
      'events) related to a topic, via the knowledge graph.',
      'Use when the user asks for docs, videos, samples, blogs, learning',
      'journeys, events, or "external content / resources" on a topic.',
      'Authoritative items (SAP-authored docs/samples/videos/journeys/missions)',
      'may be cited directly; community items (blog posts, events) should be',
      'presented with soft attribution.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text topic. 1-200 chars.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: [
            'learning-journey', 'blog-post', 'discovery-mission', 'video',
            'api-doc', 'sample', 'help-doc', 'community-event',
          ] },
          description: 'Optional: restrict to these content types.',
        },
        maxItems: { type: 'integer', description: 'Cap on returned items. 1-20, default 8.' },
      },
      required: ['query'],
    },
  },
};

/**
 * Pure, synchronous tool-registry builder. Given the ChatSettings row (or a
 * plain-object subset in tests) plus pageContext/isAdmin, returns the list
 * of tool descriptors to expose to the LLM on this turn.
 *
 * Kept synchronous and side-effect-free so unit tests can call it without
 * booting CAP or seeding DB — see test/chat-orchestrator-search-expansion.test.js.
 * `toolsForContext` is the caller-facing async wrapper that fetches settings
 * from DB.
 *
 * pageContext / isAdmin default to a standard learner context (kind: 'generic',
 * not admin) when omitted — matches what a bare `buildToolRegistry({ settings })`
 * call in tests should reasonably return.
 */
export function buildToolRegistry({ settings, pageContext, isAdmin = false } = {}) {
  if (pageContext?.kind === 'devtoberfest') {
    // Devtoberfest pages get a scoped tool set: catalog search (the persona
    // instructs the model to pass tags=['devtoberfest']) + the dedicated
    // event-data tool. Feature-flagged tools (RAG, branching, codecheck,
    // findLearningPath, expandSearchConcepts) and getUserProgress are
    // explicitly suppressed — their scopes don't apply to Devtoberfest event pages.
    return [SEARCH_TUTORIALS_TOOL, GET_DEVTOBERFEST_INFO_TOOL];
  }

  const tools = [SEARCH_TUTORIALS_TOOL];

  // Advocates page: trimmed palette. searchTutorials + getUserProgress.
  // ChatSettings-gated tools (getRelevantSteps, checkCode,
  // getBranchRecommendation, findLearningPath, expandSearchConcepts) are
  // intentionally excluded — off-scope on /developer-advocates/. Early
  // return keeps the existing admin and learner branches below byte-identical.
  if (pageContext?.kind === 'advocates') {
    tools.push(GET_USER_PROGRESS_TOOL);
    return tools;
  }

  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GENERATE_ANALYTICS_QUERY_TOOL, EXPLAIN_ANALYTICS_RESULT_TOOL);
  } else {
    // Learner-side only — admins are running the platform, not consuming
    // tutorials, so progress lookup is irrelevant in the admin persona.
    tools.push(GET_USER_PROGRESS_TOOL);
  }
  if (settings?.ragEnabled) {
    tools.push(GET_RELEVANT_STEPS_TOOL);
  }
  if (settings?.codeCheckEnabled) {
    tools.push(CHECK_CODE_TOOL);
  }
  if (settings?.branchingEnabled) {
    tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
  }
  if (settings?.kgPathBetweenEnabled) {
    tools.push(FIND_LEARNING_PATH_TOOL);
  }
  if (settings?.kgSearchExpansionEnabled) {
    tools.push(EXPAND_SEARCH_CONCEPTS_TOOL);
  }
  if (settings?.kgRelatedContentEnabled) {
    tools.push(FIND_RELATED_CONTENT_TOOL);
  }
  return tools;
}

/**
 * Return supplementary system-prompt lines that depend on flag-gated tool
 * availability. Pure/synchronous, mirrors `buildToolRegistry` semantics —
 * only emits guidance for tools that will actually be registered.
 */
export function buildSystemPromptLines({ settings, pageContext, isAdmin = false } = {}) {
  const lines = [];
  // Devtoberfest / advocates use minimal tool sets with none of these — skip.
  if (pageContext?.kind === 'devtoberfest' || pageContext?.kind === 'advocates') return lines;
  // Same guard as buildToolRegistry: the tool is only registered on the
  // standard learner/admin path.
  if (settings?.kgSearchExpansionEnabled) {
    lines.push(
      "When the user asks to find or search for tutorials on a topic, prefer calling `expandSearchConcepts` first, then `searchTutorials` for narrow keyword matches. Combine both signals in your response — mention the top concept relationships when they add clarity."
    );
  }
  if (settings?.kgRelatedContentEnabled) {
    lines.push(
      "When the user asks for external content — docs, videos, code samples, blog posts, learning journeys, Discovery missions, or community events on a topic — call `findRelatedContent`. Cite authoritative items (SAP-authored docs, samples, videos, journeys, missions) directly; present community items (blog posts, events) with soft attribution like \"a community blog post by …\"."
    );
  }
  return lines;
}

async function toolsForContext({ pageContext, isAdmin }) {
  let settings = null;
  // Devtoberfest short-circuits without a DB read — settings are irrelevant there.
  if (pageContext?.kind !== 'devtoberfest') {
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      settings = await SELECT.one.from(ChatSettings);
    } catch (err) {
      LOG.warn('toolsForContext: could not read ChatSettings', err.message);
    }
  }
  return buildToolRegistry({ settings, pageContext, isAdmin });
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export async function dispatchTool(name, args, user) {
  if (name === 'searchTutorials') {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return { error: 'invalid_args', hits: [] };
      }
      const search = await cds.connect.to('SearchService');
      // Use string entity path instead of search.entities.SearchableItems
      // — mock-friendly and equivalent at runtime.
      // Explicit projection lets SearchService.before('READ') attach the
      // _searchRank column so title hits are ordered above tag-only hits
      // (issue #154). Without explicit columns the rank fallback early-exits
      // and Joule sees results in DB-natural order.
      //
      // #945: the same before('READ') hook now blends KG concept overlap
      // into _searchRank when the flag is on. It ALSO populates the shared
      // search-kg-signal in-process cache. We peek that cache below to
      // attach per-hit `rationale` strings ("Teaches Async ABAP and RAP")
      // without a second embed call.
      const hits = await search.run(
        SELECT.from('SearchService.SearchableItems')
          .columns('slug', 'title', 'description', 'taskType', 'primaryTag')
          .search(args.query)
          .limit(5)
      );
      // Best-effort rationale attach — cache miss (flag off, KG returned
      // empty, or cache was evicted between the two calls) just means no
      // rationale field. Never break search on this.
      let rationaleBySlug = new Map();
      try {
        const { peekSignal } = await import('./search-kg-signal.js');
        const signal = peekSignal(args.query);
        if (signal?.slugRationale) rationaleBySlug = signal.slugRationale;
      } catch (peekErr) {
        LOG.warn('searchTutorials rationale peek failed', peekErr.message);
      }
      const baseHits = (hits || []).map(h => {
        const base = {
          slug: h.slug, title: h.title, description: h.description,
          type: h.type ?? h.taskType, primaryTag: h.primaryTag,
        };
        const rationale = rationaleBySlug.get(h.slug);
        return rationale ? { ...base, rationale } : base;
      });
      // Annotate each hit with the user's status so the LLM can avoid
      // re-suggesting completed items and prioritize in-progress ones.
      // Failure to enrich must NOT break search — fall back to neutral hits.
      try {
        const { getProgressLookup } = await import('./user-progress.js');
        const lookup = await getProgressLookup(user);
        if (lookup.size === 0) return baseHits;
        return baseHits.map(h => {
          const taskType = (h.type || '').toUpperCase();
          const key = `${taskType}:${h.slug}`;
          const entry = lookup.get(key);
          if (!entry) return { ...h, userStatus: 'new' };
          if (entry.status === 'COMPLETED') return { ...h, userStatus: 'completed' };
          return { ...h, userStatus: 'in-progress', progressPercent: entry.progressPercent };
        });
      } catch (annotateErr) {
        LOG.warn('searchTutorials annotation failed; returning unannotated hits', annotateErr.message);
        return baseHits;
      }
    } catch (err) {
      LOG.warn('searchTutorials failed', err.message);
      return { error: 'search_failed', hits: [] };
    }
  }

  if (name === 'getUserProgress') {
    try {
      const { getUserProgress } = await import('./user-progress.js');
      const limit = typeof args?.limit === 'number' ? args.limit : undefined;
      return await getUserProgress(user, { limit });
    } catch (err) {
      LOG.warn('getUserProgress failed', err.message);
      return { error: 'progress_failed', inProgress: [], completedSlugs: [], lastCompletedSlug: null, completedMissionSlugs: [], completedGroupSlugs: [] };
    }
  }

  if (name === 'searchAdminDocs') {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return { error: 'invalid_args', items: [] };
      }
      const { searchAdminDocs } = await import('./admin-docs-index.js');
      const topN = typeof args.topN === 'number' ? args.topN : 5;
      return searchAdminDocs({ query: args.query, topN });
    } catch (err) {
      LOG.warn('searchAdminDocs failed', err.message);
      return { error: 'docs_search_failed', items: [] };
    }
  }

  if (name === 'analyticsQuery') {
    try {
      const groupBy = Array.isArray(args.dimensions) ? args.dimensions : [];
      const measures = Array.isArray(args.measures) ? args.measures : ['count'];
      let filters = [];
      if (Array.isArray(args.filter)) {
        filters = args.filter;
      } else if (args.filter && typeof args.filter === 'object') {
        for (const [field, spec] of Object.entries(args.filter)) {
          if (spec && typeof spec === 'object' && 'op' in spec && 'value' in spec) {
            filters.push({ field, op: spec.op, value: spec.value });
          } else if (typeof spec === 'string' || typeof spec === 'number') {
            filters.push({ field, op: 'equals', value: spec });
          } else {
            LOG.warn('analyticsQuery: unrecognized filter spec dropped', { field });
          }
        }
      }
      const limit = typeof args.topN === 'number' ? args.topN : 25;
      const { runAnalyticsQuery } = await import('./admin-analytics-runner.js');
      return await runAnalyticsQuery({
        plan: { fact: args.fact, groupBy, measures, filters, limit },
        db: cds.db,
        user,
        log: LOG
      });
    } catch (err) {
      if (err.code === 'pii_denied') return { error: 'pii_denied', message: err.message };
      if (err.code === 'unknown_field') return { error: 'unknown_field', message: err.message };
      if (err.code === 'invalid_value') return { error: 'invalid_value', message: err.message };
      LOG.warn('analyticsQuery failed', {
        message: err?.message,
        name: err?.name || err?.constructor?.name,
        code: err?.code,
        stack: err?.stack
      });
      // Surface the underlying message so the LLM can self-correct (e.g.
      // "ungrouped column", "unknown association"). The runner only throws
      // tagged errors above; this branch catches DB-layer failures.
      return { error: 'analytics_failed', message: err?.message || 'Query execution failed' };
    }
  }

  if (name === 'generateAnalyticsQuery') {
    let spec = args?.spec;
    // Some LLM outputs serialize `spec` as a JSON string instead of an object.
    if (typeof spec === 'string') {
      try { spec = JSON.parse(spec); } catch { /* leave as-is, type guard below catches it */ }
    }
    if (!spec || typeof spec !== 'object') {
      return { error: 'spec is required (QuerySpec v1 object)' };
    }
    const { entityMap, sqlNames } = getAnalyticsContext();
    // Wrap the validator + SQL gen in a try/catch defense-in-depth — the LLM
    // can emit shapes the validator's individual guards don't anticipate
    // (missing nested fields, wrong types). Returning structured errors keeps
    // the chat alive instead of bubbling up to the streamChat catch handler.
    let errors;
    try { ({ errors } = validateQuerySpec(spec, entityMap)); }
    catch (e) { return { errors: [{ chipId: null, message: `spec validation crashed: ${e.message}` }], spec }; }
    if (errors.length > 0) return { errors, spec };
    let sql;
    try { sql = specToSql(spec, sqlNames); }
    catch (e) { return { errors: [{ chipId: null, message: `spec-to-sql failed: ${e.message}` }], spec }; }
    const wrapped = `SELECT * FROM (${sql}) t LIMIT 11`;
    let rows = [];
    try { rows = await cds.db.run(wrapped); }
    catch (e) { return { errors: [{ chipId: null, message: `query execution failed: ${e.message}` }], spec, sql }; }
    const truncated = rows.length > 10;
    const preview = {
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows: (truncated ? rows.slice(0, 10) : rows).map(r => Object.values(r).map(v => v === null ? null : String(v))),
      truncated,
    };
    return { errors: [], spec, sql, explanation: args?.explanation || '', preview };
  }

  if (name === 'explainAnalyticsResult') {
    const cols = Array.isArray(args?.columns) ? args.columns : [];
    const allRows = Array.isArray(args?.rows) ? args.rows : [];
    const truncated = allRows.length > 50;
    const rows = truncated ? allRows.slice(0, 50) : allRows;
    return {
      columns: cols,
      rows,
      truncated: !!truncated,
      summary: typeof args?.summary === 'string' ? args.summary : '',
    };
  }

  if (name === 'getRelevantSteps') {
    let settings = null;
    try {
      if (typeof args.question !== 'string' || !args.question.trim()) {
        return { error: 'invalid_args', hits: [] };
      }
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      settings = await SELECT.one.from(ChatSettings);
      if (!settings?.ragEnabled) {
        return { error: 'rag_disabled', hits: [] };
      }
      const { findRelevantSteps } = await import('./embedding-query.js');
      const hits = await findRelevantSteps({ query: args.question, settings });
      return (hits || []).map(h => ({
        tutorialSlug: h.tutorialSlug,
        tutorialTitle: h.tutorialTitle,
        stepNumber: h.stepNumber,
        excerpt: (h.text || '').slice(0, 600),
        score: h.score
      }));
    } catch (err) {
      // Rate-limit by (embeddingDeploymentId, embeddingModel) so we log once
      // per process for each misconfiguration rather than per chat turn.
      const embeddingDeploymentId = settings?.embeddingDeploymentId || '';
      const { model: embeddingModel } = await resolveEmbeddingSettings();
      const key = `${embeddingDeploymentId}:${embeddingModel}`;
      if (!ragWarnedKeys.has(key)) {
        ragWarnedKeys.add(key);
        // Build a cause chain so the first occurrence is actionable in cf logs.
        const causeChain = [];
        let cur = err;
        while (cur && causeChain.length < 5) {
          causeChain.push({
            message: cur.message,
            name: cur.name || cur.constructor?.name,
            responseStatus: cur?.response?.status ?? null,
            responseData: cur?.response?.data ?? null
          });
          cur = cur.cause;
        }
        LOG.warn('getRelevantSteps failed (logging once per deployment+model)', {
          message: err?.message,
          name: err?.name || err?.constructor?.name,
          embeddingDeploymentId: embeddingDeploymentId || null,
          embeddingModel,
          causeChain
        });
      }
      return { error: 'rag_failed', hits: [] };
    }
  }

  if (name === 'getDevtoberfestInfo') {
    try {
      const { getDevtoberfestInfo } = await import('./devtoberfest-joule-tool.js');
      return await getDevtoberfestInfo(args, user);
    } catch (err) {
      LOG.warn('getDevtoberfestInfo dispatch failed', err.message);
      return { error: 'devtoberfest_data_unavailable' };
    }
  }

  if (name === 'checkCode') {
    try {
      const { dispatchCheckCode } = await import('./code-check-tool.js');
      const { defaultCallModel }     = await import('./code-check-llm.js');
      const { defaultLoadStepText }  = await import('./code-check-step-loader.js');
      return await dispatchCheckCode(args, { user, callModel: defaultCallModel, loadStepText: defaultLoadStepText });
    } catch (err) {
      LOG.warn('checkCode dispatch failed', err.message);
      return { verdict: 'error', errorReason: 'upstream' };
    }
  }

  if (name === 'getBranchRecommendation') {
    return await getBranchRecommendationHandler({ args, user });
  }

  if (name === 'findLearningPath') {
    try {
      const db = await cds.connect.to('db');
      return await findLearningPathHandler({ db, args, user });
    } catch (err) {
      LOG.warn('findLearningPath dispatch failed:', err.message);
      return 'Internal error finding a learning path — please try a more specific question.';
    }
  }

  if (name === 'expandSearchConcepts') {
    try {
      const db = await cds.connect.to('db');
      // Resolve the embedding model from ChatSettings (same source as the
      // concept-embedding backfill job); fall back to the SDK default.
      // Resolve embedding model via the shared resolver. Failure to read
      // ChatSettings falls back through env → hardcoded default; NEVER throws.
      const { model } = await resolveEmbeddingSettings();
      const embedClient = defaultEmbedClient(model);
      // #948: thread authenticated user or anon requester into the handler
      // so the enqueue side-effect can attribute the request correctly.
      const requester = user?.id
        ? { id: user.id, kind: 'user' }
        : { kind: 'anon' };
      // #1111: pass embeddingModel too so computeKgSignal's embedInputs fallback
      // path (used when the shared cache miss triggers a fresh embed) picks the
      // same model as the direct embedClient.
      return await expandSearchConceptsHandler({ db, embedClient, embeddingModel: model, args, requester });
    } catch (err) {
      LOG.warn('expandSearchConcepts dispatch failed:', err.message);
      return { queryEcho: args?.query ?? '', concepts: [], tutorials: [], warning: 'dispatch_failed' };
    }
  }

  return { error: 'unknown_tool' };
}

export async function streamChat({ res, system, messages, deploymentId, modelName, temperature, maxTokens, signal, tools, user, pageContext }) {
  // streamChat receives `deploymentId`/`modelName` from its callers — srv/server.js's
  // /chat/stream route already reads ChatSettings before invoking us (see server.js
  // around line 1086), and unit tests pass explicit values. Unifying through
  // resolveChatLlmSettings() here would force a redundant DB read in the hot path
  // and break tests that call streamChat({ deploymentId: 'd1' }) without ChatSettings
  // mocked. The env-var + hardcoded literal below duplicate the resolver's own
  // fallback chain as an in-place safety net for the edge case where a caller
  // passes `modelName: undefined` (unreachable in production).
  const effectiveModel = modelName || process.env.CHAT_MODEL_NAME || 'anthropic--claude-4.6-sonnet';
  const effectiveTemperature = temperature != null ? Number(temperature) : 0.51;
  const effectiveMaxTokens = maxTokens != null ? Number(maxTokens) : 10025;
  const effectiveTools = Array.isArray(tools) && tools.length ? tools : [SEARCH_TUTORIALS_TOOL];
  let client;
  try {
    client = new OrchestrationClient(
      {
        promptTemplating: {
          model: {
            name: effectiveModel,
            params: { max_tokens: effectiveMaxTokens, temperature: effectiveTemperature }
          },
          prompt: {
            template: [{ role: 'system', content: system }],
            tools: effectiveTools
          }
        },
        filtering: {
          input: {
            filters: [{
              type: 'azure_content_safety',
              config: {
                hate: 2,
                self_harm: 2,
                sexual: 2,
                violence: 2
              }
            }]
          },
          output: {
            filters: [{
              type: 'azure_content_safety',
              config: {
                hate: 2,
                self_harm: 2,
                sexual: 2,
                violence: 2
              }
            }]
          }
        }
      },
      { deploymentId }
    );
  } catch (err) {
    LOG.error('OrchestrationClient init failed', err.message);
    sse(res, { type: 'error', retryable: false });
    res.end();
    return;
  }

  const history = [...messages];
  let turn = 0;

  try {
    for (; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) return;
      const response = await client.stream({ messagesHistory: history }, signal);
      const collectedToolCalls = [];
      let assistantText = '';

      for await (const chunk of response.stream) {
        if (signal?.aborted) break;
        const delta = typeof chunk.getDeltaContent === 'function' ? chunk.getDeltaContent() : null;
        if (delta) {
          assistantText += delta;
          sse(res, { type: 'delta', content: delta });
        }
      }

      if (signal?.aborted) return;

      const finalToolCalls = typeof response.getToolCalls === 'function' ? response.getToolCalls() : null;
      if (Array.isArray(finalToolCalls) && finalToolCalls.length) {
        for (const tc of finalToolCalls) {
          const args = tc.function?.arguments;
          const parsedArgs = typeof args === 'string' ? safeJsonParse(args) : (args || {});
          collectedToolCalls.push({ id: tc.id, name: tc.function?.name, args: parsedArgs });
          sse(res, { type: 'tool', name: tc.function?.name, args: parsedArgs });
        }
      }

      if (collectedToolCalls.length === 0) {
        sse(res, { type: 'done' });
        return;
      }

      history.push({
        role: 'assistant',
        // SAP AI Core orchestration rejects null content with
        // "None is not of type 'string'" — always send a string, even when
        // the turn has only tool_calls and no prose.
        content: assistantText,
        tool_calls: collectedToolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) }
        }))
      });

      for (const tc of collectedToolCalls) {
        const result = await dispatchTool(tc.name, tc.args || {}, user);
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
        if (tc.name === 'searchTutorials' && Array.isArray(result) && result.length > 0) {
          sse(res, { type: 'tutorial-cards', items: result });
        } else if (tc.name === 'searchAdminDocs' && Array.isArray(result) && result.length > 0) {
          sse(res, { type: 'doc-citations', items: result.map(h => ({ path: h.path, heading: h.heading, score: h.score })) });
        } else if (tc.name === 'analyticsQuery' && result && !result.error && Array.isArray(result.rows)) {
          sse(res, { type: 'analytics-result', plan: result.plan, rows: result.rows, suppressedCount: result.suppressedCount, totalRows: result.totalRows });
        } else if (tc.name === 'generateAnalyticsQuery' && result && Array.isArray(result.errors)) {
          sse(res, { type: 'generated-query', spec: result.spec, sql: result.sql, errors: result.errors, explanation: result.explanation, preview: result.preview });
        } else if (tc.name === 'explainAnalyticsResult' && result && typeof result.summary === 'string') {
          sse(res, { type: 'explanation', summary: result.summary, columns: result.columns, rows: result.rows, truncated: result.truncated });
        } else if (tc.name === 'getRelevantSteps' && Array.isArray(result) && result.length > 0) {
          sse(res, { type: 'step-citations', items: result });
        }
      }

      if (signal?.aborted) return;
    }

    LOG.warn('chat agent loop hit MAX_TURNS', { turns: MAX_TURNS });
    sse(res, { type: 'done' });
  } catch (err) {
    const reason = err?.code === 'CONTENT_FILTER' ? 'content_filter' : undefined;
    // All non-filter errors are treated as retryable for v1 — categorization (timeout, rate limit, etc.) can be added later.
    sse(res, { type: 'error', retryable: !reason, reason });
    const causeChain = [];
    let cur = err;
    while (cur && causeChain.length < 5) {
      causeChain.push({
        message: cur.message,
        name: cur.name || cur.constructor?.name,
        responseStatus: cur?.response?.status ?? null,
        responseData: cur?.response?.data ?? null
      });
      cur = cur.cause;
    }
    LOG.error('chat stream failed', {
      message: err?.message,
      name: err?.name || err?.constructor?.name,
      responseStatus: err?.response?.status ?? null,
      responseData: err?.response?.data ?? null,
      deploymentId,
      modelName: effectiveModel,
      pageKind: pageContext?.kind ?? null,
      turn,
      causeChain
    });
  } finally {
    res.end();
  }
}

export { SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GET_RELEVANT_STEPS_TOOL, GET_USER_PROGRESS_TOOL, CHECK_CODE_TOOL, GET_DEVTOBERFEST_INFO_TOOL, GET_BRANCH_RECOMMENDATION_TOOL, FIND_LEARNING_PATH_TOOL, EXPAND_SEARCH_CONCEPTS_TOOL, FIND_RELATED_CONTENT_TOOL, toolsForContext };
