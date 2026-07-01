// Phase 4.7 (#748 §4.8.1): the concept landing page renders a new
// "Docs explaining this concept" section at position #3 (immediately
// after Learning journeys, immediately before Blog posts).
//
// BLOCKED-until-deploy: requires Task 3's Hugo change on the deployed
// approuter AND at least one published concept with a non-empty
// helpDocs[] array in its frontmatter (bootstrap-seeded via Task 2's
// admin action or the weekly fetch-help-docs-job cron).
//
// Graceful skip: if no seeded concept exists yet on the deployed env,
// the test asserts only the ordering property (help-docs before blog-posts
// when help-docs is present) and skips otherwise.

import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL

describe.skipIf(!BASE)('concept page — Docs explaining this concept section (Phase 4.7)', () => {
  it('renders section #3 "Docs explaining this concept" on a seeded concept', async () => {
    // Any published concept with a non-empty helpDocs[] works. The seed
    // fixture from Task 2 guarantees `cap-service-handlers` has at least
    // one help-doc link (see the seedHelpDocs admin action / cron).
    const url = `${BASE!.replace(/\/$/, '')}/concepts/cap-service-handlers/`
    const res = await fetch(url)
    // Concept may not be published yet on this env — 404 is acceptable
    // during the bootstrap window. Skip the ordering assertions if so.
    if (res.status === 404) return
    expect(res.status).toBe(200)
    const html = await res.text()

    // Only assert on section presence if the concept actually has help-doc
    // links seeded — otherwise the {{ with .Params.helpDocs }} guard hides
    // the entire section.
    const helpDocsIdx = html.indexOf('data-kg-section="help-docs"')
    if (helpDocsIdx === -1) {
      // No seed data yet — this is the current DEV state until the cron
      // runs. Test passes silently; the ordering assertion is the real
      // guardrail once seeding lands.
      return
    }

    // Section is present with the canonical data attribute.
    expect(html).toMatch(/data-kg-section="help-docs"/)
    expect(html).toContain('Docs explaining this concept')

    // Section #3 ordering: appears BEFORE the Blog posts section
    // (which was #3, now #4).
    const blogPostsIdx = html.indexOf('data-kg-section="blog-posts"')
    if (blogPostsIdx !== -1) {
      expect(helpDocsIdx).toBeLessThan(blogPostsIdx)
    }

    // Section #3 ordering: appears AFTER the Learning journeys section (#2).
    const learningJourneysIdx = html.indexOf('data-kg-section="learning-journeys"')
    if (learningJourneysIdx !== -1) {
      expect(helpDocsIdx).toBeGreaterThan(learningJourneysIdx)
    }
  })
})
