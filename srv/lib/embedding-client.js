// srv/lib/embedding-client.js
//
// Thin wrapper around `@sap-ai-sdk/foundation-models`'
// `AzureOpenAiEmbeddingClient` that adds batching, retry, and per-model
// client caching. Every embedding path in the app funnels through the single
// `embed()` export so batching and retry policy are enforced in one place.
//
// Callers include the RAG pipeline (embedding-pipeline.js,
// embedding-query.js), the concept-extraction cron
// (srv/lib/kg-merge-on-write.js via extract-concepts-job.js), and the
// category classifier (category-seed-embeddings.js). Because Node is
// single-threaded, the module-level `clientCache` needs no synchronization
// even when multiple async callers race.

import cds from '@sap/cds';
import { AzureOpenAiEmbeddingClient } from '@sap-ai-sdk/foundation-models';

const LOG = cds.log('embedding-client');
// Batch cap chosen to sit under the SAP AI Core embedding endpoint's
// per-request limit while still amortizing HTTP overhead across many inputs.
const BATCH_SIZE = 100;
// Retry policy: at most three attempts total (initial + 2 retries) with
// exponential backoff. Deliberately short-lived — the caller (cron/handler)
// owns overall timeout and can retry the entire operation on a later tick.
const MAX_RETRIES = 3;
const BACKOFF_MS = 500;

// Per-model client cache. AzureOpenAiEmbeddingClient is cheap to construct
// but each instance holds its own connection pool; reusing avoids TLS
// handshake churn during a long extract-concepts run.
const clientCache = new Map();

/** Get (or lazily create) the SDK client for `model`. */
function getClient(model) {
  let c = clientCache.get(model);
  if (!c) {
    c = new AzureOpenAiEmbeddingClient(model);
    clientCache.set(model, c);
  }
  return c;
}

/**
 * Only retry transient failures. 429 (rate limit) and 5xx (upstream fault)
 * are retryable; 4xx other than 429 (bad request, auth) are not — retrying
 * would waste quota and hide bugs.
 */
function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Invoke the SDK with retry. Non-retryable errors throw immediately;
 * retryable errors sleep `BACKOFF_MS * 2^attempt` between tries. After
 * `MAX_RETRIES` the last error is re-thrown so the caller can log/skip.
 */
async function callWithRetry(client, batch) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.run({ input: batch });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      const delay = BACKOFF_MS * Math.pow(2, attempt);
      LOG.warn(`embedding call failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Embed an array of input strings via SAP Generative AI Hub.
 *
 * Batches into groups of `BATCH_SIZE` (100) and calls the AI Core embedding
 * endpoint for each batch with retry on 429/5xx. The output array is
 * position-aligned with `inputs` — index `i` of the returned array is the
 * embedding for `inputs[i]`. A batch that returns a partial result throws
 * (length mismatch check) so the caller never sees silent misalignment.
 *
 * Empty input short-circuits to `[]` without contacting AI Core.
 *
 * Embedding dimensionality is determined by the model (e.g.
 * `text-embedding-3-small` → 1536). Callers that mix models across writes
 * must also filter by `embeddingModel` on read (see embedding-query.js).
 *
 * @param {string[]} inputs - Strings to embed.
 * @param {string} model - AI Core model deployment name.
 * @returns {Promise<Float32Array[]>} Embeddings aligned with `inputs`.
 * @throws When a non-retryable HTTP error occurs, when retries are exhausted
 *   on a retryable error, or when a batch returns fewer items than sent.
 */
export async function embed(inputs, model) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const client = getClient(model);
  const out = new Array(inputs.length);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const resp = await callWithRetry(client, batch);
    const embeddings = resp.getEmbeddings();
    if (embeddings.length !== batch.length) {
      throw new Error(`embedding batch returned ${embeddings.length}/${batch.length} items at offset ${i}`);
    }
    for (let j = 0; j < embeddings.length; j++) {
      out[i + j] = new Float32Array(embeddings[j]);
    }
  }
  return out;
}
