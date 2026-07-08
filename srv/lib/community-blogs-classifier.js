// srv/lib/community-blogs-classifier.js
//
// (#1033) Drains PENDING CommunityBlogPosts rows through SAP Generative
// AI Hub via `@sap-ai-sdk/orchestration`. Forced tool-call ensures the
// model returns { verdict, confidence, reason } as structured data — no
// JSON.parse on prose. Mirrors the pattern established in
// srv/lib/category-classifier-llm.js.
//
// Retry-once semantics: a PENDING row is drained; on ERROR its
// attemptCount goes to 1 and it's re-picked on the next scheduled run.
// Second ERROR sets attemptCount=2 and the row is sticky until the
// admin fires reclassifyCommunityBlogPost to reset it.
//
// Kill switch: env COMMUNITY_BLOGS_CLASSIFIER_ENABLED=false → no-op.

import cds from '@sap/cds';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
import * as metrics from './metrics.js';

const LOG = cds.log('community-blogs-classifier');

const TOOL_NAME = 'submit_verdict';
const TEMPERATURE = 0;
const MAX_TOKENS = 300;
const DEFAULT_BATCH_LIMIT = 10;

// Load the system prompt once at module init.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'prompts', 'community-blogs-classifier.md'),
  'utf8'
);

/**
 * Check the env kill switch.
 * @returns {boolean}
 */
export function isClassifierEnabled() {
  const v = process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
  // Only the exact literal 'false' disables — undefined / '' / 'true' all enable.
  return v !== 'false';
}

/**
 * The forced-tool definition. The verdict field is an enum so the model
 * cannot hallucinate an unknown category.
 */
const VERDICT_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit the developer-relevance verdict for the blog post.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'confidence', 'reason'],
      properties: {
        verdict:    { type: 'string', enum: ['DEVELOPER_RELEVANT', 'NOT_RELEVANT'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason:     { type: 'string', maxLength: 500 },
      },
    },
  },
};

/**
 * Call the LLM for a single row. Returns the fields to write back on the
 * row. Caller is responsible for the UPDATE. Never throws — errors are
 * captured into aiVerdict='ERROR' with aiReason describing the failure.
 *
 * @param {{title, author, descriptionSnippet, attemptCount}} row
 * @param {{clientOverride?}} [opts] — clientOverride is a test seam
 * @returns {Promise<{aiVerdict, aiReason, aiConfidence, aiClassifiedAt, aiModel, attemptCount}>}
 */
