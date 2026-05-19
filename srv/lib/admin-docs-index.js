import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = resolve(__dirname, '../data/admin-docs-index.json');
let _indexPath = DEFAULT_INDEX_PATH;

// Must match scripts/build-admin-docs-index.ts exactly (44 entries).
const STOPWORDS = new Set([
  'the','and','for','with','this','that','from','are','was','were','use','using',
  'can','will','not','but','have','has','had','its','our','your','their','they',
  'them','also','more','than','then','here','there','what','when','where','which',
  'who','whom','how','why','any','all','some','one','two','etc'
]);

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    const parsed = JSON.parse(readFileSync(_indexPath, 'utf8'));
    _cache = Array.isArray(parsed?.docs) ? parsed.docs : [];
  } catch {
    _cache = [];
  }
  return _cache;
}

export function _resetCache() {
  _cache = null;
}

// Test seam: override the file path used by _load(). Resets the cache.
export function _setIndexPath(path) {
  _indexPath = path || DEFAULT_INDEX_PATH;
  _cache = null;
}

function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(t => !STOPWORDS.has(t));
}

export function searchAdminDocs({ query, topN = 5 } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const docs = _load();
  const queryTokenSet = new Set(queryTokens);
  const hits = [];

  for (const doc of docs) {
    let score = 0;
    const headingTokens = Array.isArray(doc.headingTokens) ? doc.headingTokens : [];
    const bodyTokens = Array.isArray(doc.bodyTokens) ? doc.bodyTokens : [];

    for (const t of headingTokens) {
      if (queryTokenSet.has(t)) score += 5;
    }
    for (const t of bodyTokens) {
      if (queryTokenSet.has(t)) score += 1;
    }

    if (score > 0) {
      hits.push({
        id: doc.id,
        path: doc.path,
        heading: doc.heading,
        score,
        snippet: typeof doc.body === 'string' ? doc.body.slice(0, 240) : ''
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topN);
}
