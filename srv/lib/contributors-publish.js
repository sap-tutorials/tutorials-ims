// srv/lib/contributors-publish.js
// Handler for POST /content/publish-contributors.
//
// Bearer auth is delegated to `contentAuthMiddleware` from
// srv/lib/content-store.js — same shape as /content/validate-answer-specs
// and /content/code-check-specs: 503 when CONTENT_API_KEY is unset,
// 401 on missing Bearer header, 403 on wrong key, with timing-safe comparison.
// This handler runs ONLY after auth has succeeded.
//
// Accepts `{ slug, contributors: [{login,name,email,avatarUrl}] }` and
// REPLACE-per-slug: DELETEs all TutorialContributors rows for that tutorial
// then INSERTs the new set atomically inside cds.tx(). Publishing slug A
// never touches slug B's rows.

import cds from '@sap/cds'
import { hashContributors } from './sidecar-hash.js'

const NS = 'com.sap.developers.ims'

// Chunk sizes match the conventions in content-publish-session.js: 500 for
// DELETE ... WHERE tutorial_ID IN (…) (HANA packet cap), 50 for INSERT.entries.
const DELETE_IN_CHUNK = 500
const INSERT_CHUNK = 50

export function githubProfileUrl(login) {
  return login ? `https://github.com/${login}` : null
}

/** Map contributor sidecar rows → DB entries for one tutorial. */
function contributorEntries(tutorialId, contributors) {
  return (contributors || [])
    .filter((c) => c && (c.login || c.name || c.email))
    .slice(0, 10)
    .map((c) => ({
      ID: cds.utils.uuid(),
      tutorial_ID: tutorialId,
      login: (c.login || '').slice(0, 255),
      name: (c.name || '').slice(0, 255),
      email: (c.email || '').slice(0, 255),
      avatarUrl: (c.avatarUrl || '').slice(0, 1024),
      profileUrl: githubProfileUrl(c.login),
    }))
}

/**
 * Core, unit-testable: REPLACE all contributor rows for one slug.
 * @param {object} db  – connected CDS db service (cds.connect.to('db'))
 * @param {string} slug – tutorial slug (case-insensitive)
 * @param {Array}  contributors – array of {login,name,email,avatarUrl}
 */
export async function replaceContributorsForSlug(db, slug, contributors) {
  const { Tutorials, TutorialContributors } = cds.entities(NS)
  const lcSlug = String(slug || '').toLowerCase()
  const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug }))
  if (!tut) return { ok: false, reason: 'tutorial_not_found', slug: lcSlug }

  const entries = contributorEntries(tut.ID, contributors)

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialContributors).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialContributors).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
}

/**
 * Bulk REPLACE for many slugs in one call (#2463). Resolves slug→ID in chunked
 * IN lookups, then DELETEs all touched tutorials' rows and INSERTs the new set
 * — all inside a single cds.tx so a fault rolls the whole batch back. Slugs not
 * found in Tutorials are reported in `notFound` and skipped (never fatal).
 *
 * @param {object} db
 * @param {Array<{slug:string, contributors:Array}>} items
 * @returns {Promise<{ok:true, replaced:number, notFound:string[]}>}
 */