export async function classifyOne(row, opts = {}) {
  const nowIso = new Date().toISOString();
  const nextAttempt = (row.attemptCount ?? 0) + 1;

  let modelName = null;
  let deploymentId = null;
  if (!opts.clientOverride) {
    try {
      ({ modelName, deploymentId } = await resolveChatLlmSettings());
    } catch (err) {
      return {
        aiVerdict:      'ERROR',
        aiReason:       `aicore: ${(err.message || String(err)).slice(0, 200)}`,
        aiConfidence:   null,
        aiClassifiedAt: nowIso,
        aiModel:        null,
        attemptCount:   nextAttempt,
      };
    }
  }

  const client = opts.clientOverride ?? new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            tool_choice: {
              type: 'function',
              function: { name: TOOL_NAME },
            },
          },
        },
        prompt: {
          template: [{ role: 'system', content: SYSTEM_PROMPT }],
          tools: [VERDICT_TOOL],
        },
      },
    },
    { deploymentId }
  );

  const userPrompt =
    `Title: ${row.title || '(no title)'}\n` +
    `Author: ${row.author || '(unknown)'}\n` +
    `Snippet: ${(row.descriptionSnippet || '').replace(/\s+/g, ' ').slice(0, 500)}`;

  let response;
  try {
    response = await client.chatCompletion({
      messagesHistory: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    return {
      aiVerdict:      'ERROR',
      aiReason:       `aicore: ${(err.code || err.message || String(err)).toString().slice(0, 200)}`,
      aiConfidence:   null,
      aiClassifiedAt: nowIso,
      aiModel:        modelName,
      attemptCount:   nextAttempt,
    };
  }

  const toolCalls = response.getToolCalls?.() ?? [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {
      aiVerdict:      'ERROR',
      aiReason:       'parse: no tool call',
      aiConfidence:   null,
      aiClassifiedAt: nowIso,
      aiModel:        modelName,
      attemptCount:   nextAttempt,
    };
  }
  const tc = toolCalls[0];
  const rawArgs = tc.function?.arguments;
  let parsed;
  try {
    parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch (err) {
    return {
      aiVerdict:      'ERROR',
      aiReason:       `parse: ${(err.message || String(err)).slice(0, 200)}`,
      aiConfidence:   null,
      aiClassifiedAt: nowIso,
      aiModel:        modelName,
      attemptCount:   nextAttempt,
    };
  }

  const verdict = parsed?.verdict;
  if (verdict !== 'DEVELOPER_RELEVANT' && verdict !== 'NOT_RELEVANT') {
    return {
      aiVerdict:      'ERROR',
      aiReason:       `parse: bad verdict ${String(verdict).slice(0, 40)}`,
      aiConfidence:   null,
      aiClassifiedAt: nowIso,
      aiModel:        modelName,
      attemptCount:   nextAttempt,
    };
  }

  return {
    aiVerdict:      verdict,
    aiReason:       (parsed.reason || '').toString().slice(0, 1000),
    aiConfidence:   Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    aiClassifiedAt: nowIso,
    aiModel:        modelName,
    attemptCount:   nextAttempt,
  };
}

/**
 * Drain up to `limit` PENDING (or ERROR with attemptCount<2) rows through
 * the classifier. Sequential; each row's UPDATE is committed independently
 * so a mid-batch throw doesn't lose earlier progress.
 *
 * @param {{limit?:number, clientOverride?:object}} [opts]
 * @returns {Promise<{drained:number, ok:number, parseError:number, aicoreError:number, disabled?:boolean}>}
 */
export async function classifyPendingBatch(opts = {}) {
  if (!isClassifierEnabled()) {
    metrics.counter('homepage.community_blogs.classifier[result=disabled]');
    return { drained: 0, ok: 0, parseError: 0, aicoreError: 0, disabled: true };
  }

  const limit = opts.limit
    ?? Number(process.env.COMMUNITY_BLOGS_CLASSIFY_BATCH ?? DEFAULT_BATCH_LIMIT);
  const db = await cds.connect.to('db');
  const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');

  // Two branches for the drain-eligible set:
  //   PENDING regardless of attemptCount
  //   ERROR with attemptCount < 2
  // CDS QL doesn't like an OR of two structured predicates with different
  // shape, so we UNION the two SELECTs by fetching them separately and
  // trimming to `limit`. Both individual queries are safe on HANA + SQLite.
  const pendingRows = await db.run(
    SELECT.from(CommunityBlogPosts)
      .columns('ID', 'title', 'author', 'descriptionSnippet', 'attemptCount', 'aiVerdict', 'publishedAt')
      .where({ aiVerdict: 'PENDING' })
      .orderBy({ publishedAt: 'desc' })
      .limit(limit)
  );
  let rows = pendingRows;
  if (rows.length < limit) {
    const errorRows = await db.run(
      SELECT.from(CommunityBlogPosts)
        .columns('ID', 'title', 'author', 'descriptionSnippet', 'attemptCount', 'aiVerdict', 'publishedAt')
        .where({ aiVerdict: 'ERROR', attemptCount: { '<': 2 } })
        .orderBy({ publishedAt: 'desc' })
        .limit(limit - rows.length)
    );
    rows = rows.concat(errorRows);
  }

  const summary = { drained: 0, ok: 0, parseError: 0, aicoreError: 0 };
  for (const row of rows) {
    summary.drained++;
    let update;
    try {
      update = await classifyOne(row, { clientOverride: opts.clientOverride });
    } catch (err) {
      // classifyOne should never throw — but belt-and-suspenders.
      LOG.warn(`classifyOne threw unexpectedly for row ${row.ID}: ${err.message}`);
      update = {
        aiVerdict:      'ERROR',
        aiReason:       `internal: ${(err.message || String(err)).slice(0, 200)}`,
        aiConfidence:   null,
        aiClassifiedAt: new Date().toISOString(),
        aiModel:        null,
        attemptCount:   (row.attemptCount ?? 0) + 1,
      };
    }
    try {
      await db.run(UPDATE(CommunityBlogPosts).set(update).where({ ID: row.ID }));
    } catch (err) {
      // If we can't even persist the ERROR row, log and move on. Row stays
      // PENDING or in its previous state; will be re-picked next drain.
      LOG.warn(`classify UPDATE failed for row ${row.ID}: ${err.message}`);
      continue;
    }
    if (update.aiVerdict === 'ERROR') {
      if (update.aiReason?.startsWith('parse')) summary.parseError++;
      else summary.aicoreError++;
    } else {
      summary.ok++;
    }
  }

  metrics.counter(
    `homepage.community_blogs.classifier[result=drained,drained=${summary.drained},ok=${summary.ok},parse_error=${summary.parseError},aicore_error=${summary.aicoreError}]`
  );
  return summary;
}
