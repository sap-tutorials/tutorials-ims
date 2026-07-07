// srv/lib/relevance-classifier.js
//
// Source-agnostic developer-relevance classifier for SAP News (#1034) and
// Community Blog Posts (#1033). Embedding-first, LLM-fallback in the
// mid-band, keyword-fallback on any embedding/LLM error or empty-seeds
// short-circuit. Bypasses @cap-js/ai — uses @sap-ai-sdk directly.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { getSeedEmbeddings } from './relevance-seed-embeddings.js';
import { embed } from './embedding-client.js';
import { classifyByKeywords } from './relevance-keyword-rules.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';

const LOG = cds.log('relevance-classifier');
const DEFAULT_MARGIN = 0.15;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxCosine(itemVec, seedVecs) {
  let m = -1;
  for (const s of seedVecs) {
    const c = cosine(itemVec, s);
    if (c > m) m = c;
  }
  return m;
}

async function readMargin() {
  try {
    // Node 22 hazard: use string entity reference so tests can stub cds.db
    // without needing a bootstrapped cds model.
    const db = cds.db ?? await cds.connect.to('db');
    const [row] = await db.run(
      SELECT.from('com.sap.developers.ims.ChatSettings').columns('newsRelevanceMargin').limit(1),
    );
    if (row?.newsRelevanceMargin != null) return Number(row.newsRelevanceMargin);
  } catch (e) {
    LOG.warn(`readMargin failed, using default ${DEFAULT_MARGIN}: ${e.message}`);
  }
  return DEFAULT_MARGIN;
}

/**
 * Reserve one LLM call against the daily budget stored in ChatSettings.
 *
 * Resets the counter when newsRelevanceLlmCallsCountedOn is not today.
 * Increments atomically before the call so concurrent classifiers count
 * correctly.
 *
 * Fail-open: any read/write error returns { granted: true } so a DB hiccup
 * does not block classification — the LLM path has its own catch → keyword
 * fallback anyway.
 *
 * @returns {Promise<{ granted: boolean }>}
 */
async function reserveLlmBudget() {
  try {
    const db = cds.db ?? await cds.connect.to('db');
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Use a string entity reference so tests can stub cds.db without needing
    // a bootstrapped cds model (same pattern as hybrid tests).
    const [row] = await db.run(
      SELECT.from('com.sap.developers.ims.ChatSettings')
        .columns('newsRelevanceLlmBudgetPerDay', 'newsRelevanceLlmCallsToday', 'newsRelevanceLlmCallsCountedOn')
        .limit(1),
    );
    if (!row) return { granted: true }; // no settings row yet → fail-open

    const budget = row.newsRelevanceLlmBudgetPerDay ?? 100;
    const countedOn = row.newsRelevanceLlmCallsCountedOn
      ? String(row.newsRelevanceLlmCallsCountedOn).slice(0, 10)
      : null;

    // Day rolled over — reset counter.
    if (countedOn !== today) {
      await db.run(
        UPDATE('com.sap.developers.ims.ChatSettings').set({
          newsRelevanceLlmCallsToday: 1,
          newsRelevanceLlmCallsCountedOn: today,
        }),
      );
      return { granted: true };
    }

    const callsToday = row.newsRelevanceLlmCallsToday ?? 0;
    if (callsToday >= budget) {
      LOG.warn(`LLM daily budget exhausted (${callsToday}/${budget}); skipping LLM classify`);
      return { granted: false };
    }

    // Increment before the call to prevent races on concurrent classifiers.
    await db.run(
      UPDATE('com.sap.developers.ims.ChatSettings').set({
        newsRelevanceLlmCallsToday: callsToday + 1,
      }),
    );
    return { granted: true };
  } catch (e) {
    LOG.warn(`reserveLlmBudget failed (fail-open): ${e.message}`);
    return { granted: true };
  }
}

function keywordFallback({ title, description, error }) {
  const r = classifyByKeywords({ title, description });
  return {
    verdict: r.verdict,
    reason: r.reason,
    source: 'fallback-keyword',
    confidence: 0.5,
    model: 'keyword-rules-v1',
    ...(error != null ? { error: error.message ?? String(error) } : {}),
  };
}

function parseLlmVerdict(rawContent) {
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON object in LLM output');
  const parsed = JSON.parse(jsonMatch[0]);
  if (parsed.verdict !== 'relevant' && parsed.verdict !== 'not-relevant') {
    throw new Error(`invalid verdict: ${parsed.verdict}`);
  }
  return {
    verdict: parsed.verdict,
    reason: String(parsed.reason ?? '').slice(0, 500),
  };
}

