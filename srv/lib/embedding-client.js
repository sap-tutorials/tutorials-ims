import cds from '@sap/cds';
import { AzureOpenAiEmbeddingClient } from '@sap-ai-sdk/foundation-models';

const LOG = cds.log('embedding-client');
const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BACKOFF_MS = 500;

const clientCache = new Map();

function getClient(model) {
  let c = clientCache.get(model);
  if (!c) {
    c = new AzureOpenAiEmbeddingClient(model);
    clientCache.set(model, c);
  }
  return c;
}

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
 * Batches up to 100 per API call. Retries 429/5xx with exponential backoff.
 * Returns `Float32Array[]` aligned with input order.
 */
export async function embed(inputs, model) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const client = getClient(model);
  const out = new Array(inputs.length);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const resp = await callWithRetry(client, batch);
    const data = resp?.data || [];
    for (const item of data) {
      const idx = i + (item.index ?? 0);
      out[idx] = new Float32Array(item.embedding);
    }
  }
  return out;
}
