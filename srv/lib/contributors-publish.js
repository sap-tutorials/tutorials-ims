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

const NS = 'com.sap.developers.ims'

export function githubProfileUrl(login) {
  return login ? `https://github.com/${login}` : null
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

  const entries = (contributors || [])
    .filter((c) => c && (c.login || c.name || c.email))
    .slice(0, 10)
    .map((c) => ({
      ID: cds.utils.uuid(),
      tutorial_ID: tut.ID,
      login: (c.login || '').slice(0, 255),
      name: (c.name || '').slice(0, 255),
      email: (c.email || '').slice(0, 255),
      avatarUrl: (c.avatarUrl || '').slice(0, 1024),
      profileUrl: githubProfileUrl(c.login),
    }))

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialContributors).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialContributors).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
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
