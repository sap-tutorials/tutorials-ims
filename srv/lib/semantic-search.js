// srv/lib/semantic-search.js
//
// #2246 — public, anonymous semantic/vector search core.
//
// Contract (non-negotiable): the caller sends TEXT. The server embeds it
// server-side (once per query, cached), runs cosine similarity over the stored
// Vector(1536) embeddings, and returns scored CONTENT REFERENCES only. It never
// returns raw embedding vectors and never accepts a caller-supplied vector.
//
// Three corpora, all direct cosine over a stored Vector(1536):
//   - tutorials → TutorialEmbedding (joined to Tutorials for slug/title)
//   - concepts  → Concepts.embeddingVec (reuses topConceptsByCosine)
//   - external  → ApiDocs + Samples embeddingVec (the "external embedding corpus")
//   - all       → union of the above, re-ranked and sliced to topK globally.
//
// Dual dialect, mirroring srv/lib/embedding-query.js:
//   - HANA: raw db.run() with the native COSINE_SIMILARITY scalar. Raw SQL (not
//     CDS QL) so we can SELECT the NCLOB text column alongside the cosine scalar
//     without tripping LOB-locator expiry (the vector column is only READ by the
//     scalar, never SELECTed into the result). Identifiers are quoted-uppercase.
//   - SQLite (unit tests): fetch rows via CDS QL and rank in JS.
//
// The whole surface fails open: any corpus that errors contributes [] rather
// than throwing, so a backfill gap or DB hiccup degrades results instead of
// 500ing an anonymous client. The service-layer feature gate (503 when off) and
// rate limiting live in srv/search-service.js.

import crypto from 'node:crypto';
import cds from '@sap/cds';
import { embed as defaultEmbed } from './embedding-client.js';
import { topConceptsByCosine } from './kg/concept-embedding-query.js';

const LOG = cds.log('semantic-search');

export const VALID_CORPORA = Object.freeze(['tutorials', 'concepts', 'external', 'all']);
export const DEFAULT_CORPUS = 'tutorials';
export const TOPK_MIN = 1;
export const TOPK_MAX = 50;
const SNIPPET_LEN = 240;

// Query-embedding cache TTL: 30 min (same as tutorial-step-slicer). Keyed on
// sha256(model + query) so identical text never re-embeds — the point of the
// cache is to spare the AI Core call, which is the expensive part.
const CACHE_TTL_MS = 30 * 60 * 1000;

// ---- Test hooks -----------------------------------------------------------
// The injected embed fn and query-cache handle live on globalThis (keyed by a
// Symbol), not in module-level `let`s: under Windows Vitest the served
// SearchService and a test's own `import` of this module can resolve to TWO
// instances, so a module-level _embedFn set by the test would never reach the
// served handler's copy. globalThis is the one shared singleton across both
// (same reasoning as the caches in search-service.js).
const _testState = (globalThis[Symbol.for('ims.semanticSearch.testState')] ??= {
  embedFn: null,
  cachePromise: undefined,
});
/** Inject a fake embed() for unit tests (returns [Float32Array]). */
export function _setTestEmbedClient(fn) { _testState.embedFn = fn; }
/** Reset module state — test-only. */
export function _resetForTest() { _testState.embedFn = null; _testState.cachePromise = undefined; }
function embedFn() { return _testState.embedFn || defaultEmbed; }

// ---- Query-embedding cache ------------------------------------------------
function cache() {
  if (_testState.cachePromise === undefined) {
    // Memoized connection to the shared caching service (cds-caching, #1180).
    // Never let a missing/failed caching service break search — fall back to
    // embedding on every call.
    _testState.cachePromise = cds.connect.to('caching').catch((err) => {
      LOG.warn('caching service unavailable; query embeddings will not be cached', err.message);
      return null;
    });
  }
  return _testState.cachePromise;
}

function queryKey(query, model) {
  const h = crypto.createHash('sha256').update(`${model}::${query}`).digest('hex');
  return `semq:${h}`;
}

/**
 * Embed `query` once, cached by hash(query+model). Returns a Float32Array, or
 * null when the embed produced nothing (empty input handled upstream).
 */
async function getQueryEmbedding(query, model) {
  const key = queryKey(query, model);
  const c = await cache();
  if (c) {
    try {
      const hit = await c.get(key);
      if (Array.isArray(hit) && hit.length) return Float32Array.from(hit);
    } catch (err) { LOG.warn('query-embedding cache get failed', err.message); }
  }
  const [vec] = await embedFn()([query], model);
  if (!vec) return null;
  if (c) {
    try { await c.set(key, Array.from(vec), { ttl: CACHE_TTL_MS }); }
    catch (err) { LOG.warn('query-embedding cache set failed', err.message); }
  }
  return vec instanceof Float32Array ? vec : Float32Array.from(vec);
}

