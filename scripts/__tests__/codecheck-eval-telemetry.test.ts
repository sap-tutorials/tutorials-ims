// scripts/__tests__/codecheck-eval-telemetry.test.ts
// Unit tests for scripts/lib/codecheck-eval/telemetry.js (issue #319).
// Validates the SQL split + shape merge — the live HANA execution path is
// verified separately via cds bind --exec.

import { describe, it, expect } from 'vitest';
import { buildQueries, shapeResults, formatMarkdown } from '../lib/codecheck-eval/telemetry.js'

describe('buildQueries (#319)', () => {
  it('returns the expected query keys (latency split into MinMax + Percentiles)', () => {
    const q = buildQueries('2026-06-13T00:00:00Z')
    const keys = Object.keys(q).sort()
    expect(keys).toEqual([
      'errors',
      'latencyMinMax',
      'latencyPercentiles',
      'perStepCoverage',
      'tokens',
      'verdictDistribution',
    ])
  })

  it('latencyMinMax is a single-statement aggregate (no PERCENTILE_CONT)', () => {
    const q = buildQueries('2026-06-13T00:00:00Z')
    expect(q.latencyMinMax.sql).toContain('MIN(latencyMs)')
    expect(q.latencyMinMax.sql).toContain('MAX(latencyMs)')
    expect(q.latencyMinMax.sql).not.toContain('PERCENTILE_CONT')
  })

  it('latencyPercentiles uses HANA-correct PERCENTILE_CONT OVER () shape', () => {
    const q = buildQueries('2026-06-13T00:00:00Z')
    // The whole point of #319: each PERCENTILE_CONT must end with OVER ().
    // Without OVER (), HANA rejects the statement with "invalid column name"
    // when MIN/MAX is in the same SELECT.
    const sql = q.latencyPercentiles.sql
    expect(sql).toContain('PERCENTILE_CONT(0.50)')
    expect(sql).toContain('PERCENTILE_CONT(0.95)')
    expect(sql).toContain('PERCENTILE_CONT(0.99)')
    // Each percentile invocation must be followed by an OVER () clause.
    const occurrences = sql.match(/PERCENTILE_CONT\([^)]+\) WITHIN GROUP \([^)]+\) OVER \(\)/g) ?? []
    expect(occurrences.length).toBe(3)
  })

  it('latencyPercentiles uses SELECT TOP 1 to keep a single result row', () => {
    const q = buildQueries('2026-06-13T00:00:00Z')
    expect(q.latencyPercentiles.sql).toMatch(/SELECT\s+TOP\s+1/)
  })

  it('passes sinceIso through to params in both latency queries', () => {
    const q = buildQueries('2026-06-13T08:30:00Z')
    expect(q.latencyMinMax.params).toEqual(['2026-06-13T08:30:00Z'])
    expect(q.latencyPercentiles.params).toEqual(['2026-06-13T08:30:00Z'])
  })
})

describe('shapeResults (#319)', () => {
  it('merges latencyMinMax + latencyPercentiles into one latency block', () => {
    const raw = {
      verdictDistribution: [],
      latencyMinMax: [{ P_MIN: 100, P_MAX: 12000 }],
      latencyPercentiles: [{ P50: 8000, P95: 9800, P99: 11000 }],
      tokens: [],
      errors: [],
      perStepCoverage: [],
    }
    const out = shapeResults(raw, '2026-06-13T00:00:00Z')
    expect(out.latency).toEqual({
      p_min: 100,
      p50: 8000,
      p95: 9800,
      p99: 11000,
      p_max: 12000,
    })
  })

  it('lowercase column names also merge correctly (CAP path)', () => {
    const raw = {
      verdictDistribution: [],
      latencyMinMax: [{ p_min: 50, p_max: 5000 }],
      latencyPercentiles: [{ p50: 2000, p95: 4000, p99: 4500 }],
      tokens: [],
      errors: [],
      perStepCoverage: [],
    }
    const out = shapeResults(raw, '2026-06-13T00:00:00Z')
    expect(out.latency.p_min).toBe(50)
    expect(out.latency.p50).toBe(2000)
    expect(out.latency.p_max).toBe(5000)
  })

  it('legacy single-query latency shape still works (backwards compat)', () => {
    // If a caller still uses the old combined-query approach, shapeResults
    // should still parse it. The split-query path is what the script uses
    // post-#319, but the helper accepts both.
    const raw = {
      verdictDistribution: [],
      latency: [{ P_MIN: 100, P50: 8000, P95: 9800, P99: 11000, P_MAX: 12000 }],
      tokens: [],
      errors: [],
      perStepCoverage: [],
    }
    const out = shapeResults(raw, '2026-06-13T00:00:00Z')
    expect(out.latency.p_min).toBe(100)
    expect(out.latency.p50).toBe(8000)
    expect(out.latency.p_max).toBe(12000)
  })

  it('handles empty raw results without crashing', () => {
    const out = shapeResults({}, '2026-06-13T00:00:00Z')
    expect(out.latency).toEqual({
      p_min: null, p50: null, p95: null, p99: null, p_max: null,
    })
    expect(out.verdictDistribution).toEqual([])
    expect(out.tokens.n_with_tokens).toBe(0)
  })
})

describe('formatMarkdown (#319)', () => {
  it('renders a complete markdown report including latency line', () => {
    const out = shapeResults({
      verdictDistribution: [{ VERDICT: 'pass', N: 30 }, { VERDICT: 'fail', N: 5 }],
      latencyMinMax: [{ P_MIN: 100, P_MAX: 12000 }],
      latencyPercentiles: [{ P50: 8000, P95: 9800, P99: 11000 }],
      tokens: [{ AVG_PROMPT: 2792, AVG_COMPLETION: 251, TOTAL_TOKENS: 277000, N_WITH_TOKENS: 90 }],
      errors: [],
      perStepCoverage: [],
    }, '2026-06-13T00:00:00Z')
    const md = formatMarkdown(out)
    expect(md).toContain('p50: 8000')
    expect(md).toContain('p95: 9800')
    expect(md).toContain('p_min: 100')
    expect(md).toContain('p_max: 12000')
    expect(md).toContain('avg_prompt: 2792')
    expect(md).toContain('| pass | 30 |')
  })
})
