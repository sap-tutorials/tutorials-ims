// srv/lib/co-completion.js
import cds from '@sap/cds'

let cache = null
let cacheAt = 0
let inflight = null
const TTL_MS = 60 * 60 * 1000 // 1 hour

export async function computeCoCompletions({ topN = 10, force = false } = {}) {
  const now = Date.now()
  if (!force && cache && now - cacheAt < TTL_MS) return cache
  if (!force && inflight) return inflight

  const work = (async () => {
    const { Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims')
    const tutorials = await SELECT.from(Tutorials)
      .columns('legacyId', 'slug')
      .where(`status = 'ACTIVE' or status is null`)
    const slugById = new Map(tutorials.map(t => [t.legacyId, t.slug]).filter(([, s]) => !!s))

    // "Has-ever-completed" semantic (issue #600): SUPERSEDED is a prior
    // completion that was reset, so it still counts. The byUser Set below
    // already dedupes by (user, slug), so re-completions don't inflate pair
    // weight even though both the SUPERSEDED and COMPLETED row come back.
    const records = await SELECT.from(TaskRecords)
      .columns('user_ID', 'taskLegacyId')
      .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } })

    const byUser = new Map()
    for (const r of records) {
      const slug = slugById.get(r.taskLegacyId)
      if (!slug) continue
      if (!byUser.has(r.user_ID)) byUser.set(r.user_ID, new Set())
      byUser.get(r.user_ID).add(slug)
    }

    const pairCounts = new Map()
    for (const slugs of byUser.values()) {
      const arr = [...slugs]
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]]
          const key = `${a}\x1f${b}`
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }

    const out = {}
    for (const [key, score] of pairCounts) {
      const [a, b] = key.split('\x1f')
      if (!out[a]) out[a] = []
      if (!out[b]) out[b] = []
      out[a].push({ slug: b, score })
      out[b].push({ slug: a, score })
    }

    for (const slug of Object.keys(out)) {
      out[slug].sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug))
      out[slug] = out[slug].slice(0, topN)
    }

    cache = out
    cacheAt = Date.now()
    return out
  })()

  if (!force) inflight = work
  try {
    return await work
  } finally {
    if (inflight === work) inflight = null
  }
}

// ── Fast-path reader ──────────────────────────────────────────────────
//
// loadCoCompletionsFor(slug, opts) — reads the pre-materialized CoCompletions
// table (populated nightly by srv/jobs/materialize-co-completions.js) with a
// single indexed SELECT. Cost is O(topN) rows returned; typical latency
// ~10-30ms against HANA vs ~60s for the JIT computeCoCompletions().
//
// Callers get an Array<{slug, score}> already sorted DESC. When the table
// is empty (fresh deploy pre-bootstrap), returns []. The graceful-empty
// path preserves the neighborhood handler's downstream behavior (it treats
// a missing entry as "no co-completion boost").
//
// Note: this is NOT a drop-in replacement for computeCoCompletions() —
// that function returns the ENTIRE map for all slugs. The reader is only
// useful for callers that want ONE slug's neighbors (like neighborhood()).
export async function loadCoCompletionsFor(slug, { topN = 10, db: dbOverride } = {}) {
  if (typeof slug !== 'string' || !slug) return []
  const db = dbOverride ?? await cds.connect.to('db')
  const { CoCompletions } = cds.entities('com.sap.developers.ims')
  try {
    const rows = await SELECT.from(CoCompletions)
      .columns('targetSlug', 'score')
      .where({ sourceSlug: slug })
      .orderBy('score desc')
      .limit(topN)
    return rows.map(r => ({ slug: r.targetSlug ?? r.TARGETSLUG, score: r.score ?? r.SCORE }))
  } catch (err) {
    // Table doesn't exist yet, or transient DB blip — return empty so the
    // caller (typically the neighborhood handler) treats this as "no boost".
    // Aligns with the try/catch guard the handler already wraps around
    // computeCoCompletions at knowledge-graph-service.js:610-616.
    return []
  }
}

export async function coCompletionsHandler(req, res) {
  try {
    const result = await computeCoCompletions()
    res.json(result)
  } catch (err) {
    console.error('[build/co-completions]', err instanceof Error ? err.message : String(err))
    res.status(500).json({ error: 'Co-completion aggregation failed' })
  }
}
