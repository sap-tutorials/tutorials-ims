// srv/lib/validation-rules-publish.js
// Handler for POST /content/publish-validation-rules.
//
// Bearer auth is delegated to `contentAuthMiddleware` from
// srv/lib/content-store.js — same shape as /content/publish-contributors:
// 503 when CONTENT_API_KEY is unset, 401 on missing Bearer header, 403 on
// wrong key, with timing-safe comparison.
//
// Accepts `{ slug, rules: AllRuleRow[] }` and REPLACE-per-slug:
// DELETEs all TutorialValidationRules rows for that tutorial then INSERTs
// the new set atomically inside cds.tx(). Publishing slug A never touches
// slug B's rows.

import cds from '@sap/cds'
import { hashValidationRules } from './sidecar-hash.js'

const NS = 'com.sap.developers.ims'

// Chunk sizes match content-publish-session.js conventions.
const DELETE_IN_CHUNK = 500
const INSERT_CHUNK = 50

/** Map validation-rule sidecar rows → DB entries for one tutorial. */
function ruleEntries(tutorialId, rules) {
  return (rules || []).map((r) => ({
    tutorial_ID: tutorialId,
    stepNumber: r.stepNumber,
    questionId: String(r.questionId).slice(0, 100),
    questionText: (r.questionText || '').slice(0, 2000),
    ruleType: (r.ruleType || '').slice(0, 50),
    questionType: (r.questionType || '').slice(0, 20),
    choiceMode: r.choiceMode || null,
    options: r.options || null,
    correctAnswer: r.correctAnswer ?? null,
    aiGrading: Boolean(r.aiGrading),
  }))
}

/**
 * Core, unit-testable: REPLACE all validation-rule rows for one slug.
 * @param {object} db   – connected CDS db service (cds.connect.to('db'))
 * @param {string} slug – tutorial slug (case-insensitive)
 * @param {Array}  rules – array of rule objects from the sidecar JSON
 */
export async function replaceValidationRulesForSlug(db, slug, rules) {
  const { Tutorials, TutorialValidationRules } = cds.entities(NS)
  const lcSlug = String(slug || '').toLowerCase()
  const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug }))
  if (!tut) return { ok: false, reason: 'tutorial_not_found', slug: lcSlug }

  const entries = ruleEntries(tut.ID, rules)

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialValidationRules).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
}

/**
 * Bulk REPLACE for many slugs in one call (#2463). Same shape/contract as
 * replaceContributorsBulk: chunked slug→ID resolve, single cds.tx wrapping
 * chunked DELETE-IN + chunked INSERT, notFound slugs reported and skipped.
 *
 * @param {object} db
 * @param {Array<{slug:string, rules:Array}>} items
 * @returns {Promise<{ok:true, replaced:number, notFound:string[]}>}
 */
export async function replaceValidationRulesBulk(db, items) {
  const { Tutorials, TutorialValidationRules } = cds.entities(NS)
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: true, replaced: 0, notFound: [] }

  const bySlug = new Map()
  for (const it of list) {
    if (!it || !it.slug) continue
    bySlug.set(String(it.slug).toLowerCase(), it.rules || [])
  }
  const slugs = [...bySlug.keys()]

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
    for (const e of ruleEntries(id, bySlug.get(slug))) allEntries.push(e)
  }

  await cds.tx(async (tx) => {
    for (let i = 0; i < foundIds.length; i += DELETE_IN_CHUNK) {
      const chunk = foundIds.slice(i, i + DELETE_IN_CHUNK)
      await tx.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: { in: chunk } }))
    }
    for (let i = 0; i < allEntries.length; i += INSERT_CHUNK) {
      const batch = allEntries.slice(i, i + INSERT_CHUNK)
      if (batch.length) await tx.run(INSERT.into(TutorialValidationRules).entries(batch))
    }
  })

  return { ok: true, replaced: idBySlug.size, notFound }
}

/**
 * Compute the canonical {slug: hash} map over ALL stored validation-rule rows
 * (#2464). Grouped by slug and hashed with the shared helper so it matches the
 * client's hash of the sidecar JSON.
 */
export async function validationRuleHashesBySlug(db) {
  const { TutorialValidationRules } = cds.entities(NS)
  const rows = await db.run(
    SELECT.from(TutorialValidationRules).columns(
      'tutorial.slug as slug', 'stepNumber', 'questionId', 'questionText',
      'ruleType', 'questionType', 'choiceMode', 'options', 'correctAnswer', 'aiGrading'
    )
  )
  const bySlug = new Map()
  for (const r of rows) {
    if (!r.slug) continue
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, [])
    bySlug.get(r.slug).push(r)
  }
  const out = {}
  for (const [slug, list] of bySlug) out[slug] = hashValidationRules(list)
  return out
}

/**
 * Express handler mirroring the publish-contributors route shape.
 * Mounted in server.js with contentAuthMiddleware + express.json().
 */
export async function publishValidationRules(req, res) {
  try {
    const { slug, rules } = req.body || {}
    if (!slug || !Array.isArray(rules)) {
      return res.status(400).json({ error: 'bad_request', detail: 'expected { slug, rules[] }' })
    }

    // entity_not_in_model guard (QA namespace safety — mirrors contributors-publish.js).
    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialValidationRules) {
      return res.status(409).json({ error: 'entity_not_in_model' })
    }

    const db = await cds.connect.to('db')
    const result = await replaceValidationRulesForSlug(db, slug, rules)
    if (!result.ok) return res.status(404).json(result)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: e?.message })
  }
}

/**
 * Bulk handler for POST /content/publish-validation-rules-bulk (#2463).
 * Accepts `{ items: [{ slug, rules[] }] }`.
 */
export async function publishValidationRulesBulk(req, res) {
  try {
    const { items } = req.body || {}
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'bad_request', detail: 'expected { items: [{ slug, rules[] }] }' })
    }

    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialValidationRules) {
      return res.status(409).json({ error: 'entity_not_in_model' })
    }

    const db = await cds.connect.to('db')
    const result = await replaceValidationRulesBulk(db, items)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: e?.message })
  }
}

/**
 * Hash-feed handler for GET /content/validation-rule-hashes (#2464).
 * Public-read; fails SOFT to `{}` on QA-absent entity or any fault.
 */
export async function validationRuleHashesHandler(_req, res) {
  try {
    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialValidationRules) {
      res.set('Cache-Control', 'no-cache')
      return res.json({})
    }
    const db = await cds.connect.to('db')
    const map = await validationRuleHashesBySlug(db)
    res.set('Cache-Control', 'no-cache')
    return res.json(map)
  } catch {
    res.set('Cache-Control', 'no-cache')
    return res.json({})
  }
}
