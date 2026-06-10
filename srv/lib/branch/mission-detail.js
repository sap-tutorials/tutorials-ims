// srv/lib/branch/mission-detail.js
//
// /build/mission/:slug — auth-aware mission catalog with alt-group recommendations.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.2.1, §5.6

import cds from '@sap/cds';
import { pickBranch } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState, fingerprintUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';
import { slugifyKey } from './slug-key.js';

const LOG = cds.log('build-mission-detail');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1024;
const cache = new Map(); // key → { value, at }

export function __resetCacheForTest() { cache.clear(); }

export async function missionDetailHandler(req, res) {
  const slug = (req.params.slug || '').toLowerCase();
  const noCache = req.query?.nocache === '1' || req.query?.nocache === 'true';
  const user = req.user?.id && req.user.id !== 'anonymous' ? req.user : null;

  try {
    const { ChatSettings, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
    const flagOn = !!settings?.branchingEnabled;

    const mission = await SELECT.one.from(Missions).where({ slug });
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });

    const paths = await SELECT.from(CompletionPaths).where({ mission_ID: mission.ID });
    if (paths.length === 0) return res.json({ missionSlug: slug, items: [] });

    // For v1 we render the FIRST path only (matches today's mission-side-nav rendering).
    const path = paths[0];
    const items = await SELECT.from(CompletionPathItems)
      .where({ path_ID: path.ID })
      .orderBy('itemOrder');

    const tutorialById = await loadTutorialMap(Tutorials, items);

    // Build userState only when the flag is on; anonymous still gets userState (empty).
    let userState = null;
    let cacheKey = null;
    let loaders = null;
    if (flagOn) {
      loaders = makeBranchLoaders();
      userState = await buildUserState(user, loaders);
      cacheKey = `${slug}:${user?.id || 'anon'}:${fingerprintUserState(userState)}`;
      if (!noCache) {
        const hit = cache.get(cacheKey);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.value);
      }
    }

    const out = { missionSlug: slug, items: [] };

    // Group items by (altGroupKey, itemOrder). Linear backbone items have key=null.
    const grouped = groupByAlt(items);

    for (const g of grouped) {
      if (g.altGroupKey == null) {
        const item = g.items[0];
        const tut = tutorialById.get(item.tutorial_ID);
        out.items.push({ type: 'tutorial', slug: tut?.slug || null, title: tut?.title || null });
        continue;
      }

      const branches = g.items.map(i => {
        const tut = tutorialById.get(i.tutorial_ID);
        return {
          key: slugifyKey(i.altGroupLabel),
          label: i.altGroupLabel,
          condition: i.altCondition || null,
          embeddingHint: tut?.slug || null,
          tutorialSlug: tut?.slug || null,
          tutorialTitle: tut?.title || null,
        };
      });

      const altGroupRecord = {
        type: 'altGroup',
        groupKey: g.altGroupKey,
        // Don't leak embeddingHint downstream
        branches: branches.map(({ embeddingHint, ...keep }) => keep),
      };

      if (flagOn) {
        const branchPoint = { id: `${slug}:${g.altGroupKey}:${g.items[0].itemOrder}`, surface: 'missionAltGroup', branches };
        const decision = await pickBranch(branchPoint, userState, { missionSlug: slug }, {
          rankBranches: (bp, st, ctx) => rankBranches(bp, st, ctx, loaders),
        });
        altGroupRecord.recommendation = {
          picked: decision.picked,
          reason: decision.reason,
          confidence: decision.confidence,
        };
        await writeBranchDecision({
          user, slug, branchPointId: branchPoint.id, decision,
          surface: 'missionAltGroup', source: 'pageLoad',
        });
      }

      out.items.push(altGroupRecord);
    }

    if (cacheKey && !noCache) storeCache(cacheKey, out);
    res.json(out);

  } catch (err) {
    LOG.error('missionDetailHandler', err);
    res.status(500).json({ error: 'mission_detail_failed' });
  }
}

async function loadTutorialMap(Tutorials, items) {
  const ids = [...new Set(items.map(i => i.tutorial_ID).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await SELECT.from(Tutorials).columns('ID', 'slug', 'title').where({ ID: { in: ids } });
  return new Map(rows.map(t => [t.ID, t]));
}

function groupByAlt(items) {
  const out = [];
  const seenKey = new Map(); // `${order}:${altKey}` → groupIndex
  for (const it of items) {
    if (!it.altGroupKey) {
      out.push({ altGroupKey: null, itemOrder: it.itemOrder, items: [it] });
      continue;
    }
    const k = `${it.itemOrder}:${it.altGroupKey}`;
    if (seenKey.has(k)) {
      out[seenKey.get(k)].items.push(it);
    } else {
      seenKey.set(k, out.length);
      out.push({ altGroupKey: it.altGroupKey, itemOrder: it.itemOrder, items: [it] });
    }
  }
  return out;
}

async function writeBranchDecision({ user, slug, branchPointId, decision, surface, source }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface,
      missionSlug: slug,
      tutorialSlug: null,
      branchPointId,
      recommendedKey: decision.picked,
      chosenKey: null,
      recommendationKind: decision.reason.kind,
      confidence: decision.confidence,
      source,
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions write failed: ${err.message}`);
  }
}

function storeCache(key, value) {
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