export async function replaceContributorsBulk(db, items) {
  const { Tutorials, TutorialContributors } = cds.entities(NS)
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: true, replaced: 0, notFound: [] }

  // slug (lowercased) → contributors, de-duped (last wins).
  const bySlug = new Map()
  for (const it of list) {
    if (!it || !it.slug) continue
    bySlug.set(String(it.slug).toLowerCase(), it.contributors || [])
  }
  const slugs = [...bySlug.keys()]

  // Resolve slug → ID in chunked IN lookups.
  const idBySlug = new Map()
  for (let i = 0; i < slugs.length; i += DELETE_IN_CHUNK) {
    const chunk = slugs.slice(i, i + DELETE_IN_CHUNK)
    const rows = await db.run(SELECT.from(Tutorials).columns('ID', 'slug').where({ slug: { in: chunk } }))
    for (const r of rows) idBySlug.set(r.slug, r.ID)
  }

  const notFound = slugs.filter((s) => !idBySlug.has(s))
  const foundIds = [...idBySlug.values()]
  if (foundIds.length === 0) return { ok: true, replaced: 0, notFound }

  const allEntries = []
  for (const [slug, id] of idBySlug) {
    for (const e of contributorEntries(id, bySlug.get(slug))) allEntries.push(e)
  }

  await cds.tx(async (tx) => {
    for (let i = 0; i < foundIds.length; i += DELETE_IN_CHUNK) {
      const chunk = foundIds.slice(i, i + DELETE_IN_CHUNK)
      await tx.run(DELETE.from(TutorialContributors).where({ tutorial_ID: { in: chunk } }))
    }
    for (let i = 0; i < allEntries.length; i += INSERT_CHUNK) {
      const batch = allEntries.slice(i, i + INSERT_CHUNK)
      if (batch.length) await tx.run(INSERT.into(TutorialContributors).entries(batch))
    }
  })

  return { ok: true, replaced: idBySlug.size, notFound }
}

/**
 * Compute the canonical {slug: hash} map over ALL stored contributor rows
 * (#2464). One SELECT of every row (login/name/email/avatarUrl + slug via the
 * tutorial association), grouped by slug and hashed with the shared helper so
 * it matches the client's hash of the sidecar JSON byte-for-byte.
 */
export async function contributorHashesBySlug(db) {
  const { TutorialContributors } = cds.entities(NS)
  const rows = await db.run(
    SELECT.from(TutorialContributors)
      .columns('tutorial.slug as slug', 'login', 'name', 'email', 'avatarUrl')
  )
  const bySlug = new Map()
  for (const r of rows) {
    if (!r.slug) continue
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, [])
    bySlug.get(r.slug).push(r)
  }
  const out = {}
  for (const [slug, list] of bySlug) out[slug] = hashContributors(list)
  return out
}

/**
 * Express handler mirroring the validate-answer-specs route shape.
 * Mounted in server.js with contentAuthMiddleware + express.json().
 */
export async function publishContributors(req, res) {
  try {
    const { slug, contributors } = req.body || {}
    if (!slug || !Array.isArray(contributors)) {
      return res.status(400).json({ error: 'bad_request', detail: 'expected { slug, contributors[] }' })
    }

    // entity_not_in_model guard (QA namespace safety — mirrors validate-answer-spec-publish.js).
    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialContributors) {
      return res.status(409).json({ error: 'entity_not_in_model' })
    }

    const db = await cds.connect.to('db')
    const result = await replaceContributorsForSlug(db, slug, contributors)
    if (!result.ok) return res.status(404).json(result)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: e?.message })
  }
}

/**
 * Bulk handler for POST /content/publish-contributors-bulk (#2463).
 * Accepts `{ items: [{ slug, contributors[] }] }`. Same auth + entity guard as
 * the single-slug handler.
 */
export async function publishContributorsBulk(req, res) {
  try {
    const { items } = req.body || {}
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'bad_request', detail: 'expected { items: [{ slug, contributors[] }] }' })
    }

    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialContributors) {
      return res.status(409).json({ error: 'entity_not_in_model' })
    }

    const db = await cds.connect.to('db')
    const result = await replaceContributorsBulk(db, items)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: e?.message })
  }
}

/**
 * Hash-feed handler for GET /content/contributor-hashes (#2464).
 * Public-read (mirrors /content/hashes): returns a `{slug: hash}` map the
 * client diffs against locally-computed sidecar hashes to skip unchanged
 * contributors. `entity_not_in_model` (QA) and any fault fail SOFT to `{}`
 * so the client simply publishes everything (no worse than pre-#2464).
 */
export async function contributorHashesHandler(_req, res) {
  try {
    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialContributors) {
      res.set('Cache-Control', 'no-cache')
      return res.json({})
    }
    const db = await cds.connect.to('db')
    const map = await contributorHashesBySlug(db)
    res.set('Cache-Control', 'no-cache')
    return res.json(map)
  } catch {
    res.set('Cache-Control', 'no-cache')
    return res.json({})
  }
}
