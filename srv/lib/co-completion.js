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
    const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'slug')
    const slugById = new Map(tutorials.map(t => [t.legacyId, t.slug]).filter(([, s]) => !!s))

    const records = await SELECT.from(TaskRecords)
      .columns('user_ID', 'taskLegacyId')
      .where({ taskType: 'TUTORIAL', status: 'COMPLETED' })

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

export async function coCompletionsHandler(req, res) {
  try {
    const result = await computeCoCompletions()
    res.json(result)
  } catch (err) {
    console.error('[build/co-completions]', err instanceof Error ? err.message : String(err))
    res.status(500).json({ error: 'Co-completion aggregation failed' })
  }
}
