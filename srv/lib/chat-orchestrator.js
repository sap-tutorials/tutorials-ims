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

export async function dispatchTool(name, args) {
  if (name !== 'searchTutorials') return { error: 'unknown_tool' };
  try {
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

export async function streamChat({ res, system, messages, deploymentId }) {
  const client = new OrchestrationClient({
    llm: { deploymentId },
    templating: { template: [{ role: 'system', content: system }] },
    tools: [SEARCH_TUTORIALS_TOOL]
  });

  const history = [...messages];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.stream({ messagesHistory: history });
      const collectedToolCalls = [];
      let assistantText = '';

      for await (const chunk of stream) {
        const delta = typeof chunk.getDeltaContent === 'function' ? chunk.getDeltaContent() : null;
        if (delta) {
          assistantText += delta;
          sse(res, { type: 'delta', content: delta });
        }
        const toolCalls = typeof chunk.getToolCalls === 'function' ? chunk.getToolCalls() : null;
        if (Array.isArray(toolCalls) && toolCalls.length) {
          for (const tc of toolCalls) {
            collectedToolCalls.push(tc);
            sse(res, { type: 'tool', name: tc.name, args: tc.args });
          }
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
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
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
    }

    LOG.warn('chat agent loop hit MAX_TURNS', { turns: MAX_TURNS });
    sse(res, { type: 'done' });
  } catch (err) {
    const reason = err?.code === 'CONTENT_FILTER' ? 'content_filter' : undefined;
    sse(res, { type: 'error', retryable: !reason, reason });
    LOG.error('chat stream failed', err.message);
  } finally {
    res.end();
  }
}

export { SEARCH_TUTORIALS_TOOL };
