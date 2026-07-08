#!/usr/bin/env node
// srv/scripts/concept-alias-backfill.js
//
// One-shot backfill of ConceptAliases via AI Core (#1046).
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

import cds from '@sap/cds'

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--dry-run')      args.set('dryRun', true)
  else if (a === '--force')   args.set('force', true)
  else if (a === '--limit')   args.set('limit', Number(process.argv[++i]))
  else if (a === '--only-slug') args.set('onlySlug', process.argv[++i])
  else {
    process.stderr.write(`Unknown flag: ${a}\n`)
    process.exit(2)
  }
}

async function main() {
  process.env.cds_requires_auth_kind = 'mocked'
  const csn = await cds.load('*')
  cds.model = cds.compile.for.nodejs(csn)
  const db = await cds.connect.to('db')
  const { Concepts, ConceptAliases, TutorialConceptLinks, Tutorials } = cds.entities('com.sap.developers.ims')

  const filters = { publishedAt: { '!=': null }, status: 'ACTIVE' }
  if (args.get('onlySlug')) filters.slug = args.get('onlySlug')

  const concepts = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name', 'description').where(filters)
  )
  const cap = args.get('limit')
  const targets = typeof cap === 'number' && cap > 0 ? concepts.slice(0, cap) : concepts

  process.stderr.write(`Backfill targets: ${targets.length} concept(s). dry-run=${!!args.get('dryRun')} force=${!!args.get('force')}\n`)

  for (const c of targets) {
    const t0 = Date.now()
    // Skip if this concept already has aliases and --force not set
    if (!args.get('force')) {
      const existing = await db.run(SELECT.one.from(ConceptAliases).where({ concept_ID: c.ID }))
      if (existing) {
        process.stderr.write(`${c.slug}\t0\t0\tskipped-existing\n`)
        continue
      }
    }

    // STUB — Task 10 replaces this with the real LLM call.
    const aliases = []

    if (args.get('dryRun')) {
      process.stderr.write(`${c.slug}\t${aliases.length}\t0\t${Date.now() - t0}\tdry-run\n`)
      continue
    }

    // Real inserts land in Task 10 too. For now nothing to write when aliases=[].
    process.stderr.write(`${c.slug}\t0\t0\t${Date.now() - t0}\n`)
  }
}

main().then(() => process.exit(0)).catch(err => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`)
  process.exit(1)
})
