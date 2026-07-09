// srv/lib/kg/joule-tool-find-path.js
//
// Joule chat tool: findLearningPath (Issue #445 Phase 2 Task 5)
//
// Exports:
//   FIND_LEARNING_PATH_TOOL — LLM-facing function descriptor
//   findLearningPathHandler — dispatch handler for chat-orchestrator
//
// Wire-up to the orchestrator + CDS service is Task 6/7.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md

import { SparqlTimeoutError } from '../kg-sparql-client.js'
import { findPath } from '../kg-path.js'
import { getConceptsForUser } from './concepts-for-user.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Canonical slug shape: lowercase alnum + hyphen, 1-80 chars.
// Must match the validation in kg-queries.js SLUG_RE and the KG_QUERY
// procedure's p1/p2 LIKE_REGEXPR pattern.
const SLUG_RE = /^[a-z0-9-]{1,80}$/

// Reason text per pathType arm
const PATH_TYPE_REASONS = {
  PREREQ: 'Prerequisite chain',
  CO_COMPLETED: 'Often completed together',
  SHARED_CONCEPT: 'Shares concepts',
}

// ---------------------------------------------------------------------------
// LLM-facing tool descriptor
// ---------------------------------------------------------------------------

export const FIND_LEARNING_PATH_TOOL = {
  type: 'function',
  function: {
    name: 'findLearningPath',
    description: [
      'Build an ordered sequence of SAP developer tutorials for the user to follow.',
      '',
      'Use this tool when the user asks how to LEARN a topic, asks what tutorial to do NEXT,',
      "or asks for a learning sequence/path/order toward a goal. Example prompts:",
      '  - "I want to build a CAP service with Fiori UI"',
      '  - "What should I learn after the CAP getting-started mission?"',
      '  - "Show me a path to HANA Cloud deployment"',
      '',
      'DO NOT use this tool when the user asks about the CURRENT tutorial they are reading',
      "(use getRelevantSteps for that — it answers questions about a tutorial's content).",
      'DO NOT use this tool when the user pastes code and asks for feedback (use checkCode).',
      '',
      'The tool returns a numbered ordered list of tutorial slugs with titles, estimated',
      'time, and a one-line reason per step. Render the list directly in your reply.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        toSlug: {
          type: 'string',
          description:
            'Slug of the tutorial the user wants to reach. Required. Lowercase + alphanumeric + hyphens (e.g. "hana-cloud-cap-create-project").',
        },
        fromSlug: {
          type: 'string',
          description:
            "Slug of the tutorial the user is starting from. Optional — if omitted, the user's most recently completed tutorial is used. If the user has no completion history, the search is unanchored and returns the strongest topical neighbors of toSlug.",
        },
      },
      required: ['toSlug'],
    },
  },
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object}       opts.db        - CDS db service handle
 * @param {object}       opts.args      - { toSlug, fromSlug? } from the LLM tool call
 * @param {object|null}  opts.user      - req.user; may be null/undefined for anonymous
 * @param {object|null}  opts.telemetry - { emit(event, payload) } shim; may be null/undefined
 * @returns {Promise<string>} rendered markdown for the LLM to paraphrase, or an error string
 */
