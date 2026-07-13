// srv/lib/mcp-kg-tools.js
// Phase 3 (#1106) — KG deep-dive MCP tool handlers.
// Registered onto KnowledgeGraphService via this.on() in knowledge-graph-service.js.
import cds from '@sap/cds';
import { clampLimit } from './mcp-arg-validators.js';
const log = cds.log('mcp-kg');
const { SELECT } = cds.ql;

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

/**
 * kg_search_concepts — free-text concept + tutorial search. Delegates to the
 * anonymous-safe searchKG action (same seed/walk/hydrate the palette uses),
 * which bridges on-demand extraction (#948) only when KG_ONDEMAND_ENABLED.
 * Fail-open -> empty result.
 */
export async function handleSearchConcepts(req) {
  const term = (req.data.query ?? '').trim();
  if (!term) return { concepts: [], tutorials: [] };
  const maxConcepts = clampLimit(req.data.maxConcepts, 25, 25);
  const maxTutorials = clampLimit(req.data.maxTutorials, 10, 25);
  try {
    const r = await this.send('searchKG', { term, maxConcepts, maxTutorials });
    return { concepts: r?.concepts ?? [], tutorials: r?.tutorials ?? [] };
  } catch (e) {
    log.error(`kg_search_concepts(${term}) failed — ${e.message ?? e}`);
    return { concepts: [], tutorials: [] };
  }
}

/**
 * kg_community — read-only surfacing of a Louvain community (#917). `id` is the
 * community FINGERPRINT (communityFingerprint = SHA-256 of sorted member slugs),
 * NOT the volatile Louvain communityId which reshuffles nightly. Returns member
 * tutorial slugs, the LLM-generated cluster label (#1126), and whether the
 * community has been promoted to a mission (#986). DEV-only data until the
 * promotion flow reaches PROD. Fail-open.
 *
 * Column notes (real schema, not the brief's draft column names):
 *   KgCommunity.slug        — tutorial identifier (no title column)
 *   KgCommunity.vertexType  — filter to 'tutorial' for member tutorials
 *   KgCommunityLabel.label  — keyed by communityFingerprint
 *   Missions.sourceKgCommunityFingerprint — links a promoted mission to a community
 *
 * slug-as-title: KgCommunity has no title column; `title` field mirrors `slug`
 * for v1 (acceptable per brief: "slug-as-title is acceptable for v1").
 */
export async function handleCommunity(req) {
  const fp = (req.data.id ?? '').trim();
  const shell = { communityId: fp, label: null, memberTutorials: [], size: 0, promotedToMissionSlug: null };
  if (!fp) return shell;
  const db = req._db ?? cds.db;
  const { KgCommunity, KgCommunityLabel, Missions } = cds.entities('com.sap.developers.ims');
  try {
    const members  = await db.run(SELECT.from(KgCommunity).where({ communityFingerprint: fp, vertexType: 'tutorial' }));
    const labelRow = await db.run(SELECT.one.from(KgCommunityLabel).where({ communityFingerprint: fp }));
    const mission  = await db.run(SELECT.one.from(Missions).columns('slug').where({ sourceKgCommunityFingerprint: fp }));
    return {
      communityId:          fp,
      label:                labelRow?.label ?? null,
      memberTutorials:      members.map((m) => ({ slug: m.slug, title: m.slug })),
      size:                 members.length,
      promotedToMissionSlug: mission?.slug ?? null,
    };
  } catch (e) {
    log.error(`kg_community(${fp}) failed — ${e.message ?? e}`);
    return shell;
  }
}
