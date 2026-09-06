'use strict';
const cds = require('@sap/cds');

// Pure: given channels + an async llm(channels)->drafts fn, return drafts.
// The llm fn is injected so tests never touch the AI SDK. The real llm is
// built lazily by buildLlm() below (never a top-level import — keeps
// @sap-ai-sdk/orchestration out of srv-qa boot; see project srv-qa cp-list rule).
async function draftCollections(channels, { llm }) {
  if (typeof llm !== 'function') throw new Error('draftCollections requires an llm function');
  const drafts = await llm(channels);
  return (drafts || []).map((d, i) => ({
    slug: String(d.slug).toLowerCase(),
    title: d.title, intro: d.intro, sortOrder: d.sortOrder ?? (i + 1) * 10,
    items: (d.items || []).map((it, j) => ({ sourceId: it.sourceId, url: it.url, blurb: it.blurb, sortOrder: it.sortOrder ?? (j + 1) * 10 })),
  }));
}

// Lazy-built real LLM caller. Mirrors srv/lib/category-classifier-llm.js.
async function buildLlm() {
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (channels) => {
    const catalog = channels.map((c) => ({ sourceId: c.sourceId, name: c.name, purpose: c.purpose, focusAreas: c.focusAreas, tags: c.tags, category: c.category }));
    const tool = {
      type: 'function',
      function: {
        name: 'submit_collections',
        description: 'Group SAP developer channels into 5-9 explained editorial collections.',
        parameters: {
          type: 'object',
          properties: {
            collections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' }, title: { type: 'string' }, intro: { type: 'string' },
                  items: { type: 'array', items: { type: 'object', properties: {
                    sourceId: { type: 'string', enum: catalog.map((c) => c.sourceId) },
                    blurb: { type: 'string' },
                  }, required: ['sourceId'] } },
                },
                required: ['slug', 'title', 'intro', 'items'],
              },
            },
          },
          required: ['collections'],
        },
      },
    };
    const client = new OrchestrationClient({
      promptTemplating: {
        model: { name: modelName, params: { max_tokens: 4000, temperature: 0.3, tool_choice: { type: 'function', function: { name: 'submit_collections' } } } },
        prompt: {
          template: [{ role: 'system', content: 'You are a curator grouping SAP developer channels into a small set of named, explained collections. Each collection has a short slug, a title, a 2-3 sentence intro on how to navigate it, and an ordered list of member channels (by sourceId) each with a one-line blurb.' }],
          tools: [tool],
        },
      },
    }, { deploymentId });
    const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: JSON.stringify(catalog) }] });
    const calls = response.getToolCalls() || [];
    const args = calls[0] && JSON.parse(calls[0].function.arguments);
    return (args && args.collections) || [];
  };
}

async function seedCollections(db, { commit = false, llm } = {}) {
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels, ChannelCollections, ChannelCollectionItems } = linked.entities('com.sap.developers.ims');
  const channels = await db.run(SELECT.from(Channels).where({ isPublished: true }));
  const effectiveLlm = llm || (await buildLlm());
  const drafts = await draftCollections(channels, { llm: effectiveLlm });
  const bySource = new Map(channels.map((c) => [c.sourceId, c]));

  let created = 0, updatedDraft = 0, skippedReviewed = 0;
  for (const d of drafts) {
    // slug-canonical: write-path-canonicalizes — draftCollections() lowercases d.slug at source
    const existing = await db.run(SELECT.one.from(ChannelCollections).where({ slug: d.slug }));
    if (existing && existing.authoringStatus === 'REVIEWED') { skippedReviewed++; continue; }
    if (!commit) { existing ? updatedDraft++ : created++; continue; }

    let colId;
    if (existing) {
      colId = existing.ID;
      await db.run(UPDATE(ChannelCollections).set({ title: d.title, intro: d.intro, sortOrder: d.sortOrder, authoringStatus: 'AI_SEEDED' }).where({ ID: colId }));
      await db.run(DELETE.from(ChannelCollectionItems).where({ collection_ID: colId }));
      updatedDraft++;
    } else {
      colId = cds.utils.uuid();
      await db.run(INSERT.into(ChannelCollections).entries({ ID: colId, slug: d.slug, title: d.title, intro: d.intro, sortOrder: d.sortOrder, isPublished: false, authoringStatus: 'AI_SEEDED' }));
      created++;
    }
    const items = d.items
      .map((it) => ({ ch: it.sourceId ? bySource.get(it.sourceId) : channels.find((c) => c.url === it.url), blurb: it.blurb, sortOrder: it.sortOrder }))
      .filter((x) => x.ch);
    if (items.length) {
      await db.run(INSERT.into(ChannelCollectionItems).entries(items.map((x) => ({ ID: cds.utils.uuid(), collection_ID: colId, channel_ID: x.ch.ID, blurb: x.blurb, sortOrder: x.sortOrder }))));
    }
  }
  return { created, updatedDraft, skippedReviewed };
}

module.exports = { draftCollections, seedCollections, buildLlm };