export async function findLearningPathHandler({ db, args, user, telemetry }) {
  const toSlug = typeof args?.toSlug === 'string' ? args.toSlug.trim() : ''
  const rawFromSlug = typeof args?.fromSlug === 'string' ? args.fromSlug.trim() : ''

  // Step 1: Validate toSlug
  if (!SLUG_RE.test(toSlug)) {
    return `That tutorial slug doesn't look right — try one like \`hana-cloud-cap-create-project\`. (toSlug got: ${args?.toSlug})`
  }

  // Step 2: Validate fromSlug if provided
  if (rawFromSlug && !SLUG_RE.test(rawFromSlug)) {
    return `That tutorial slug doesn't look right — try one like \`hana-cloud-cap-create-project\`. (fromSlug got: ${args?.fromSlug})`
  }

  // Step 3: Resolve effective fromSlug
  let effectiveFromSlug
  let fromSlugInferred = false
  let unanchored = false

  if (rawFromSlug) {
    // Caller provided a valid fromSlug
    effectiveFromSlug = rawFromSlug
    fromSlugInferred = false
  } else if (user?.id) {
    // Try to infer from most-recently-completed TaskRecord. The CAP
    // TaskRecords entity uses (taskLegacyId, taskType) instead of a
    // direct FK to Tutorials — join taskLegacyId → Tutorials.legacyId
    // and filter taskType='TUTORIAL'.
    const rows = await db.run(
      `SELECT TOP 1 t.SLUG FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS r
       JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.LEGACYID = r.TASKLEGACYID
       WHERE r.USER_ID = ? AND r.TASKTYPE = 'TUTORIAL' AND r.STATUS IN ('COMPLETED', 'SUPERSEDED')
       ORDER BY r.COMPLETIONDATE DESC NULLS LAST`,
      [user.id]
    )
    if (rows && rows.length > 0 && rows[0].SLUG) {
      effectiveFromSlug = rows[0].SLUG.toLowerCase()
      fromSlugInferred = true
    } else {
      // No completion history — unanchored mode
      effectiveFromSlug = toSlug
      unanchored = true
    }
  } else {
    // Anonymous or no user — unanchored mode
    effectiveFromSlug = toSlug
    unanchored = true
  }

  const hasUserId = !!user?.id

  // Step 4: Emit path_requested telemetry
  telemetry?.emit?.('kg.joule.path_requested', {
    fromSlug: effectiveFromSlug,
    toSlug,
    hasUserId,
    fromSlugInferred,
    unanchored,
  })

  // Step 5: Record t0
  const t0 = Date.now()

  // Step 6: Call findPath (extracted to srv/lib/kg-path.js — same module
  // used by GET /graph/path. The shared helper handles slug→IRI conversion,
  // kgQuery dispatch, and JSON parse; we keep telemetry + dedup + hydration
  // + markdown rendering here.)
  let rawCandidates
  try {
    rawCandidates = await findPath({ db, fromSlug: effectiveFromSlug, toSlug })
  } catch (err) {
    if (err instanceof SparqlTimeoutError || err?.name === 'SparqlTimeoutError') {
      telemetry?.emit?.('kg.joule.path_returned', {
        fromSlug: effectiveFromSlug,
        toSlug,
        error: 'timeout',
        latencyMs: Date.now() - t0,
      })
      return "I couldn't find a learning path right now — the query timed out. Please try a more specific target."
    }
    // SparqlSyntaxError or generic Error
    const errKind = err?.name === 'SparqlSyntaxError' ? 'syntax' : 'error'
    telemetry?.emit?.('kg.joule.path_returned', {
      fromSlug: effectiveFromSlug,
      toSlug,
      error: errKind,
      latencyMs: Date.now() - t0,
    })
    return 'Internal error finding a learning path — please try a more specific question.'
  }

  // Step 7: Count per-arm breakdown for telemetry (findPath returns the
  // already-parsed rows; we tally PathType for the path_returned event).
  const pathTypeBreakdown = { PREREQ: 0, CO_COMPLETED: 0, SHARED_CONCEPT: 0 }
  for (const c of rawCandidates) {
    if (c.pathType in pathTypeBreakdown) {
      pathTypeBreakdown[c.pathType]++
    }
  }

  if (rawCandidates.length === 0) {
    telemetry?.emit?.('kg.joule.path_returned', {
      fromSlug: effectiveFromSlug,
      toSlug,
      resultCount: 0,
      pathTypeBreakdown,
      latencyMs: Date.now() - t0,
      fromSlugInferred,
      exactTargetReached: false,
      unanchored,
    })
    return `I couldn't find a path from \`${effectiveFromSlug}\` to \`${toSlug}\`. Try a broader target or browse the catalog at https://developers.sap.com/tutorial-navigator.html.`
  }

  // Step 8: Dedup by slug — prefer lowest pathTypeRank
  const sorted = [...rawCandidates].sort((a, b) => a.pathTypeRank - b.pathTypeRank)
  const seen = new Set()
  const deduped = []
  for (const c of sorted) {
    if (!seen.has(c.slug)) {
      seen.add(c.slug)
      deduped.push(c)
    }
  }

  // Step 9: Promote exactTargetReached — move toSlug to position 0 if present
  const targetIdx = deduped.findIndex(c => c.slug === toSlug)
  let exactTargetReached = false
  if (targetIdx > 0) {
    const [target] = deduped.splice(targetIdx, 1)
    deduped.unshift(target)
    exactTargetReached = true
  } else if (targetIdx === 0) {
    exactTargetReached = true
  }

  // Step 10: User-coverage filter (only when user.id is present)
  let filtered = deduped
  if (user?.id) {
    let coverage
    try {
      coverage = await getConceptsForUser({ db, userId: user.id })
    } catch {
      // getConceptsForUser validates userId strictly; if it fails, skip filtering
      coverage = { learned: [], partial: [], truncatedAt500: false }
    }

    if (coverage.learned.length > 0) {
      // Fetch concept links for all candidate slugs in one query
      const slugs = deduped.map(c => c.slug)
      const placeholders = slugs.map(() => '?').join(',')
      const linkRows = await db.run(
        `SELECT t.SLUG, c.SLUG AS CONCEPT_SLUG
         FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS t
         JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS l ON l.TUTORIAL_ID = t.ID
         JOIN COM_SAP_DEVELOPERS_IMS_CONCEPTS c ON c.ID = l.CONCEPT_ID
         WHERE t.SLUG IN (${placeholders})`,
        slugs
      )

      // Build slug -> [concept slugs] map
      const slugConcepts = new Map()
      for (const row of linkRows || []) {
        const s = row.SLUG
        if (!slugConcepts.has(s)) slugConcepts.set(s, [])
        slugConcepts.get(s).push(row.CONCEPT_SLUG)
      }

      const learnedSet = new Set(coverage.learned)

      filtered = deduped.filter(c => {
        // toSlug is NEVER dropped
        if (c.slug === toSlug) return true
        const concepts = slugConcepts.get(c.slug) || []
        // Only drop if the tutorial has concepts AND all of them are learned
        if (concepts.length === 0) return true
        return !concepts.every(concept => learnedSet.has(concept))
      })
    }
  }

  // Step 11: Hydrate with title + estimated time
  if (filtered.length === 0) {
    // All candidates were filtered out
    telemetry?.emit?.('kg.joule.path_returned', {
      fromSlug: effectiveFromSlug,
      toSlug,
      resultCount: 0,
      pathTypeBreakdown,
      latencyMs: Date.now() - t0,
      fromSlugInferred,
      exactTargetReached,
      unanchored,
    })
    return `I couldn't find a path from \`${effectiveFromSlug}\` to \`${toSlug}\`. Try a broader target or browse the catalog at https://developers.sap.com/tutorial-navigator.html.`
  }

  const hydrateSlugPlaceholders = filtered.map(() => '?').join(',')
  const tutorialRows = await db.run(
    `SELECT SLUG, TITLE, ESTIMATEDTIMEMINUTES
     FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
     WHERE SLUG IN (${hydrateSlugPlaceholders})`,
    filtered.map(c => c.slug)
  )

  const tutorialMeta = new Map()
  for (const row of tutorialRows || []) {
    tutorialMeta.set(row.SLUG, { title: row.TITLE, minutes: row.ESTIMATEDTIMEMINUTES })
  }

  // Drop candidates not found in Tutorials (orphan slugs from stale graph)
  const hydrated = filtered
    .map(c => {
      const meta = tutorialMeta.get(c.slug)
      if (!meta) return null
      return { ...c, title: meta.title, minutes: meta.minutes }
    })
    .filter(Boolean)

  if (hydrated.length === 0) {
    telemetry?.emit?.('kg.joule.path_returned', {
      fromSlug: effectiveFromSlug,
      toSlug,
      resultCount: 0,
      pathTypeBreakdown,
      latencyMs: Date.now() - t0,
      fromSlugInferred,
      exactTargetReached,
      unanchored,
    })
    return `I couldn't find a path from \`${effectiveFromSlug}\` to \`${toSlug}\`. Try a broader target or browse the catalog at https://developers.sap.com/tutorial-navigator.html.`
  }

  // Step 13: Emit path_returned telemetry
  telemetry?.emit?.('kg.joule.path_returned', {
    fromSlug: effectiveFromSlug,
    toSlug,
    resultCount: hydrated.length,
    pathTypeBreakdown,
    latencyMs: Date.now() - t0,
    fromSlugInferred,
    exactTargetReached,
    unanchored,
  })

  // Step 14: Render markdown
  const lines = [`Here's a path from \`${effectiveFromSlug}\` to \`${toSlug}\`:\n`]
  for (let i = 0; i < hydrated.length; i++) {
    const { slug, title, minutes, pathType } = hydrated[i]
    const reason = PATH_TYPE_REASONS[pathType] ?? pathType
    const url = `https://developers.sap.com/tutorials/${slug}.html`
    lines.push(`${i + 1}. **${title}** — [${slug}](${url})`)
    lines.push(`   ~${minutes ?? '?'} min · ${reason}`)
  }

  return lines.join('\n')
}