function buildLlmPrompt({ title, description, sourceType }) {
  const rubric = [
    'You are classifying a candidate news / blog item for a developer portal.',
    'developer-relevant = mentions APIs, SDKs, CLI, code samples, CAP, BTP, HANA, ABAP RAP, Kyma, Fiori, walkthroughs, or announces something that changes how developers build.',
    'not-developer-relevant = pure earnings, corporate announcements, non-technical partnerships, HR, awards, marketing.',
    'Respond with ONLY a JSON object of the shape {"verdict":"relevant"|"not-relevant","reason":"<one sentence>"}. No prose.',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: rubric },
      { role: 'user', content: `Source: ${sourceType}\nTitle: ${title}\nDescription: ${description ?? ''}` },
    ],
    templating: { response_format: { type: 'json_object' } },
  };
}

async function llmClassify({ title, description, sourceType }) {
  const settings = await resolveChatLlmSettings();
  if (!settings?.deploymentId) throw new Error('no chat deployment configured');

  // Mirror the pattern from category-classifier-llm.js: promptTemplating config
  // in the constructor, deploymentId as second arg.
  const client = new OrchestrationClient(
    {
      llm: {
        model_name: settings.modelName ?? 'gpt-4o-mini',
        model_params: { max_tokens: 200, temperature: 0 },
      },
    },
    { deploymentId: settings.deploymentId },
  );

  const payload = buildLlmPrompt({ title, description, sourceType });
  const response = await client.chatCompletion(payload);

  const raw = typeof response.getContent === 'function'
    ? response.getContent()
    : String(response?.content ?? '');

  const parsed = parseLlmVerdict(raw);
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    source: 'llm',
    confidence: 0.75,
    model: settings.deploymentId,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a candidate item for developer relevance.
 *
 * Embedding-first: cosine similarity vs. seed exemplars decides immediately
 * when the margin is large enough. Mid-band triggers an LLM call. Any
 * failure in the embedding/LLM path falls back to keyword rules — this
 * function never throws.
 *
 * @param {{title: string, description?: string|null, sourceType: string}} args
 *   sourceType is threaded into the LLM prompt only; scoring is identical
 *   regardless of value ('sap-news' | 'community-blog-post').
 * @returns {Promise<{
 *   verdict: 'relevant'|'not-relevant',
 *   reason: string,
 *   source: 'embedding'|'llm'|'fallback-keyword',
 *   confidence: number,
 *   model: string,
 *   error?: string|null,
 * }>}
 */
export async function classify({ title, description, sourceType }) {
  // ── Step 1: load seeds + embed item ──────────────────────────────────────
  let seeds, itemVec;
  try {
    seeds = await getSeedEmbeddings();

    // Short-circuit: if either seed side is empty, embedding scoring is
    // meaningless — fall back immediately without calling embed().
    if (seeds.relevant.length === 0 || seeds.notRelevant.length === 0) {
      LOG.info(
        `empty seed side (rel=${seeds.relevant.length}, not=${seeds.notRelevant.length}); keyword fallback`,
      );
      return keywordFallback({ title, description, error: new Error('empty seeds') });
    }

    const text = `${title}\n\n${description ?? ''}`;
    const [vec] = await embed([text]);
    itemVec = vec;
  } catch (e) {
    LOG.warn(`embedding path failed: ${e.message}; keyword fallback`);
    return keywordFallback({ title, description, error: e });
  }

  // ── Step 2: score ─────────────────────────────────────────────────────────
  const relevantScore = maxCosine(itemVec, seeds.relevant);
  const notScore      = maxCosine(itemVec, seeds.notRelevant);
  const margin        = relevantScore - notScore;
  const threshold     = await readMargin();

  // ── Step 3: decide ────────────────────────────────────────────────────────
  if (margin >= threshold) {
    return {
      verdict: 'relevant',
      reason: `Embedding cosine margin ${margin.toFixed(3)} ≥ ${threshold.toFixed(3)}`,
      source: 'embedding',
      confidence: Math.min(1, margin),
      model: DEFAULT_EMBEDDING_MODEL,
    };
  }
  if (margin <= -threshold) {
    return {
      verdict: 'not-relevant',
      reason: `Embedding cosine margin ${margin.toFixed(3)} ≤ -${threshold.toFixed(3)}`,
      source: 'embedding',
      confidence: Math.min(1, Math.abs(margin)),
      model: DEFAULT_EMBEDDING_MODEL,
    };
  }

  // ── Step 4: LLM fallback for mid-band ────────────────────────────────────
  const budget = await reserveLlmBudget();
  if (!budget.granted) {
    return keywordFallback({ title, description, error: new Error('LLM daily budget exhausted') });
  }
  try {
    return await llmClassify({ title, description, sourceType });
  } catch (e) {
    LOG.warn(`LLM fallback failed (${e.message}); keyword fallback`);
    return keywordFallback({ title, description, error: e });
  }
}
