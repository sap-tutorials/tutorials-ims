// srv/lib/variables-publish.js
// Persist tutorial variable declarations to HANA.
//
// Called from the content publish session (appendToSession → upsertTutorialVariables)
// with the per-tutorial `variables` array produced by the parser. The write is a
// REPLACE-per-slug: DELETE all existing rows for the tutorial, then INSERT the new
// set atomically inside cds.tx(). This mirrors replaceContributorsForSlug exactly.
//
// HANA reserved-word safety: column names avoid name/type/required/key/value/
// default/order — see TutorialVariables entity definition in db/schema.cds.

import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

// Chunk sizes mirror contributors-publish.js conventions.
const INSERT_CHUNK = 50

/** Map a TutorialVariable object → one DB row for TutorialVariables. */
function variableEntry(tutorialId, v, index) {
  return {
    ID: cds.utils.uuid(),
    tutorial_ID: tutorialId,
    varName: String(v.name || '').slice(0, 100),
    varLabel: String(v.label || '').slice(0, 255),
    varType: String(v.type || '').slice(0, 20),
    maxLength: typeof v.maxLength === 'number' ? v.maxLength : null,
    isRequired: typeof v.required === 'boolean' ? v.required : null,
    placeholder: v.placeholder ? String(v.placeholder).slice(0, 255) : null,
    defaultFrom: v.default?.from ? String(v.default.from).slice(0, 50) : null,
    defaultPattern: v.default?.pattern ? String(v.default.pattern).slice(0, 500) : null,
    configJson: JSON.stringify(v),
    sortOrder: index,
  }
}

/**
 * Core, unit-testable: REPLACE all variable rows for one slug.
 * @param {object} db   – connected CDS db service
 * @param {string} slug – tutorial slug (case-insensitive)
 * @param {Array}  variables – array of TutorialVariable objects from the parser
 * @returns {Promise<{ok, slug, count}|{ok:false, reason, slug}>}
 */
export async function replaceVariablesForSlug(db, slug, variables) {
  const { Tutorials, TutorialVariables } = cds.entities(NS)
  const lcSlug = String(slug || '').toLowerCase()
  const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug }))
  if (!tut) return { ok: false, reason: 'tutorial_not_found', slug: lcSlug }

  const entries = (variables || []).map((v, i) => variableEntry(tut.ID, v, i))

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialVariables).where({ tutorial_ID: tut.ID }))
    for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
      const batch = entries.slice(i, i + INSERT_CHUNK)
      if (batch.length) await tx.run(INSERT.into(TutorialVariables).entries(batch))
    }
  })

  return { ok: true, slug: lcSlug, count: entries.length }
}

/**
 * Session-level helper: upsert variables for all slugs in a metadata map.
 * Called from appendToSession after upsertTutorialMetadata. Best-effort:
 * errors are logged and swallowed so a variable write failure never fails
 * the content publish. Slugs without a `variables` key are skipped.
 *
 * @param {string} namespace – CDS namespace (prod or QA)
 * @param {object} metadata  – { [slug]: { variables?: TutorialVariable[], ... } }
 */
export async function upsertTutorialVariables(namespace, metadata) {
  const { Tutorials, TutorialVariables } = cds.entities(namespace)
  const db = await cds.connect.to('db')
  let count = 0

  for (const [rawSlug, meta] of Object.entries(metadata)) {
    if (!Array.isArray(meta.variables)) continue

    const slug = rawSlug.toLowerCase()
    try {
      const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug }))
      if (!tut) continue

      const entries = meta.variables.map((v, i) => variableEntry(tut.ID, v, i))

      await cds.tx(async (tx) => {
        await tx.run(DELETE.from(TutorialVariables).where({ tutorial_ID: tut.ID }))
        for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
          const batch = entries.slice(i, i + INSERT_CHUNK)
          if (batch.length) await tx.run(INSERT.into(TutorialVariables).entries(batch))
        }
      })
      count++
    } catch (err) {
      console.warn(`[content/publish] variables upsert failed for ${slug}:`, err.message)
    }
  }

  if (count > 0) {
    console.log(`[content/publish] Upserted variables for ${count} tutorial(s)`)
  }
}
