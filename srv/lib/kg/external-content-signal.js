// srv/lib/kg/external-content-signal.js
//
// #1125: external-content retrieval signal for Joule's findRelatedContent tool.
// Reuses computeKgSignal (search-kg-signal.js) — its 5-min LRU + single-flight
// means a findRelatedContent call in the same turn as searchTutorials /
// expandSearchConcepts pays ZERO extra embed. Takes the gated concept set +
// per-concept scores, fetches external links across all 8 link tables, applies
// the same isWithinTTL freshness gate the RDF projection uses, aggregates
// Σ(conceptScore × linkConfidence) per content item, tags each with a trust
// tier, sorts, and caps.
//
// This module NEVER perturbs the tutorial rank blend — it only reads the
// already-computed topConcepts from the shared signal.

import { computeKgSignal } from '../search-kg-signal.js'
import { fetchExternalContentLinks } from './_search-fetches.js'
import { isWithinTTL } from '../external-content-ttl.js'
import cds from '@sap/cds'

const LOG = cds.log('external-content-signal')

const DEFAULT_MAX_ITEMS = 8
const HARD_QUERY_LIMIT = 200

// content_type → trust tier. Community = arbitrary-author / time-sensitive.
const TRUST_TIER = Object.freeze({
  'learning-journey': 'authoritative',
  'blog-post': 'community',
  'discovery-mission': 'authoritative',
  'video': 'authoritative',
  'api-doc': 'authoritative',
  'sample': 'authoritative',
  'help-doc': 'authoritative',
  'community-event': 'community',
})

// content_type is already the PER_TYPE_TTL_DAYS key — the fetch helper emits
// the same kebab keys the TTL table is keyed on, so this is an identity lookup
// guarded to only known types.
function ttlKeyFor(contentType) {
  return contentType in TRUST_TIER ? contentType : null
}

/**
 * @param {object} opts
 * @param {string} opts.phrase
 * @param {object} opts.db
 * @param {object=} opts.embedClient
 * @param {string=} opts.embeddingModel
 * @param {boolean=} opts.enabled
 * @param {number=} opts.timeoutMs
 * @param {string[]=} opts.types
 * @param {number=} opts.maxItems
 * @returns {Promise<{queryEcho:string, externalContent:Array, warning?:string}>}
 */
export async function computeExternalContentSignal({
  phrase, db, embedClient, embeddingModel,
  enabled = true, timeoutMs, types, maxItems = DEFAULT_MAX_ITEMS,
}) {
  const rawQuery = typeof phrase === 'string' ? phrase.trim() : ''
  if (!rawQuery) return { queryEcho: '', externalContent: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) {
    return { queryEcho: rawQuery, externalContent: [], warning: 'query_too_long' }
  }

  const signal = await computeKgSignal({
    phrase: rawQuery, db, embedClient, embeddingModel, enabled, timeoutMs,
  })

  if (signal.warning) {
    return { queryEcho: rawQuery, externalContent: [], warning: signal.warning }
  }
  const concepts = Array.isArray(signal.topConcepts) ? signal.topConcepts : []
  if (concepts.length === 0) {
    return { queryEcho: rawQuery, externalContent: [] }
  }

  const conceptScoreById = new Map(concepts.map((c) => [c.id, c.score]))
  const conceptNameById = new Map(concepts.map((c) => [c.id, c.name]))

  let rows
  try {
    rows = await fetchExternalContentLinks(db, concepts.map((c) => c.id), { types })
  } catch (err) {
    LOG.warn('fetchExternalContentLinks failed', err.message)
    return { queryEcho: rawQuery, externalContent: [], warning: 'db_error' }
  }

  // Aggregate per content item (keyed by content_type + slug).
  const byItem = new Map()
  for (const r of rows) {
    const ttlKey = ttlKeyFor(r.content_type)
    if (!ttlKey) continue
    if (!isWithinTTL(ttlKey, r.last_seen_at, r.end_date ?? null)) continue
    const cs = conceptScoreById.get(r.concept_id) ?? 0
    const contribution = cs * (Number(r.confidence) || 0)
    const key = `${r.content_type}::${r.slug}`
    let bucket = byItem.get(key)
    if (!bucket) {
      bucket = {
        type: r.content_type, title: r.title, url: r.url, slug: r.slug,
        trustTier: TRUST_TIER[r.content_type], score: 0, contribs: [],
      }
      byItem.set(key, bucket)
    }
    bucket.score += contribution
    bucket.contribs.push({ conceptId: r.concept_id, contribution })
  }

  const externalContent = [...byItem.values()]
    .map((b) => {
      const top = b.contribs
        .sort((x, y) => y.contribution - x.contribution)
        .slice(0, 2)
        .map((c) => conceptNameById.get(c.conceptId))
        .filter(Boolean)
      const rationale = top.length === 0 ? ''
        : top.length === 1 ? `Related to ${top[0]}`
        : `Related to ${top[0]} and ${top[1]}`
      return {
        type: b.type, title: b.title, url: b.url, slug: b.slug,
        trustTier: b.trustTier, score: Number(b.score.toFixed(4)), rationale,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)

  return { queryEcho: rawQuery, externalContent }
}