// ---- Math / decode helpers ------------------------------------------------
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Decode a stored embedding → Float32Array. Handles every shape the two
 *  dialects surface: a Buffer / Uint8Array; a base64 string (HANA, and SQLite
 *  LOBs read via raw db.run); and the `{"type":"Buffer","data":[...]}` JSON
 *  string that @cap-js/sqlite returns when a Vector column is read via CDS QL. */
function decodeF32(buf) {
  if (!buf) return null;
  let bytes;
  if (Buffer.isBuffer(buf)) bytes = buf;
  else if (buf instanceof Uint8Array) bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  else if (typeof buf === 'string') {
    if (buf.charCodeAt(0) === 0x7b /* '{' */) {
      // CDS-QL-serialized Vector column: {"type":"Buffer","data":[...]}.
      try {
        const parsed = JSON.parse(buf);
        if (parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)) bytes = Buffer.from(parsed.data);
      } catch { /* fall through to base64 */ }
    }
    if (!bytes) bytes = Buffer.from(buf, 'base64');
  } else return null;
  if (bytes.length < 4 || bytes.length % 4 !== 0) return null;
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana' || db?.constructor?.name === 'HANAService';
}

// TO_REAL_VECTOR(?) accepts a JSON-array string literal; 6-decimal precision is
// below Float32 but well above cosine sensitivity (see concept-embedding-query.js).
function hanaVecStr(q) { return '[' + Array.from(q, (x) => x.toFixed(6)).join(',') + ']'; }

// ---- Per-corpus retrieval -------------------------------------------------
async function searchTutorials({ db, qVec, model, topK }) {
  try {
    if (isHana(db)) {
      const sql = `
        SELECT TOP ${topK}
          e."STEPNUMBER", e."STEPTEXT",
          t."SLUG" AS "slug", t."TITLE" AS "title",
          COSINE_SIMILARITY(e."EMBEDDING", TO_REAL_VECTOR(?)) AS "score"
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" e
        JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = e."TUTORIAL_ID"
        WHERE e."EMBEDDINGMODEL" = ?
        ORDER BY "score" DESC`;
      const rows = await db.run(sql, [hanaVecStr(qVec), model]);
      return (rows || []).map((r) => shapeTutorial(
        r.slug ?? r.SLUG, r.title ?? r.TITLE,
        r.STEPNUMBER ?? r.stepNumber, r.STEPTEXT ?? r.stepText, r.score ?? r.SCORE));
    }
    // SQLite: fetch model rows + tutorial index, rank in JS.
    const { TutorialEmbedding, Tutorials } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialEmbedding)
      .columns('tutorial_ID', 'stepNumber', 'stepText', 'embedding')
      .where({ embeddingModel: model });
    const tIndex = await SELECT.from(Tutorials).columns('ID', 'slug', 'title');
    const tMap = new Map(tIndex.map((t) => [t.ID, t]));
    return (rows || []).map((r) => {
      const v = decodeF32(r.embedding);
      if (!v) return null;
      const t = tMap.get(r.tutorial_ID) || {};
      return shapeTutorial(t.slug, t.title, r.stepNumber, r.stepText, cosine(v, qVec));
    }).filter(Boolean);
  } catch (err) {
    LOG.warn('tutorials corpus failed:', err.message);
    return [];
  }
}

function shapeTutorial(slug, title, stepNumber, stepText, score) {
  const s = (slug || '').toLowerCase();
  return {
    slug: s,
    title: title || '',
    stepNumber: stepNumber ?? null,
    snippet: String(stepText || '').slice(0, SNIPPET_LEN),
    score: Number(score) || 0,
    url: s ? `/tutorials/${s}` : '',
    contentType: 'tutorial',
  };
}

async function searchConcepts({ db, qVec, topK }) {
  try {
    const top = await topConceptsByCosine({ db, queryVector: qVec, limit: topK });
    if (!top.length) return [];
    // Hydrate descriptions (scalar String(500), not a LOB) by ID — cheap,
    // dialect-safe, and keeps the cosine query free of extra columns.
    const ids = top.map((c) => c.id);
    let descMap = new Map();
    try {
      const { Concepts } = cds.entities('com.sap.developers.ims');
      const meta = await SELECT.from(Concepts).columns('ID', 'description').where({ ID: { in: ids } });
      descMap = new Map(meta.map((m) => [m.ID, m.description]));
    } catch (err) { LOG.warn('concept description hydrate failed:', err.message); }
    return top.map((c) => ({
      slug: c.slug || '',
      title: c.name || '',
      stepNumber: null,
      snippet: String(descMap.get(c.id) || '').slice(0, SNIPPET_LEN),
      score: Number(c.score) || 0,
      url: c.slug ? `/concepts/${c.slug}/` : '',
      contentType: 'concept',
    }));
  } catch (err) {
    LOG.warn('concepts corpus failed:', err.message);
    return [];
  }
}

