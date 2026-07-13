// srv/lib/mcp-kg-tools.js
// Phase 3 (#1106) — KG deep-dive MCP tool handlers.
// Registered onto KnowledgeGraphService via this.on() in knowledge-graph-service.js.
import cds from '@sap/cds';
const log = cds.log('mcp-kg');

/**
 * kg_shared_concepts — concept overlap between two tutorials.
 * Intersects each tutorial's `teaches` arm (from neighborhood()) by conceptSlug.
 * `this` is the KnowledgeGraphService (bound via this.on). Fail-open → [].
 */
export async function handleSharedConcepts(req) {
  const a = (req.data.slug_a ?? '').toLowerCase();
  const b = (req.data.slug_b ?? '').toLowerCase();
  if (!a || !b) return [];
  try {
    const [nbA, nbB] = await Promise.all([
      this.send('neighborhood', { slug: a }),
      this.send('neighborhood', { slug: b }),
    ]);
    const bByslug = new Map((nbB?.teaches ?? []).map((c) => [c.slug, c]));
    const seen = new Set();
    const out = [];
    for (const c of nbA?.teaches ?? []) {
      const match = bByslug.get(c.slug);
      if (!match || seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push({ conceptSlug: c.slug, name: c.title ?? c.name ?? c.slug });
    }
    return out;
  } catch (e) {
    log.error(`kg_shared_concepts(${a},${b}) failed — ${e.message ?? e}`);
    return [];
  }
}

const EMPTY_NB = { prerequisites: [], whatToLearnNext: [], sharedConcepts: [], teaches: [] };

/**
 * kg_neighborhood — full graph neighborhood (all arms). PageRank-blended
 * (#916) and isolated-flagged (#918) inside neighborhoodFull; this projects
 * the arms and normalizes `isolated` to a boolean. Fail-open -> empty arms.
 */
export async function handleNeighborhood(req) {
  const slug = (req.data.slug ?? '').toLowerCase();
  const depth = Math.min(Math.max(req.data.depth ?? 10, 1), 50);
  if (!slug) return { ...EMPTY_NB };
  const norm = (arm) => (arm ?? []).slice(0, depth).map((i) => ({
    slug: i.slug, title: i.title ?? i.slug, score: i.score ?? 0, isolated: i.isolated === true,
  }));
  try {
    const nb = await this.send('neighborhoodFull', { slug });
    return {
      prerequisites:   norm(nb?.prerequisitesOf),
      whatToLearnNext: norm(nb?.whatToLearnNext),
      sharedConcepts:  norm(nb?.sharedConcepts),
      teaches:         norm(nb?.teaches),
    };
  } catch (e) {
    log.error(`kg_neighborhood(${slug}) failed — ${e.message ?? e}`);
    return { ...EMPTY_NB };
  }
}
