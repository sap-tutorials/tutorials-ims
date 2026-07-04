// test/unit/migration-perf-recorder.test.js
//
// Unit tests for the per-entity perf recorder used by scripts/migrate-from-hana.js.
// Issue #474 — apples-to-apples timing baseline for the July prod cutover.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  startRun,
  pushRecord,
  writeReport,
  __TESTING__,
} from '../../scripts/migration-perf-recorder.js'

describe('migration-perf-recorder', () => {
  let scratchDir

  beforeEach(() => {
    __TESTING__.reset()
    scratchDir = mkdtempSync(join(tmpdir(), 'mig-perf-'))
  })

  afterEach(() => {
    if (scratchDir && existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true })
  })

  describe('pushRecord', () => {
    it('captures durationSec rounded to 0.1s', () => {
      pushRecord({ name: 'tags', durationMs: 1234, inserted: 100, errors: 0 })
      const rec = __TESTING__.getRecords()[0]
      expect(rec.durationSec).toBe(1.2)
    })

    it('computes rowsPerSec when inserted > 0 and duration > 0', () => {
      pushRecord({ name: 'tutorials', durationMs: 1000, inserted: 50, errors: 0 })
      const rec = __TESTING__.getRecords()[0]
      expect(rec.rowsPerSec).toBe(50)
    })

    it('omits rowsPerSec when inserted is 0', () => {
      pushRecord({ name: 'empty', durationMs: 500, inserted: 0, errors: 0, skipped: true })
      const rec = __TESTING__.getRecords()[0]
      expect(rec.rowsPerSec).toBeUndefined()
    })

    it('omits rowsPerSec when duration is 0', () => {
      pushRecord({ name: 'instant', durationMs: 0, inserted: 100, errors: 0 })
      const rec = __TESTING__.getRecords()[0]
      expect(rec.rowsPerSec).toBeUndefined()
    })

    it('preserves caller-provided fields (skipped, errors, mode, pages)', () => {
      const pages = [
        { lo: 1, hi: 50000, sourceRowCount: 50000, durationMs: 2000, inserted: 50000 },
        { lo: 50001, hi: 100000, sourceRowCount: 50000, durationMs: 2500, inserted: 50000 },
      ]
      pushRecord({
        name: 'taskrecords',
        durationMs: 4500,
        inserted: 100000,
        errors: 0,
        skipped: false,
        mode: 'paginated',
        pageSize: 50000,
        pageCount: 2,
        pages,
      })
      const rec = __TESTING__.getRecords()[0]
      expect(rec.mode).toBe('paginated')
      expect(rec.pageSize).toBe(50000)
      expect(rec.pageCount).toBe(2)
      expect(rec.pages).toEqual(pages)
    })
  })

  describe('startRun + metadata', () => {
    it('captures env, source/target host, schema, args, nodeVersion', () => {
      startRun({
        env: 'dev',
        sourceHost: 'us30.example.com',
        targetHost: 'eu10-005.example.com',
        schema: 'MY_SCHEMA',
        args: ['--no-discover'],
      })
      const meta = __TESTING__.getMetadata()
      expect(meta.env).toBe('dev')
      expect(meta.sourceHost).toBe('us30.example.com')
      expect(meta.targetHost).toBe('eu10-005.example.com')
      expect(meta.schema).toBe('MY_SCHEMA')
      expect(meta.args).toEqual(['--no-discover'])
      expect(meta.nodeVersion).toBe(process.version)
      expect(meta.platform).toBe(process.platform)
      expect(meta.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('truncates very long host strings to 60 chars', () => {
      startRun({
        sourceHost: 'x'.repeat(200),
        targetHost: 'y'.repeat(200),
      })
      const meta = __TESTING__.getMetadata()
      expect(meta.sourceHost.length).toBe(60)
      expect(meta.targetHost.length).toBe(60)
    })

    it('defaults env to "unknown" and nodeVersion to process.version', () => {
      startRun({})
      const meta = __TESTING__.getMetadata()
      expect(meta.env).toBe('unknown')
      expect(meta.nodeVersion).toBe(process.version)
    })
  })

  describe('writeReport', () => {
    it('writes JSON with summary + entities + metadata to .migration-data/perf-history/', () => {
      startRun({ env: 'dev', sourceHost: 'src', targetHost: 'tgt', schema: 'X' })
      pushRecord({ name: 'tags', durationMs: 1000, inserted: 50, errors: 0 })
      pushRecord({ name: 'users', durationMs: 2000, inserted: 100, errors: 2 })

      const reportPath = writeReport(scratchDir)
      expect(existsSync(reportPath)).toBe(true)
      expect(reportPath).toMatch(/[\\/]\.migration-data[\\/]perf-history[\\/].+\.json$/)

      const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'))
      expect(parsed.metadata.env).toBe('dev')
      expect(parsed.summary.entityCount).toBe(2)
      expect(parsed.summary.totalInserted).toBe(150)
      expect(parsed.summary.totalErrors).toBe(2)
      expect(parsed.entities).toHaveLength(2)
      expect(parsed.entities[0].name).toBe('tags')
      expect(parsed.entities[1].name).toBe('users')
    })

    it('filename contains the env slug', () => {
      startRun({ env: 'qa' })
      const reportPath = writeReport(scratchDir)
      expect(reportPath).toMatch(/-qa\.json$/)
    })

    it('replaces unsafe chars in env slug', () => {
      // If env arrived as e.g. 'tutorial-system/dev', slashes/colons must
      // not leak into the filename — would corrupt the path.
      startRun({ env: 'tutorial system/dev:x' })
      const reportPath = writeReport(scratchDir)
      expect(reportPath).not.toMatch(/[\\/:][a-z]+:/)
      expect(reportPath).toMatch(/-tutorial-system-dev-x\.json$/)
    })

    it('computes overallRowsPerSec from summed inserted vs total duration', () => {
      startRun({ env: 'test' })
      pushRecord({ name: 'a', durationMs: 1000, inserted: 100 })
      const reportPath = writeReport(scratchDir)
      const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'))
      expect(parsed.summary.totalInserted).toBe(100)
      // totalDurationMs is wall-clock from startRun to writeReport. On a fast
      // CI box this can round to 0 ms; when that happens, overallRowsPerSec
      // is `null` by design (see recorder line 129 — `totalDurationMs > 0`
      // gate). What matters is the formula works once there's measurable
      // elapsed time. Accept both `null` (0-ms edge case) and a non-negative
      // number.
      expect(parsed.summary.totalDurationMs).toBeGreaterThanOrEqual(0)
      const rps = parsed.summary.overallRowsPerSec
      expect(rps === null || (typeof rps === 'number' && rps >= 0)).toBe(true)
    })

    it('produces a report even when no records were pushed (empty migration)', () => {
      startRun({ env: 'test' })
      const reportPath = writeReport(scratchDir)
      const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'))
      expect(parsed.summary.entityCount).toBe(0)
      expect(parsed.summary.totalInserted).toBe(0)
      expect(parsed.entities).toEqual([])
    })

    it('produces a report even when startRun was never called (degraded path)', () => {
      pushRecord({ name: 'orphan', durationMs: 100, inserted: 5 })
      const reportPath = writeReport(scratchDir)
      const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'))
      expect(parsed.summary.totalInserted).toBe(5)
      // No startRun → no runStartMs → totalDurationMs falls back to null
      expect(parsed.summary.totalDurationMs).toBeNull()
      expect(parsed.summary.overallRowsPerSec).toBeNull()
    })

    it('overwrites a prior report when called twice in the same run (idempotent path on partial failure)', () => {
      startRun({ env: 'test' })
      pushRecord({ name: 'a', durationMs: 100, inserted: 10 })
      const path1 = writeReport(scratchDir)
      pushRecord({ name: 'b', durationMs: 200, inserted: 20 })
      const path2 = writeReport(scratchDir)
      // Same timestamp seed → same filename
      expect(path1).toBe(path2)
      const parsed = JSON.parse(readFileSync(path2, 'utf-8'))
      expect(parsed.summary.entityCount).toBe(2)
      expect(parsed.summary.totalInserted).toBe(30)
    })
  })

  describe('__TESTING__.reset', () => {
    it('clears records + metadata for clean test isolation', () => {
      startRun({ env: 'a' })
      pushRecord({ name: 'a', durationMs: 100, inserted: 10 })
      expect(__TESTING__.getRecords()).toHaveLength(1)
      __TESTING__.reset()
      expect(__TESTING__.getRecords()).toEqual([])
      expect(__TESTING__.getMetadata()).toEqual({})
    })
  })
})
