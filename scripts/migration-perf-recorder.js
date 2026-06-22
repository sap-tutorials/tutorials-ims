/**
 * Migration performance recorder
 *
 * Captures per-entity wall-clock timing for the migrate-from-hana.js run
 * so we can compare apples-to-apples across runs and decide which of the
 * #474 optimizations to invest in (cf run-task, BATCH_SIZE bump, parallelize).
 *
 * Pure observer: no hot-path side effects. Each entity record is appended
 * to an in-memory array; `writeReport()` dumps the array to
 * .migration-data/perf-history/<timestamp>-<env>.json at the end of main().
 *
 * Per-paginated-entity, page-level timings get attached too so we can see
 * whether throughput degrades at the tail (e.g., target MERGE INTO cost
 * rising as the table grows).
 *
 * Issue #474. Lands ahead of #474's actual perf changes so tomorrow's
 * re-migration produces the baseline data we'll measure the changes against.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const records = []
let runStartMs = null
let metadata = {}

/** Called once at the start of main(). */
export function startRun({ env, sourceHost, targetHost, schema, nodeVersion, args } = {}) {
  runStartMs = Date.now()
  metadata = {
    startedAt: new Date().toISOString(),
    env: env || 'unknown',
    sourceHost: sourceHost ? sourceHost.slice(0, 60) : null,
    targetHost: targetHost ? targetHost.slice(0, 60) : null,
    schema: schema || null,
    nodeVersion: nodeVersion || process.version,
    platform: process.platform,
    args: args || null,
  }
}

/**
 * Wrap a single entity's work. The fn must return the same shape
 * migrateEntity returns (`{ name, count, errors?, skipped? }`).
 */
export async function recordEntity(name, fn, extra = {}) {
  const startMs = Date.now()
  let result
  let threw = null
  try {
    result = await fn()
  } catch (e) {
    threw = e
  }
  const durationMs = Date.now() - startMs
  const r = {
    name,
    durationMs,
    durationSec: Math.round(durationMs / 100) / 10,
    inserted: result?.count ?? 0,
    errors: result?.errors ?? 0,
    skipped: result?.skipped === true,
    threw: threw ? threw.message.split('\n')[0].slice(0, 200) : null,
    ...extra,
  }
  if (r.inserted > 0 && r.durationMs > 0) {
    r.rowsPerSec = Math.round((r.inserted / r.durationMs) * 1000)
  }
  records.push(r)
  if (threw) throw threw  // preserve original error semantics
  return result
}

/**
 * Append a pre-built record. Used by callers (like the migrator) that want
 * to record timing without wrapping their call site in a closure — they
 * track startMs themselves and pass the final record shape directly.
 */
export function pushRecord(record) {
  const durationMs = record.durationMs ?? 0
  const r = {
    durationSec: Math.round(durationMs / 100) / 10,
    ...record,
  }
  if (r.inserted > 0 && r.durationMs > 0) {
    r.rowsPerSec = Math.round((r.inserted / r.durationMs) * 1000)
  }
  records.push(r)
  return r
}

/**
 * Append a page-level timing inside a paginated entity. Call once per
 * page from inside migrateEntityPaginated. The page record gets attached
 * to the most-recently-pushed entity record.
 */
export function recordPage({ pageIndex, sourceRowCount, durationMs }) {
  const last = records[records.length - 1]
  if (!last) return
  last.pages ||= []
  last.pages.push({
    pageIndex,
    sourceRowCount,
    durationMs,
    rowsPerSec: durationMs > 0 ? Math.round((sourceRowCount / durationMs) * 1000) : 0,
  })
}

/**
 * Write the JSON report to .migration-data/perf-history/<timestamp>-<env>.json.
 * Called once at the end of main(). Idempotent on consecutive calls; later
 * calls overwrite the same path so partial-failure runs still leave a trace.
 *
 * Returns the absolute report path so the caller can log it.
 */
export function writeReport(rootDir = process.cwd()) {
  const dir = join(rootDir, '.migration-data', 'perf-history')
  mkdirSync(dir, { recursive: true })

  const runEndMs = Date.now()
  const totalDurationMs = runStartMs ? runEndMs - runStartMs : null
  const stamp = (metadata.startedAt || new Date().toISOString()).replace(/[:.]/g, '-')
  const envSlug = (metadata.env || 'unknown').replace(/[^a-z0-9-]/gi, '-')
  const filename = `${stamp}-${envSlug}.json`
  const fullPath = join(dir, filename)

  const totalInserted = records.reduce((s, r) => s + (r.inserted || 0), 0)
  const totalErrors = records.reduce((s, r) => s + (r.errors || 0), 0)
  const overallRowsPerSec = totalDurationMs > 0
    ? Math.round((totalInserted / totalDurationMs) * 1000)
    : null

  const report = {
    metadata,
    summary: {
      finishedAt: new Date(runEndMs).toISOString(),
      totalDurationMs,
      totalDurationSec: totalDurationMs ? Math.round(totalDurationMs / 100) / 10 : null,
      totalDurationMin: totalDurationMs ? Math.round(totalDurationMs / 6000) / 10 : null,
      totalInserted,
      totalErrors,
      overallRowsPerSec,
      entityCount: records.length,
    },
    entities: records,
  }

  writeFileSync(fullPath, JSON.stringify(report, null, 2), 'utf-8')
  return fullPath
}

/** Test-only helpers — reset state between unit tests. */
export const __TESTING__ = {
  reset() {
    records.length = 0
    runStartMs = null
    metadata = {}
  },
  getRecords() {
    return records.slice()
  },
  getMetadata() {
    return { ...metadata }
  },
}
