// srv/lib/category-classifier.js
//
// Decision tree:
//   embedding path → if top match passes HIGH_THRESHOLD AND top-1 vs top-2
//                    gap >= AMBIGUITY_GAP → use it
//   else LLM path → call category-classifier-llm; on failure → skip
//   persist: BEGIN TX → DELETE existing rows for (kind,id) → INSERT new rows → COMMIT
//
// Tunables:
//   HIGH_THRESHOLD     0.32  (calibrated for text-embedding-3-small, 1536-dim)
//   AMBIGUITY_GAP      0.05
//   MAX_CATEGORIES     3

import cds from '@sap/cds';
import { getSeedEmbeddings, embedAdHoc } from './category-seed-embeddings.js';
import { classifyViaLlm } from './category-classifier-llm.js';

const LOG = cds.log('category-classifier');

export const HIGH_THRESHOLD = 0.32;
export const AMBIGUITY_GAP = 0.05;
export const MAX_CATEGORIES = 3;

const KIND_TO_ENTITY = {
  mission:  { itemEntity: 'Missions',  junction: 'MissionCategories',  fk: 'mission_ID'  },
  group:    { itemEntity: 'Groups',    junction: 'GroupCategories',    fk: 'group_ID'    },
  tutorial: { itemEntity: 'Tutorials', junction: 'TutorialCategories', fk: 'tutorial_ID' },
};

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

async function loadItemText(kind, id) {
  const cfg = KIND_TO_ENTITY[kind];
  if (!cfg) throw new Error(`Unknown kind: ${kind}`);
  const ent = cds.entities('com.sap.developers.ims')[cfg.itemEntity];
  const [row] = await SELECT.from(ent)
    .columns('ID', 'title', 'description', 'primaryTag')
    .where({ ID: id });
  if (!row) return null;
  return {
    raw: row,
    text: [row.title, row.description, row.primaryTag].filter(Boolean).join('\n'),
  };
}

async function loadTaxonomy() {
  const { Categories } = cds.entities('com.sap.developers.ims');
  return SELECT.from(Categories).columns('ID', 'slug', 'label', 'sortOrder');
}

function rankByCosine(itemVec, seedMap, taxonomy) {
  const taxByID = new Map(taxonomy.map(t => [t.ID, t]));
  const scored = [];
  for (const [catId, seedVec] of seedMap.entries()) {
    const meta = taxByID.get(catId);
    if (!meta) continue;
    scored.push({
      ID:        catId,
      slug:      meta.slug,
      sortOrder: meta.sortOrder ?? 100,
      score:     cosine(itemVec, seedVec),
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.sortOrder - b.sortOrder));
  return scored;
}

function pickEmbeddingResult(scored) {
  if (scored.length === 0) return null;
  const top = scored[0];
  if (top.score < HIGH_THRESHOLD) return null;
  if (scored.length >= 2 && (top.score - scored[1].score) < AMBIGUITY_GAP) return null;
  return scored
    .filter(s => s.score >= HIGH_THRESHOLD)
    .slice(0, MAX_CATEGORIES)
    .map(s => ({
      ID:    s.ID,
      slug:  s.slug,
      score: Math.round(s.score * 10000) / 10000,
    }));
}

async function persist(kind, itemId, assigned) {
  const cfg = KIND_TO_ENTITY[kind];
  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(cfg.junction).where({ [cfg.fk]: itemId }));
    if (assigned.length === 0) return;
    const rows = assigned.map(a => ({
      [cfg.fk]:    itemId,
      category_ID: a.ID,
      score:       a.score ?? 1.0,
    }));
    await tx.run(INSERT.into(cfg.junction).entries(rows));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single item (mission / group / tutorial) and persist the results.
 *
 * @param {'mission'|'group'|'tutorial'} kind
 * @param {string} id   - UUID of the item.
 * @param {object} [_opts] - Reserved for future tunables.
 * @returns {Promise<{
 *   kept:     number,
 *   assigned: Array<{slug:string, score:number}>,
 *   path:     'embedding'|'llm'|'skip',
 * }>}
 */
export async function classifyAndPersist(kind, id, _opts = {}) {
  // 1. Load the item text.
  const item = await loadItemText(kind, id);
  if (!item) {
    LOG.warn(`classifyAndPersist: ${kind}/${id} not found`);
    return { kept: 0, assigned: [], path: 'skip' };
  }

  // 2. Load taxonomy.
  const taxonomy = await loadTaxonomy();
  if (taxonomy.length === 0) {
    LOG.warn('No categories in taxonomy — skipping classify');
    return { kept: 0, assigned: [], path: 'skip' };
  }

  let path = 'embedding';
  let assigned = null;

  // 3. Embedding path.
  try {
    const seedMap = await getSeedEmbeddings();
    const itemVec = await embedAdHoc(item.text);
    const scored = rankByCosine(itemVec, seedMap, taxonomy);
    const pick = pickEmbeddingResult(scored);
    if (pick) assigned = pick;
  } catch (e) {
    LOG.warn(`embedding path failed for ${kind}/${id}: ${e.message}`);
  }

  // 4. LLM fallback if embedding path didn't produce a result.
  if (!assigned) {
    path = 'llm';
    try {
      const { assigned: llmAssigned } = await classifyViaLlm({
        title:       item.raw.title,
        description: item.raw.description,
        tagSlugs:    item.raw.primaryTag ? [item.raw.primaryTag] : [],
        taxonomy:    taxonomy.map(t => ({ slug: t.slug, label: t.label })),
      });
      const idBySlug = new Map(taxonomy.map(t => [t.slug, t.ID]));
      assigned = llmAssigned
        .filter(a => idBySlug.has(a.slug))
        .slice(0, MAX_CATEGORIES)
        .map(a => ({
          ID:    idBySlug.get(a.slug),
          slug:  a.slug,
          score: Math.round(a.confidence * 10000) / 10000,
        }));
    } catch (e) {
      LOG.warn(`LLM path failed for ${kind}/${id}: ${e.message}`);
      assigned = null;
    }
  }

  // 5. If both paths failed, skip.
  if (!assigned) {
    return { kept: 0, assigned: [], path: 'skip' };
  }

  // 6. Persist: delete + insert in one transaction.
  await persist(kind, id, assigned);

  return {
    kept:     1,
    assigned: assigned.map(a => ({ slug: a.slug, score: a.score })),
    path,
  };
}
