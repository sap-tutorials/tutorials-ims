#!/usr/bin/env node
// srv/scripts/concept-alias-backfill.js
//
// One-shot backfill of ConceptAliases via SAP Generative AI Hub (#1046).
//
// Usage:
//   cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js [flags]
//
// Flags:
//   --limit N          Process at most N concepts (default: unlimited)
//   --dry-run          Print planned inserts, write nothing
//   --only-slug <s>    Target a single concept by slug
//   --force            Re-run against concepts that already have aliases
//
// Telemetry: one tab-separated line per concept to stderr:
//   <slug>\t<aliases_written>\t<skipped_duplicates>\t<latency_ms>
//   (appended with "dry-run" or "skipped-existing" where applicable)
//
// Exports:
//   runBackfill(opts) — named export for testability (Task 10).

import cds from '@sap/cds'
import { OrchestrationClient } from '@sap-ai-sdk/orchestration'
import { resolveChatLlmSettings } from '../lib/chat-settings-resolver.js'

const MAX_ALIASES_PER_CONCEPT = 8
const MIN_ALIAS_LEN = 2
const MAX_ALIAS_LEN = 40
const MAX_CONSECUTIVE_FAILURES = 3
const LLM_MAX_TOKENS = 256
const LLM_TEMPERATURE = 0.0

const SYSTEM_PROMPT = `You extract common short synonyms and acronyms for a technical concept.
Return a JSON object shaped {"aliases": ["..."]} with 0 to 8 short forms
that a developer might type in a search box. Rules:
- Only real, in-use aliases. No invented shortenings.
- 2 to 40 characters each. No punctuation-only strings.
- Drop the canonical name itself. Drop pluralization variants.
- Prefer classical SAP shorthand: "IDoc" (not "Intermediate Document"),
  "MTA" (not "Multi-Target Application"), "S/4HANA" (not "SAP S/4HANA").
- If nothing fits, return {"aliases": []}. Do not guess.`

/**
 * Parse the LLM plain-text response into a validated alias list.
 * @param {string} raw
 * @returns {string[]}
 */
function parseAliases(raw) {
  try {
    const obj = JSON.parse(raw)
    if (!obj || !Array.isArray(obj.aliases)) return []
    return obj.aliases
      .filter(a => typeof a === 'string')
      .map(a => a.trim())
      .filter(a => a.length >= MIN_ALIAS_LEN && a.length <= MAX_ALIAS_LEN)
      .slice(0, MAX_ALIASES_PER_CONCEPT)
  } catch { return [] }
}

/**
 * Core backfill logic. Exported for testability.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]    - Print planned inserts, write nothing.
 * @param {boolean} [opts.force=false]     - Re-process concepts that already have aliases.
 * @param {string}  [opts.onlySlug]        - Target a single concept by slug.
 * @param {number}  [opts.limit]           - Cap the number of concepts processed.
 */
export async function runBackfill({ dryRun = false, force = false, onlySlug, limit } = {}) {
  // In CLI mode the script sets up cds manually; in test mode cds is already
  // booted by the test harness. Detect whether we have an entity registry yet.
  if (typeof cds.entities !== 'function' || !cds.model) {
    process.env.cds_requires_auth_kind = 'mocked'
    const csn = await cds.load('*')
    cds.model = cds.compile.for.nodejs(csn)
  }

  const db = await cds.connect.to('db')
  const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims')

  // Resolve model + deploymentId — throws when ChatSettings and env-var
  // fallbacks are both absent (surfaces missing AI Core config immediately).
  const { modelName, deploymentId } = await resolveChatLlmSettings()

  // Build the OrchestrationClient once for all concepts in this run.
  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: LLM_MAX_TOKENS,
            temperature: LLM_TEMPERATURE,
          },
        },
        prompt: {
          template: [{ role: 'system', content: SYSTEM_PROMPT }],
        },
      },
    },
    { deploymentId }
  )

  // Fetch target concepts.
  const filters = { publishedAt: { '!=': null }, status: 'ACTIVE' }
  if (onlySlug) filters.slug = onlySlug

  const concepts = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name', 'description').where(filters)
  )
  const targets = typeof limit === 'number' && limit > 0 ? concepts.slice(0, limit) : concepts

  process.stderr.write(
    `Backfill targets: ${targets.length} concept(s). dry-run=${dryRun} force=${force}\n`
  )

  let consecutiveFailures = 0

  // Sequential loop — no p-limit dependency. Keeps the AI Core request rate
  // low (one call per concept at a time) without adding a new npm dep.
  for (const c of targets) {
    const t0 = Date.now()

    // Skip if this concept already has aliases and --force not set.
    if (!force) {
      const existing = await db.run(SELECT.one.from(ConceptAliases).where({ concept_ID: c.ID }))
      if (existing) {
        process.stderr.write(`${c.slug}\t0\t0\tskipped-existing\n`)
        continue
      }
    }

    // Build the user prompt with concept metadata.
    const userPrompt = JSON.stringify({
      name: c.name || '',
      description: c.description || '',
    })

    // Call SAP Generative AI Hub.
    let raw
    try {
      const response = await client.chatCompletion({
        messagesHistory: [{ role: 'user', content: userPrompt }],
      })
      raw = response.getContent?.() ?? ''
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      process.stderr.write(`${c.slug}\t0\t0\terror:${err.message}\n`)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive AI Core failures`)
      }
      continue
    }

    const aliases = parseAliases(raw)
    if (aliases.length === 0) {
      process.stderr.write(`${c.slug}\t0\t0\t${Date.now() - t0}\n`)
      continue
    }

    // Dedupe within this LLM response by lowercased alias.
    const seen = new Set()
    const rows = []
    let skipped = 0
    for (const a of aliases) {
      const lower = a.toLowerCase()
      if (seen.has(lower)) { skipped++; continue }
      seen.add(lower)
      rows.push({ concept_ID: c.ID, alias: a, aliasLower: lower, source: 'LLM' })
    }

    if (dryRun) {
      process.stderr.write(`${c.slug}\t${rows.length}\t${skipped}\t${Date.now() - t0}\tdry-run\n`)
      continue
    }

    // INSERT one row at a time — @assert.unique.conceptAlias guards against
    // collision with existing ADMIN/SEED aliases (unique on concept + aliasLower).
    let written = 0
    for (const row of rows) {
      try {
        await db.run(INSERT.into(ConceptAliases).entries(row))
        written++
      } catch (err) {
        if (/unique|assert/i.test(err.message)) { skipped++ } else { throw err }
      }
    }
    process.stderr.write(`${c.slug}\t${written}\t${skipped}\t${Date.now() - t0}\n`)
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint — parse argv, call runBackfill.
// Only executes when this file is the main script (not when imported as a module).
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--dry-run')        args.set('dryRun', true)
    else if (a === '--force')     args.set('force', true)
    else if (a === '--limit')     args.set('limit', Number(process.argv[++i]))
    else if (a === '--only-slug') args.set('onlySlug', process.argv[++i])
    else {
      process.stderr.write(`Unknown flag: ${a}\n`)
      process.exit(2)
    }
  }
  runBackfill({
    dryRun:   args.get('dryRun'),
    force:    args.get('force'),
    limit:    args.get('limit'),
    onlySlug: args.get('onlySlug'),
  }).then(() => process.exit(0)).catch(err => {
    process.stderr.write(`Fatal: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
