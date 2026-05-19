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

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export async function dispatchTool(name, args) {
  if (name !== 'searchTutorials') return { error: 'unknown_tool' };
  try {
    if (typeof args.query !== 'string' || !args.query.trim()) {
      return { error: 'invalid_args', hits: [] };
    }
    const search = await cds.connect.to('SearchService');
    const filters = {};
    if (Array.isArray(args.tags) && args.tags.length) filters.tags = args.tags;
    if (args.type) filters.type = args.type;
    const hits = await search.run(SELECT.from('SearchableItems')
      .where({ search: args.query, ...filters })
      .limit(5));
    return (hits || []).map(h => ({
      slug: h.slug, title: h.title, description: h.description,
      type: h.type, primaryTag: h.primaryTag
    }));
  } catch (err) {
    LOG.warn('searchTutorials failed', err.message);
    return { error: 'search_failed', hits: [] };
  }
}

export async function streamChat({ res, system, messages, deploymentId, modelName, temperature, maxTokens, signal }) {
  const effectiveModel = modelName || process.env.CHAT_MODEL_NAME || 'anthropic--claude-4.6-sonnet';
  const effectiveTemperature = temperature != null ? Number(temperature) : 0.51;
  const effectiveMaxTokens = maxTokens != null ? Number(maxTokens) : 10025;
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
            tools: [SEARCH_TUTORIALS_TOOL]
          }
        },
        filtering: {
          input: {
            filters: [{
              type: 'azure_content_safety',
              config: {
                hate: 'ALLOW_SAFE_LOW',
                self_harm: 'ALLOW_SAFE_LOW',
                sexual: 'ALLOW_SAFE_LOW',
                violence: 'ALLOW_SAFE_LOW',
                prompt_shield: true
              }
            }]
          },
          output: {
            filters: [{
              type: 'azure_content_safety',
              config: {
                hate: 'ALLOW_SAFE_LOW',
                self_harm: 'ALLOW_SAFE_LOW',
                sexual: 'ALLOW_SAFE_LOW',
                violence: 'ALLOW_SAFE_LOW',
                protected_material_code: true
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
        const result = await dispatchTool(tc.name, tc.args || {});
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }

      if (signal?.aborted) return;
    }

    LOG.warn('chat agent loop hit MAX_TURNS', { turns: MAX_TURNS });
    sse(res, { type: 'done' });
  } catch (err) {
    const reason = err?.code === 'CONTENT_FILTER' ? 'content_filter' : undefined;
    // All non-filter errors are treated as retryable for v1 — categorization (timeout, rate limit, etc.) can be added later.
    sse(res, { type: 'error', retryable: !reason, reason });
    const detail = err?.response?.data
      ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
      : err?.cause?.response?.data
        ? JSON.stringify(err.cause.response.data)
        : null;
    LOG.error('chat stream failed', err.message, detail ? `| body: ${detail}` : '');
  } finally {
    res.end();
  }
}

export { SEARCH_TUTORIALS_TOOL };
