import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';

const LOG = cds.log('chat');
const MAX_TURNS = 5;

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
const ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'analyticsQuery',
    description: 'Run a structured analytics query over completion data. Allowed facts: completion, start. Allowed dimensions: taskType, event, tag, mission, tutorial, group, completionMonth, completionWeek. Allowed measures: count, distinctUsers. Cells with distinctUsers < 5 are suppressed.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', enum: ['completion','start'] },
        dimensions: { type: 'array', items: { type: 'string' } },
        measures: { type: 'array', items: { type: 'string', enum: ['count','distinctUsers'] } },
        filter: { type: 'object' },
        topN: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['fact','dimensions','measures'],
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

async function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];
  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL);
  }
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings);
    if (settings?.ragEnabled) {
      tools.push(GET_RELEVANT_STEPS_TOOL);
    }
  } catch (err) {
    LOG.warn('toolsForContext: could not read ChatSettings', err.message);
  }
  return tools;
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
      const { SearchableItems } = search.entities;
      const hits = await search.run(
        SELECT.from(SearchableItems).search(args.query).limit(5)
      );
      return (hits || []).map(h => ({
        slug: h.slug, title: h.title, description: h.description,
        type: h.type, primaryTag: h.primaryTag
      }));
    } catch (err) {
      LOG.warn('searchTutorials failed', err.message);
      return { error: 'search_failed', hits: [] };
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
      LOG.warn('analyticsQuery failed', err.message);
      return { error: 'analytics_failed', message: 'Query execution failed' };
    }
  }

  if (name === 'getRelevantSteps') {
    try {
      if (typeof args.question !== 'string' || !args.question.trim()) {
        return { error: 'invalid_args', hits: [] };
      }
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      const settings = await SELECT.one.from(ChatSettings);
      if (!settings?.ragEnabled) {
        return { error: 'rag_disabled', hits: [] };
      }
      const { findRelevantSteps } = await import('./embedding-query.js');
      const hits = await findRelevantSteps({ query: args.question, settings });
      return (hits || []).map(h => ({
        tutorialSlug: h.tutorialSlug,
        tutorialTitle: h.tutorialTitle,
        stepNumber: h.stepNumber,
        excerpt: h.text.slice(0, 600),
        score: h.score
      }));
    } catch (err) {
      LOG.warn('getRelevantSteps failed', err.message);
      return { error: 'rag_failed', hits: [] };
    }
  }

  return { error: 'unknown_tool' };
}

export async function streamChat({ res, system, messages, deploymentId, modelName, temperature, maxTokens, signal, tools, user }) {
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

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
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
        content: assistantText || null,
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
        name: cur.name,
        body: cur?.response?.data ?? null
      });
      cur = cur.cause;
    }
    LOG.error('chat stream failed', JSON.stringify(causeChain));
  } finally {
    res.end();
  }
}

export { SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GET_RELEVANT_STEPS_TOOL, toolsForContext };
