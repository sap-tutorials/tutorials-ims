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

const NS = 'com.sap.developers.ims'

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

  const entries = (rules || []).map((r) => ({
    tutorial_ID: tut.ID,
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

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialValidationRules).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
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