// External "embedding corpus": ApiDocs + Samples both carry embeddingVec
// (HANA REAL_VECTOR) / embedding (SQLite Float32 BLOB), a public url, and an
// NCLOB description. Each is scanned independently and merged by the caller.
const EXTERNAL_SOURCES = [
  { hanaTable: 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCS', sqliteTable: 'com_sap_developers_ims_external_ApiDocs', contentType: 'api-doc' },
  { hanaTable: 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLES', sqliteTable: 'com_sap_developers_ims_external_Samples', contentType: 'sample' },
];

async function searchExternalSource({ db, qVec, topK, hanaTable, sqliteTable, contentType }) {
  try {
    if (isHana(db)) {
      // Raw SQL so DESCRIPTION (NCLOB) can be selected alongside the cosine
      // scalar; the vector column is only READ by COSINE_SIMILARITY, never
      // SELECTed, so no vector LOB-locator is materialized.
      const sql = `
        SELECT TOP ${topK}
          "SLUG" AS "slug", "TITLE" AS "title", "URL" AS "url", "DESCRIPTION" AS "description",
          COSINE_SIMILARITY("EMBEDDINGVEC", TO_REAL_VECTOR(?)) AS "score"
        FROM "${hanaTable}"
        WHERE "EMBEDDINGVEC" IS NOT NULL
        ORDER BY "score" DESC`;
      const rows = await db.run(sql, [hanaVecStr(qVec)]);
      return (rows || []).map((r) => shapeExternal(
        r.slug ?? r.SLUG, r.title ?? r.TITLE, r.url ?? r.URL,
        r.description ?? r.DESCRIPTION, r.score ?? r.SCORE, contentType));
    }
    // SQLite: raw SQL so the BLOB comes back as a base64 string (CDS QL returns
    // a LOB stream object that can't be decoded synchronously). JS cosine.
    const rows = await db.run(
      `SELECT slug, title, url, description, embedding FROM ${sqliteTable}`,
    );
    return (rows || []).map((r) => {
      const v = decodeF32(r.embedding);
      if (!v) return null;
      return shapeExternal(r.slug, r.title, r.url, r.description, cosine(v, qVec), contentType);
    }).filter(Boolean);
  } catch (err) {
    LOG.warn(`external corpus (${contentType}) failed:`, err.message);
    return [];
  }
}

function shapeExternal(slug, title, url, description, score, contentType) {
  return {
    slug: slug || '',
    title: title || '',
    stepNumber: null,
    snippet: String(description || '').slice(0, SNIPPET_LEN),
    score: Number(score) || 0,
    url: url || '',
    contentType,
  };
}

async function searchExternal({ db, qVec, topK }) {
  const batches = await Promise.all(
    EXTERNAL_SOURCES.map((s) => searchExternalSource({ db, qVec, topK, ...s })),
  );
  return batches.flat();
}

/**
 * Public semantic search over the selected corpus.
 *
 * @param {object} args
 * @param {string} args.query     Free-text query. Empty/whitespace → [].
 * @param {string} [args.corpus]  'tutorials' (default) | 'concepts' | 'external' | 'all'.
 * @param {number} [args.topK]    Clamped to [1, 50]. Default from settings.embeddingTopK (5).
 * @param {number} [args.minScore] Rows scoring strictly below are dropped. Default settings.embeddingMinScore (0.25).
 * @param {object} args.settings  ChatSettings snapshot: { embeddingModel, embeddingTopK, embeddingMinScore }.
 * @returns {Promise<Array<{slug,title,stepNumber,snippet,score,url,contentType}>>}
 *   Sorted by score desc, length ≤ topK, all scores ≥ minScore. Never any vectors.
 */
export async function semanticSearch({ query, corpus, topK, minScore, settings = {} } = {}) {
  if (!query || !query.trim()) return [];
  const text = query.trim();

  const chosen = VALID_CORPORA.includes(corpus) ? corpus : DEFAULT_CORPUS;
  const k = clampTopK(topK ?? settings.embeddingTopK ?? 5);
  const floor = resolveMinScore(minScore ?? settings.embeddingMinScore);
  const model = settings.embeddingModel || 'text-embedding-3-small';

  const qVec = await getQueryEmbedding(text, model);
  if (!qVec) return [];

  const db = cds.db;
  const wanted = chosen === 'all' ? ['tutorials', 'concepts', 'external'] : [chosen];
  const parts = await Promise.all(wanted.map((c) => {
    if (c === 'tutorials') return searchTutorials({ db, qVec, model, topK: k });
    if (c === 'concepts') return searchConcepts({ db, qVec, topK: k });
    if (c === 'external') return searchExternal({ db, qVec, topK: k });
    return Promise.resolve([]);
  }));

  return parts
    .flat()
    .filter((r) => r && r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function clampTopK(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(Math.trunc(n), TOPK_MIN), TOPK_MAX);
}

function resolveMinScore(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.25;
}
