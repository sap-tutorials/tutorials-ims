'use strict';
const cds = require('@sap/cds');

// Pure: given channels + the valid topicTag vocabulary + an async
// llm(channels, topicTags)->drafts fn, return normalized drafts.
// The llm fn is injected so tests never touch the AI SDK. The real llm is
// built lazily by buildLlm() below (never a top-level import — keeps
// @sap-ai-sdk/orchestration out of srv-qa boot; see project srv-qa cp-list rule).
async function draftChannelTopicMap(channels, topicTags, { llm }) {
  if (typeof llm !== 'function') throw new Error('draftChannelTopicMap requires an llm function');
  const valid = new Set(topicTags || []);
  const drafts = await llm(channels, topicTags);
  return (drafts || [])
    .filter((d) => d && d.sourceId && d.topicTag && (valid.size === 0 || valid.has(d.topicTag)))
    .map((d) => ({
      sourceId: d.sourceId,
      topicTag: d.topicTag,
      relevance: Number.isFinite(d.relevance) ? Math.max(0, Math.min(100, d.relevance)) : 50,
    }));
}

// Lazy-built real LLM caller. Mirrors srv/lib/channels/seed-collections.cjs.
// NOTE: tag-md-format.js uses ESM exports, so it is loaded via await import()
// inside loadTopicTags rather than require(). @sap-ai-sdk/orchestration and
// chat-settings-resolver.js are also lazy-imported here to keep them off the
// srv-qa boot path.
async function buildLlm() {
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (channels, topicTags) => {
    const catalog = channels.map((c) => ({ sourceId: c.sourceId, name: c.name, purpose: c.purpose, focusAreas: c.focusAreas, tags: c.tags, category: c.category }));
    const tool = {
      type: 'function',
      function: {
        name: 'submit_topic_map',
        description: 'Map SAP developer channels to the most relevant site topic tags (from the provided vocabulary), with a 0-100 relevance score.',
        parameters: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sourceId: { type: 'string', enum: catalog.map((c) => c.sourceId) },
                  topicTag: { type: 'string', enum: topicTags },
                  relevance: { type: 'integer' },
                },
                required: ['sourceId', 'topicTag', 'relevance'],
              },
            },
          },
          required: ['rows'],
        },
      },
    };
    const client = new OrchestrationClient({
      promptTemplating: {
        model: { name: modelName, params: { max_tokens: 4000, temperature: 0.2, tool_choice: { type: 'function', function: { name: 'submit_topic_map' } } } },
        prompt: {
          template: [{ role: 'system', content: 'You map SAP developer channels to site topic tags. For each channel, propose 1-3 of the MOST relevant topicTags from the provided vocabulary (never invent tags), each with a relevance 0-100. Prefer precision over recall.' }],
          tools: [tool],
        },
      },
    }, { deploymentId });
    const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: JSON.stringify({ channels: catalog, topicTags }) }] });
    const calls = response.getToolCalls() || [];
    const args = calls[0] && JSON.parse(calls[0].function.arguments);
    return (args && args.rows) || [];
  };
}

// Load the valid mdFormat topicTag vocabulary from the Tags entity.
// tag-md-format.js is ESM, so loaded via dynamic import (not require).
async function loadTopicTags(db, linked) {
  const { titlePathToMdFormat } = await import('../tag-md-format.js');
  const { Tags } = linked.entities('com.sap.developers.ims');
  const tags = await db.run(SELECT.from(Tags).columns('titlePath'));
  const out = new Set();
  for (const t of tags) {
    if (t.titlePath) { const md = titlePathToMdFormat(t.titlePath); if (md) out.add(md); }
  }
  return [...out];
}

async function seedChannelTopicMap(db, { commit = false, llm } = {}) {
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels, ChannelTopicMap } = linked.entities('com.sap.developers.ims');
  const channels = await db.run(SELECT.from(Channels).where({ isPublished: true }));
  const bySource = new Map(channels.map((c) => [c.sourceId, c]));
  const topicTags = await loadTopicTags(db, linked);
  const effectiveLlm = llm || (await buildLlm());
  const drafts = await draftChannelTopicMap(channels, topicTags, { llm: effectiveLlm });

  let created = 0, updatedDraft = 0, skippedReviewed = 0;
  for (const d of drafts) {
    const ch = bySource.get(d.sourceId);
    if (!ch) continue;
    const existing = await db.run(SELECT.one.from(ChannelTopicMap).where({ channel_ID: ch.ID, topicTag: d.topicTag }));
    if (existing && existing.authoringStatus === 'REVIEWED') { skippedReviewed++; continue; }
    if (!commit) { existing ? updatedDraft++ : created++; continue; }
    if (existing) {
      await db.run(UPDATE(ChannelTopicMap).set({ relevance: d.relevance, authoringStatus: 'AI_SEEDED' }).where({ ID: existing.ID }));
      updatedDraft++;
    } else {
      await db.run(INSERT.into(ChannelTopicMap).entries({ ID: cds.utils.uuid(), channel_ID: ch.ID, topicTag: d.topicTag, relevance: d.relevance, authoringStatus: 'AI_SEEDED' }));
      created++;
    }
  }
  return { created, updatedDraft, skippedReviewed };
}

module.exports = { draftChannelTopicMap, seedChannelTopicMap, buildLlm };
